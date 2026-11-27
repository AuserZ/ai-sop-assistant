import { and, count, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import {
  lockCurrentAdmin,
  requireCurrentAccount,
  requireRole,
  type CurrentAccount,
} from "../auth/authorization";
import { AuthFailure, authErrorResponse } from "../auth/errors";
import { authLimits, consumeRateLimit, type AuthDatabase } from "../auth/rate-limit";
import { getDatabase } from "../db/client";
import { sopDocuments, workflowJobs } from "../db/schema";
import { logEvent, resolveTraceId } from "./logger";
import { snapshotOperationalMetrics, type OperationalMetricsSnapshot } from "./metrics";

export const openPolicyGates = [
  "retention_policy_unapproved",
  "backup_expiry_unapproved",
  "admin_mfa_unapproved",
  "vps_and_concurrency_sizing_provisional",
  "real_data_processing_approval_open",
] as const;

export type OperationalHealthSnapshot = {
  status: "ok" | "degraded";
  checkedAt: string;
  traceId: string;
  database: {
    ok: boolean;
    pgvectorOk: boolean;
    latencyMs: number;
  };
  queues: {
    workflowJobs: Record<string, number>;
    staleLeases: number;
    documentsByStatus: Record<string, number>;
    deletionCleanupPending: number;
    deletionCleanupFailed: number;
  };
  process: {
    nodeVersion: string;
    uptimeSeconds: number;
    memoryRssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  metrics: OperationalMetricsSnapshot;
  policyGatesOpen: readonly string[];
};

const defaultWorkflowJobCounts = (): Record<string, number> => ({
  QUEUED: 0,
  RUNNING: 0,
  COMPLETED: 0,
  FAILED: 0,
  WAITING_FOR_PIPELINE: 0,
});

const defaultDocumentStatusCounts = (): Record<string, number> => ({
  UPLOADED: 0,
  PROCESSING: 0,
  PENDING_VERIFICATION: 0,
  ACTIVE: 0,
  REJECTED: 0,
  FAILED: 0,
  DELETED: 0,
});

export async function collectOperationalHealth(
  actor: CurrentAccount,
  traceId: string,
  database: AuthDatabase = getDatabase(),
): Promise<OperationalHealthSnapshot> {
  const dbStart = performance.now();
  const dbMetrics = await database.transaction(async (transaction) => {
    await lockCurrentAdmin(actor, transaction);

    const jobStateRows = await transaction
      .select({ state: workflowJobs.state, total: count() })
      .from(workflowJobs)
      .groupBy(workflowJobs.state);

    const [staleLeaseRow] = await transaction
      .select({ total: count() })
      .from(workflowJobs)
      .where(
        or(
          and(
            eq(workflowJobs.state, "QUEUED"),
            isNotNull(workflowJobs.dispatchLeaseUntil),
            lte(workflowJobs.dispatchLeaseUntil, sql`clock_timestamp()`),
          ),
          and(
            eq(workflowJobs.state, "RUNNING"),
            isNotNull(workflowJobs.runLeaseUntil),
            lte(workflowJobs.runLeaseUntil, sql`clock_timestamp()`),
          ),
        ),
      );

    const documentStatusRows = await transaction
      .select({ status: sopDocuments.status, total: count() })
      .from(sopDocuments)
      .groupBy(sopDocuments.status);

    const [cleanupPendingRow] = await transaction
      .select({ total: count() })
      .from(sopDocuments)
      .where(
        and(
          eq(sopDocuments.status, "DELETED"),
          inArray(sopDocuments.cleanupState, ["PENDING", "RUNNING"]),
        ),
      );

    const [cleanupFailedRow] = await transaction
      .select({ total: count() })
      .from(sopDocuments)
      .where(and(eq(sopDocuments.status, "DELETED"), eq(sopDocuments.cleanupState, "FAILED")));

    const workflowJobsByState = defaultWorkflowJobCounts();
    for (const row of jobStateRows) {
      workflowJobsByState[row.state] = Number(row.total);
    }

    const documentsByStatus = defaultDocumentStatusCounts();
    for (const row of documentStatusRows) {
      documentsByStatus[row.status] = Number(row.total);
    }

    return {
      workflowJobs: workflowJobsByState,
      staleLeases: Number(staleLeaseRow?.total ?? 0),
      documentsByStatus,
      deletionCleanupPending: Number(cleanupPendingRow?.total ?? 0),
      deletionCleanupFailed: Number(cleanupFailedRow?.total ?? 0),
    };
  });

  // Probe pgvector outside the metrics transaction so a vector extension error does not abort it.
  let pgvectorOk = true;
  try {
    await database.execute(sql`select '[1,0]'::public.vector <-> '[0,1]'::public.vector`);
  } catch {
    pgvectorOk = false;
  }

  const latencyMs = Number(Math.max(0, performance.now() - dbStart).toFixed(2));
  const metrics = snapshotOperationalMetrics();
  const status: "ok" | "degraded" =
    pgvectorOk && dbMetrics.staleLeases === 0 && dbMetrics.deletionCleanupFailed === 0
      ? "ok"
      : "degraded";

  logEvent("info", "ops.health_checked", {
    traceId,
    status,
    latencyMs,
    staleLeases: dbMetrics.staleLeases,
    deletionCleanupFailed: dbMetrics.deletionCleanupFailed,
  });

  return {
    status,
    checkedAt: new Date().toISOString(),
    traceId,
    database: {
      ok: true,
      pgvectorOk,
      latencyMs,
    },
    queues: {
      workflowJobs: dbMetrics.workflowJobs,
      staleLeases: dbMetrics.staleLeases,
      documentsByStatus: dbMetrics.documentsByStatus,
      deletionCleanupPending: dbMetrics.deletionCleanupPending,
      deletionCleanupFailed: dbMetrics.deletionCleanupFailed,
    },
    process: {
      nodeVersion: process.version,
      uptimeSeconds: metrics.process.uptimeSeconds,
      memoryRssBytes: metrics.process.memoryRssBytes,
      heapUsedBytes: metrics.process.heapUsedBytes,
      heapTotalBytes: metrics.process.heapTotalBytes,
    },
    metrics,
    policyGatesOpen: [...openPolicyGates],
  };
}

export async function handleOperationalHealthRequest(
  request: Request,
  options: {
    database?: AuthDatabase;
    requireAccountImpl?: typeof requireCurrentAccount;
  } = {},
): Promise<Response> {
  const traceId = resolveTraceId(request);
  try {
    const database = options.database ?? getDatabase();
    const resolveAccount = options.requireAccountImpl ?? requireCurrentAccount;
    const actor = await resolveAccount(request.headers, database);
    requireRole(actor, "ADMIN");
    await consumeRateLimit("ops:health", actor.id, authLimits.opsHealth, database);

    const snapshot = await collectOperationalHealth(actor, traceId, database);
    return Response.json(snapshot, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": traceId,
      },
    });
  } catch (error) {
    if (!(error instanceof AuthFailure)) {
      logEvent("error", "ops.health_failed", {
        traceId,
        errorCode: "SERVICE_UNAVAILABLE",
      });
    }
    const response = authErrorResponse(error);
    response.headers.set("X-Request-Id", traceId);
    return response;
  }
}
