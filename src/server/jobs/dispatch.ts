import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { workflowJobs } from "../db/schema";
import { appendEvent, type JobDatabase } from "./service";
import { workflowBounds, workflowVersion } from "./contracts";
import { workflowDispatchUrl, workflowDispatcherEnabled } from "./config";
import { signDispatch } from "./signatures";

export async function reconcileJobs(database: JobDatabase = getDatabase()) {
  await database.transaction(async (transaction) => {
    const abandoned = await transaction.select().from(workflowJobs).where(and(
      or(eq(workflowJobs.state, "QUEUED"), eq(workflowJobs.state, "RUNNING")),
      or(lte(workflowJobs.attemptDeadline, sql`clock_timestamp()`), and(eq(workflowJobs.state, "RUNNING"), lte(workflowJobs.runLeaseUntil, sql`clock_timestamp()`))),
    )).limit(workflowBounds.dispatchBatch).for("update", { skipLocked: true });
    for (const job of abandoned) {
      if (job.attemptNumber >= workflowBounds.maximumAttempts) {
        await transaction.update(workflowJobs).set({ state: "FAILED" }).where(eq(workflowJobs.id, job.id));
        await appendEvent(transaction, job, "failed", 8);
      } else {
        await appendEvent(transaction, job, "retrying", 7);
        await transaction.update(workflowJobs).set({
          state: "QUEUED", attemptId: randomUUID(), attemptNumber: job.attemptNumber + 1, dispatchNonce: randomUUID(),
          dispatchCount: 0, dispatchNextAt: sql`clock_timestamp() + interval '1 second'`, dispatchLeaseToken: null,
          dispatchLeaseUntil: null, dispatchAcceptedAt: null, executionId: null, runLeaseUntil: null, step: 0,
          attemptDeadline: sql`clock_timestamp() + ${workflowBounds.attemptMilliseconds} * interval '1 millisecond'`,
        }).where(eq(workflowJobs.id, job.id));
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
    void (async () => { await reconcileJobs(); await dispatchJobs(undefined, undefined, undefined, undefined, controller.signal); })()
      .catch(() => undefined).finally(() => { running = false; });
  }, 1000);
  timer.unref();
  const stop = () => { controller.abort(); clearInterval(timer); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
