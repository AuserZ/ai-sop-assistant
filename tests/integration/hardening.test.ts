import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET as getLiveRoute } from "../../src/app/api/health/live/route";
import { GET as getOpsHealthRoute } from "../../src/app/api/health/ops/route";
import { GET as getReadyRoute } from "../../src/app/api/health/ready/route";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { authConfiguration } from "../../src/server/auth/config";
import { handleAuthentication } from "../../src/server/auth/handler";
import { authLimits, consumeRateLimit } from "../../src/server/auth/rate-limit";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import { handleDocumentSourceRequest } from "../../src/server/documents/http";
import {
  deleteDocument,
  finalizeDocumentUpload,
  initializeDocumentUpload,
} from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
} from "../../src/server/ingestion/service";
import {
  ingestionWorkflowVersion,
  type IngestionCallbackClaims,
  type IngestionCallbackPurpose,
} from "../../src/server/jobs/contracts";
import { verifyDocument } from "../../src/server/verification/service";
import { seedSyntheticAccount, seedSyntheticSession, syntheticPassword } from "../fixtures/auth";
import { syntheticPdf } from "../fixtures/document-files";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });
const configuration = authConfiguration();

const workerEnv = {
  CONVERSION_URL: "http://convert-worker:8092",
  PADDLEOCR_URL: "http://paddleocr:8091",
  SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
  AUTH_BASE_URL: "http://127.0.0.1:3000",
};

const dispatchKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const canaryTitle = "S14_CANARY_SOP_TITLE_SECRET_9871";
const canaryPassage = "S14_CANARY_PASSAGE_121C_SECRET_4321";

const seededDocumentIds: string[] = [];
const seededRateLimitKeys: string[] = [];

let adminAccount: CurrentAccount;
let reviewerAdmin: CurrentAccount;
let deactivatedAdmin: CurrentAccount;
let staffAccount: CurrentAccount;
let activeDocumentId: string;

class MemoryStorage implements DocumentStorage {
  objects = new Map<string, StoredObject>();
  async authorizeUpload(object: { mimeType: string; sizeBytes: number; uploadExpiresAt: Date }) {
    return {
      url: "http://127.0.0.1/synthetic-only",
      method: "PUT" as const,
      headers: { "Content-Type": object.mimeType, "If-None-Match": "*" as const },
      sizeBytes: object.sizeBytes,
      expiresAt: object.uploadExpiresAt.toISOString(),
    };
  }
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
  async create(key: string, object: StoredObject) {
    if (this.objects.has(key)) throw new Error("PreconditionFailed");
    this.objects.set(key, { bytes: Buffer.from(object.bytes), contentType: object.contentType });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function rateLimitKey(operation: string, identity: string): string {
  return createHmac("sha256", configuration.secret)
    .update(`${operation}:${identity}`)
    .digest("hex");
}

function makeAuthRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  return new Request(`${configuration.baseURL}${path}`, {
    method,
    headers: {
      host: new URL(configuration.baseURL).host,
      origin: configuration.baseURL,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

function extractCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signInCookies(email: string): Promise<string> {
  const response = await handleAuthentication(
    makeAuthRequest("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: syntheticPassword },
    }),
  );
  expect(response.status).toBe(200);
  return extractCookies(response);
}

function makeIngestionClaims(
  job: typeof schema.workflowJobs.$inferSelect,
  purpose: IngestionCallbackPurpose,
  executionId: string,
  jti?: string,
): IngestionCallbackClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    workflow: ingestionWorkflowVersion,
    jobId: job.id,
    documentId: job.documentId!,
    sourceSha256: job.sourceSha256!,
    pipelineVersion: job.pipelineVersion!,
    attemptId: job.attemptId,
    attemptNumber: job.attemptNumber,
    dispatchNonce: job.dispatchNonce,
    jti: jti ?? `${job.attemptId}:${executionId}:${purpose}:${randomUUID().slice(0, 8)}`,
    iat: now,
    nbf: now,
    exp: now + 30,
    iss: "sop-n8n",
    aud: "sop-app",
    purpose,
    method: "POST",
    path: `/api/internal/ingestion/${job.id}/${purpose}`,
    executionId,
  };
}

async function seedUploadedJob(storage: MemoryStorage, title: string) {
  const bytes = syntheticPdf();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const initialized = await initializeDocumentUpload(
    adminAccount,
    {
      requestKey: randomUUID(),
      title,
      fileName: "s14-hardening-sop.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256,
    },
    database,
    storage,
  );
  const documentId = initialized.document.id;
  seededDocumentIds.push(documentId);

  const [intent] = await database
    .select()
    .from(schema.documentUploadIntents)
    .where(eq(schema.documentUploadIntents.id, documentId));
  await storage.create(intent.stagingKey, { bytes, contentType: "application/pdf" });
  await finalizeDocumentUpload(adminAccount, documentId, database, storage);

  // Defer background dispatcher pickup and mark one synthetic dispatch so callbacks are valid.
  await database
    .update(schema.workflowJobs)
    .set({
      dispatchCount: 1,
      dispatchNextAt: sql`clock_timestamp() + interval '60 seconds'`,
      dispatchAcceptedAt: sql`clock_timestamp()`,
    })
    .where(eq(schema.workflowJobs.documentId, documentId));

  const [job] = await database
    .select()
    .from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.documentId, documentId));

  return { documentId, job };
}

beforeAll(async () => {
  const adminUser = await seedSyntheticAccount(
    database,
    "ADMIN",
    `s14-admin-canary-${randomUUID()}@example.invalid`,
  );
  const reviewerUser = await seedSyntheticAccount(
    database,
    "ADMIN",
    `s14-reviewer-canary-${randomUUID()}@example.invalid`,
  );
  const deactivatedUser = await seedSyntheticAccount(
    database,
    "ADMIN",
    `s14-deactivated-canary-${randomUUID()}@example.invalid`,
  );
  const staffUser = await seedSyntheticAccount(
    database,
    "STAFF",
    `s14-staff-canary-${randomUUID()}@example.invalid`,
  );

  adminAccount = await seedSyntheticSession(database, adminUser);
  reviewerAdmin = await seedSyntheticSession(database, reviewerUser);
  deactivatedAdmin = await seedSyntheticSession(database, deactivatedUser);
  staffAccount = await seedSyntheticSession(database, staffUser);

  const storage = new MemoryStorage();
  const { documentId, job } = await seedUploadedJob(storage, canaryTitle);
  activeDocumentId = documentId;

  const executionId = "exec-s14-active";
  const claimed = await claimIngestionStage(makeIngestionClaims(job, "claim", executionId), {
    database,
    privateKey: dispatchKeys.privateKey,
  });

  const workerFetch = vi.fn<typeof fetch>(async () =>
    Response.json({
      result: "PASS",
      pageCount: 1,
      pages: [
        {
          pageIndex: 1,
          nativeText: `Section 1 Controls\n1. ${canaryPassage} at 121.0 C for 20 minutes.`,
          imageCount: 0,
          maxImagePixels: 0,
        },
      ],
    }),
  );

  await extractIngestionStage(
    makeIngestionClaims(job, "extract", executionId),
    claimed.fileRefToken,
    {
      database,
      storage,
      fetchImpl: workerFetch,
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    },
  );
  await chunkIngestionStage(makeIngestionClaims(job, "chunk", executionId), { database });
  await embedIngestionStage(makeIngestionClaims(job, "embed", executionId), {
    database,
    env: workerEnv,
  });
  await completeIngestionStage(makeIngestionClaims(job, "complete", executionId), { database });

  const [pendingDoc] = await database
    .select()
    .from(schema.sopDocuments)
    .where(eq(schema.sopDocuments.id, documentId));

  await verifyDocument(
    reviewerAdmin,
    documentId,
    {
      decision: "APPROVE",
      expectedSha256: pendingDoc.sha256,
      expectedJobId: job.id,
      expectedPipelineVersion: pendingDoc.processedPipelineVersion!,
      expectedAttemptId: pendingDoc.processedAttemptId!,
      explicitConfirmation: true,
      notes: "Synthetic approval for S14 operational health test.",
    },
    database,
  );
});

afterAll(async () => {
  for (const documentId of seededDocumentIds) {
    await deleteDocument(adminAccount, documentId, database).catch(() => undefined);
    await database
      .delete(schema.sopChunks)
      .where(eq(schema.sopChunks.documentId, documentId))
      .catch(() => undefined);
    await database
      .delete(schema.sopExtractionPages)
      .where(eq(schema.sopExtractionPages.documentId, documentId))
      .catch(() => undefined);
    await database
      .delete(schema.sopVerificationIssues)
      .where(eq(schema.sopVerificationIssues.documentId, documentId))
      .catch(() => undefined);
  }
  if (seededRateLimitKeys.length > 0) {
    await database
      .delete(schema.authRateLimits)
      .where(inArray(schema.authRateLimits.key, seededRateLimitKeys))
      .catch(() => undefined);
  }
  await connection.end();
});

describe("S14 operational health endpoint, rate-limit hardening, and nonce replay protection", () => {
  it("enforces Admin-only RBAC, active account checks, trace headers, and zero SOP/PII leaks on GET /api/health/ops", async () => {
    const adminCookie = await signInCookies(adminAccount.email);
    const staffCookie = await signInCookies(staffAccount.email);
    const deactivatedCookie = await signInCookies(deactivatedAdmin.email);

    await database
      .update(schema.authUsers)
      .set({ active: false })
      .where(eq(schema.authUsers.id, deactivatedAdmin.id));

    seededRateLimitKeys.push(
      rateLimitKey("ops:health", adminAccount.id),
      rateLimitKey("sign-in-global", "all"),
      rateLimitKey("sign-in-email", adminAccount.email),
      rateLimitKey("sign-in-email", staffAccount.email),
      rateLimitKey("sign-in-email", deactivatedAdmin.email),
    );

    const liveResponse = getLiveRoute(
      makeAuthRequest("/api/health/live", { headers: { "X-Request-Id": "trace-live-s14" } }),
    );
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.headers.get("x-request-id")).toBe("trace-live-s14");
    expect(liveResponse.headers.get("cache-control")).toBe("no-store");

    const readyResponse = await getReadyRoute(
      makeAuthRequest("/api/health/ready", { headers: { "X-Request-Id": "trace-ready-s14" } }),
    );
    expect(readyResponse.status).toBe(200);
    expect(readyResponse.headers.get("x-request-id")).toBe("trace-ready-s14");
    expect(readyResponse.headers.get("cache-control")).toBe("no-store");

    const anonResponse = await getOpsHealthRoute(makeAuthRequest("/api/health/ops"));
    expect(anonResponse.status).toBe(401);
    expect(anonResponse.headers.get("cache-control")).toBe("no-store");
    expect(anonResponse.headers.get("x-request-id")).toBeTruthy();

    const staffResponse = await getOpsHealthRoute(
      makeAuthRequest("/api/health/ops", { cookie: staffCookie }),
    );
    expect(staffResponse.status).toBe(403);

    const deactivatedResponse = await getOpsHealthRoute(
      makeAuthRequest("/api/health/ops", { cookie: deactivatedCookie }),
    );
    expect(deactivatedResponse.status).toBe(401);

    const opsResponse = await getOpsHealthRoute(
      makeAuthRequest("/api/health/ops", {
        cookie: adminCookie,
        headers: { "X-Request-Id": "trace-ops-s14-01" },
      }),
    );
    expect(opsResponse.status).toBe(200);
    expect(opsResponse.headers.get("cache-control")).toBe("no-store");
    expect(opsResponse.headers.get("x-request-id")).toBe("trace-ops-s14-01");

    const body = (await opsResponse.json()) as {
      status: string;
      traceId: string;
      database: { ok: boolean; pgvectorOk: boolean; latencyMs: number };
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
      metrics: { stages: Record<string, unknown>; ocr: unknown; providers: unknown };
      policyGatesOpen: string[];
    };

    expect(["ok", "degraded"]).toContain(body.status);
    expect(body.traceId).toBe("trace-ops-s14-01");
    expect(body.database.ok).toBe(true);
    expect(body.database.pgvectorOk).toBe(true);
    expect(body.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.queues.documentsByStatus.ACTIVE).toBeGreaterThanOrEqual(1);
    expect(body.process.nodeVersion).toBe(process.version);
    expect(body.process.heapTotalBytes).toBeGreaterThan(0);
    expect(body.policyGatesOpen).toContain("retention_policy_unapproved");
    expect(body.metrics.ocr).toBeDefined();
    expect(body.metrics.providers).toBeDefined();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(canaryTitle);
    expect(serialized).not.toContain(canaryPassage);
    expect(serialized).not.toContain(adminAccount.email);
    expect(serialized).not.toContain(staffAccount.email);
    expect(serialized).not.toContain("s14-admin-canary");
  });

  it("enforces durable source-token rate limiting returning 429 RATE_LIMITED with Retry-After", async () => {
    const staffCookie = await signInCookies(staffAccount.email);
    const sourceLimitKey = rateLimitKey("document-source", staffAccount.id);
    const globalLimitKey = rateLimitKey("document-global", "all");
    seededRateLimitKeys.push(sourceLimitKey, globalLimitKey);

    // Pre-fill the durable per-account source counter to the exact ceiling, then invoke the route.
    for (let attempt = 0; attempt < authLimits.documentSource.maximum; attempt++) {
      await consumeRateLimit(
        "document-source",
        staffAccount.id,
        authLimits.documentSource,
        database,
      );
    }

    const throttled = await handleDocumentSourceRequest(
      makeAuthRequest(`/api/documents/${activeDocumentId}/source`, { cookie: staffCookie }),
      activeDocumentId,
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("60");
    expect(await throttled.json()).toEqual({ error: { code: "RATE_LIMITED" } });
  });

  it("rejects replayed workflow callback nonces via app.workflow_nonce_receipts", async () => {
    const storage = new MemoryStorage();
    const { job } = await seedUploadedJob(storage, "S14 Nonce Replay SOP");
    const fixedJti = `s14-replay-jti-${randomUUID()}`;
    const claims = makeIngestionClaims(job, "claim", "exec-s14-replay", fixedJti);

    const first = await claimIngestionStage(claims, {
      database,
      privateKey: dispatchKeys.privateKey,
    });
    expect(first.accepted).toBe(true);

    await expect(
      claimIngestionStage(claims, {
        database,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_REPLAY", status: 409 });
  });
});
