import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { auditEvents, sopDocuments, workflowJobs } from "../db/schema";
import { appendEvent, type JobDatabase } from "./service";
import { ingestionBounds, ingestionWorkflowVersion, workflowBounds, workflowVersion } from "./contracts";
import {
  ingestionDispatchEnabled,
  ingestionDispatchUrl,
  workflowDispatchUrl,
  workflowDispatcherEnabled,
  workflowProbeEnabled,
} from "./config";
import { signDispatch } from "./signatures";

export async function reconcileJobs(database: JobDatabase = getDatabase()) {
  await database.transaction(async (transaction) => {
    const abandoned = await transaction.select().from(workflowJobs).where(and(
      or(eq(workflowJobs.kind, "synthetic_probe"), eq(workflowJobs.kind, "document_ingestion")),
      or(eq(workflowJobs.state, "QUEUED"), eq(workflowJobs.state, "RUNNING")),
      or(lte(workflowJobs.attemptDeadline, sql`clock_timestamp()`), and(eq(workflowJobs.state, "RUNNING"), lte(workflowJobs.runLeaseUntil, sql`clock_timestamp()`))),
    )).limit(workflowBounds.dispatchBatch).for("update", { skipLocked: true });
    for (const job of abandoned) {
      const maximumAttempts = job.kind === "document_ingestion" ? ingestionBounds.maximumAttempts : workflowBounds.maximumAttempts;
      const attemptMilliseconds = job.kind === "document_ingestion" ? ingestionBounds.attemptMilliseconds : workflowBounds.attemptMilliseconds;
      if (job.attemptNumber >= maximumAttempts) {
        await transaction.update(workflowJobs).set({
          state: "FAILED",
          ...(job.kind === "document_ingestion" ? { errorCode: "INGESTION_TIMEOUT" } : {}),
          updatedAt: sql`clock_timestamp()`,
        }).where(eq(workflowJobs.id, job.id));
        await appendEvent(transaction, job, "failed", 8);
        if (job.kind === "document_ingestion" && job.documentId) {
          await transaction.update(sopDocuments).set({
            status: "FAILED",
            processingErrorCode: "INGESTION_TIMEOUT",
            updatedAt: sql`clock_timestamp()`,
          }).where(and(eq(sopDocuments.id, job.documentId), ne(sopDocuments.status, "ACTIVE")));
          await transaction.insert(auditEvents).values({
            actorId: job.ownerId,
            action: "document.ingestion_failed",
            targetId: job.documentId,
            outcome: "failed",
            metadata: { jobId: job.id, attemptNumber: job.attemptNumber, errorCode: "INGESTION_TIMEOUT" },
          });
        }
      } else {
        await appendEvent(transaction, job, "retrying", 7);
        await transaction.update(workflowJobs).set({
          state: "QUEUED",
          stage: null,
          errorCode: null,
          attemptId: randomUUID(),
          attemptNumber: job.attemptNumber + 1,
          dispatchNonce: randomUUID(),
          dispatchCount: 0,
          dispatchNextAt: sql`clock_timestamp() + interval '1 second'`,
          dispatchLeaseToken: null,
          dispatchLeaseUntil: null,
          dispatchAcceptedAt: null,
          executionId: null,
          runLeaseUntil: null,
          step: 0,
          attemptDeadline: sql`clock_timestamp() + ${attemptMilliseconds} * interval '1 millisecond'`,
          updatedAt: sql`clock_timestamp()`,
        }).where(eq(workflowJobs.id, job.id));
        if (job.kind === "document_ingestion" && job.documentId) {
          await transaction.update(sopDocuments).set({
            status: "UPLOADED",
            processingErrorCode: null,
            updatedAt: sql`clock_timestamp()`,
          }).where(and(eq(sopDocuments.id, job.documentId), ne(sopDocuments.status, "ACTIVE")));
        }
      }
    }
    await transaction.execute(sql`delete from app.workflow_nonce_receipts where id in (
      select id from app.workflow_nonce_receipts where expires_at < clock_timestamp() order by expires_at limit 100
    ) and expires_at < clock_timestamp()`);
  });
}

export async function dispatchJobs(database: JobDatabase = getDatabase(), send: typeof fetch = fetch,
  sign = signDispatch, destination = workflowDispatchUrl(), signal?: AbortSignal) {
  const jobs = await database.transaction(async (transaction) => {
    const due = await transaction.select().from(workflowJobs).where(and(
      eq(workflowJobs.kind, "synthetic_probe"),
      eq(workflowJobs.state, "QUEUED"), isNull(workflowJobs.dispatchAcceptedAt),
      lte(workflowJobs.dispatchNextAt, sql`clock_timestamp()`),
      sql`${workflowJobs.dispatchCount} < ${workflowBounds.maximumDispatches}`,
      sql`${workflowJobs.attemptDeadline} > clock_timestamp()`,
      or(isNull(workflowJobs.dispatchLeaseUntil), lte(workflowJobs.dispatchLeaseUntil, sql`clock_timestamp()`)),
    )).orderBy(asc(workflowJobs.dispatchNextAt)).limit(workflowBounds.dispatchBatch).for("update", { skipLocked: true });
    for (const job of due) {
      job.dispatchLeaseToken = randomUUID();
      job.dispatchCount++;
      await transaction.update(workflowJobs).set({
        dispatchLeaseToken: job.dispatchLeaseToken, dispatchCount: job.dispatchCount,
        dispatchLeaseUntil: sql`clock_timestamp() + ${workflowBounds.dispatchLeaseMilliseconds} * interval '1 millisecond'`,
      }).where(eq(workflowJobs.id, job.id));
    }
    return due;
  });
  await Promise.all(jobs.map(async (job) => {
    if (job.kind !== "synthetic_probe" || !job.scenario || !job.attemptDeadline) return;
    if (signal?.aborted) return;
    let accepted = false;
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await sign({
        v: 1, workflow: workflowVersion, purpose: "dispatch", iss: "sop-app", aud: "sop-n8n", method: "POST",
        path: "/webhook/sop-s03-probe-v1", jobId: job.id, attemptId: job.attemptId, attemptNumber: job.attemptNumber,
        dispatchNonce: job.dispatchNonce, scenario: job.scenario, jti: job.dispatchNonce,
        iat: now, nbf: now, exp: Math.min(now + workflowBounds.tokenSeconds, Math.floor(job.attemptDeadline.getTime() / 1000)),
      });
      const response = await send(destination, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(workflowBounds.fetchTimeoutMilliseconds)]) : AbortSignal.timeout(workflowBounds.fetchTimeoutMilliseconds),
      });
      accepted = response.ok;
      await response.body?.cancel();
    } catch { /* The committed lease makes interrupted delivery retryable. */ }
    await database.update(workflowJobs).set({
      ...(accepted ? { dispatchAcceptedAt: sql`clock_timestamp()` } : {}), dispatchLeaseToken: null, dispatchLeaseUntil: null,
      dispatchNextAt: sql`clock_timestamp() + ${Math.min(2 ** job.dispatchCount, 8)} * interval '1 second'`,
    }).where(and(eq(workflowJobs.id, job.id), eq(workflowJobs.attemptId, job.attemptId), eq(workflowJobs.dispatchLeaseToken, job.dispatchLeaseToken!)));
  }));
}

export async function dispatchIngestionJobs(database: JobDatabase = getDatabase(), send: typeof fetch = fetch,
  sign = signDispatch, destination = ingestionDispatchUrl(), signal?: AbortSignal) {
  const jobs = await database.transaction(async (transaction) => {
    const due = await transaction.select().from(workflowJobs).where(and(
      eq(workflowJobs.kind, "document_ingestion"),
      eq(workflowJobs.state, "QUEUED"), isNull(workflowJobs.dispatchAcceptedAt),
      lte(workflowJobs.dispatchNextAt, sql`clock_timestamp()`),
      sql`${workflowJobs.dispatchCount} < ${ingestionBounds.maximumDispatches}`,
      sql`${workflowJobs.attemptDeadline} > clock_timestamp()`,
      or(isNull(workflowJobs.dispatchLeaseUntil), lte(workflowJobs.dispatchLeaseUntil, sql`clock_timestamp()`)),
    )).orderBy(asc(workflowJobs.dispatchNextAt)).limit(workflowBounds.dispatchBatch).for("update", { skipLocked: true });
    for (const job of due) {
      job.dispatchLeaseToken = randomUUID();
      job.dispatchCount++;
      await transaction.update(workflowJobs).set({
        dispatchLeaseToken: job.dispatchLeaseToken, dispatchCount: job.dispatchCount,
        dispatchLeaseUntil: sql`clock_timestamp() + ${workflowBounds.dispatchLeaseMilliseconds} * interval '1 millisecond'`,
      }).where(eq(workflowJobs.id, job.id));
    }
    return due;
  });
  await Promise.all(jobs.map(async (job) => {
    if (job.kind !== "document_ingestion" || !job.documentId || !job.sourceSha256 || !job.pipelineVersion || !job.attemptDeadline) return;
    if (signal?.aborted) return;
    let accepted = false;
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await sign({
        v: 1, workflow: ingestionWorkflowVersion, purpose: "dispatch", iss: "sop-app", aud: "sop-n8n", method: "POST",
        path: "/webhook/sop-s05-ingestion-v1", jobId: job.id, documentId: job.documentId,
        sourceSha256: job.sourceSha256, pipelineVersion: job.pipelineVersion,
        attemptId: job.attemptId, attemptNumber: job.attemptNumber,
        dispatchNonce: job.dispatchNonce, jti: job.dispatchNonce,
        iat: now, nbf: now, exp: Math.min(now + ingestionBounds.callbackTokenSeconds, Math.floor(job.attemptDeadline.getTime() / 1000)),
      });
      const response = await send(destination, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(workflowBounds.fetchTimeoutMilliseconds)]) : AbortSignal.timeout(workflowBounds.fetchTimeoutMilliseconds),
      });
      accepted = response.ok;
      await response.body?.cancel();
    } catch { /* The committed lease makes interrupted delivery retryable. */ }
    await database.update(workflowJobs).set({
      ...(accepted ? { dispatchAcceptedAt: sql`clock_timestamp()` } : {}), dispatchLeaseToken: null, dispatchLeaseUntil: null,
      dispatchNextAt: sql`clock_timestamp() + ${Math.min(2 ** job.dispatchCount, 8)} * interval '1 second'`,
    }).where(and(eq(workflowJobs.id, job.id), eq(workflowJobs.attemptId, job.attemptId), eq(workflowJobs.dispatchLeaseToken, job.dispatchLeaseToken!)));
  }));
}

export function startWorkflowDispatcher() {
  if (!workflowDispatcherEnabled()) return;
  const registry = globalThis as typeof globalThis & { sopWorkflowDispatcher?: AbortController };
  if (registry.sopWorkflowDispatcher) return;
  const controller = new AbortController();
  registry.sopWorkflowDispatcher = controller;
  let running = false;
  const timer = setInterval(() => {
    if (running || controller.signal.aborted) return;
    running = true;
    void (async () => {
      await reconcileJobs();
      if (process.env.WORKFLOW_DISPATCH_ENABLED === "1" && workflowProbeEnabled()) {
        await dispatchJobs(undefined, undefined, undefined, undefined, controller.signal);
      }
      if (ingestionDispatchEnabled()) {
        await dispatchIngestionJobs(undefined, undefined, undefined, undefined, controller.signal);
      }
    })().catch(() => undefined).finally(() => { running = false; });
  }, 1000);
  timer.unref();
  const stop = () => { controller.abort(); clearInterval(timer); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
