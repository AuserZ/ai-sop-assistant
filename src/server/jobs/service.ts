import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { authSessions, authUsers, workflowEvents, workflowJobs, workflowNonceReceipts } from "../db/schema";
import { AuthFailure } from "../auth/errors";
import type { CurrentAccount } from "../auth/authorization";
import { probeInput, workflowBounds, type CallbackClaims } from "./contracts";

export type JobDatabase = ReturnType<typeof getDatabase>;
export type JobTransaction = Parameters<Parameters<JobDatabase["transaction"]>[0]>[0];
export type WorkflowJob = typeof workflowJobs.$inferSelect;
export type WorkflowEvent = typeof workflowEvents.$inferSelect;

export async function lockCurrentAccount(transaction: JobTransaction, account: CurrentAccount) {
  const [user] = await transaction.select({ active: authUsers.active }).from(authUsers).where(eq(authUsers.id, account.id)).for("share");
  if (!user?.active) throw new AuthFailure("UNAUTHENTICATED", 401);
  const [session] = await transaction.select({ id: authSessions.id }).from(authSessions).where(and(
    eq(authSessions.id, account.sessionId), eq(authSessions.userId, account.id), gt(authSessions.expiresAt, sql`clock_timestamp()`),
  )).for("share");
  if (!session) throw new AuthFailure("UNAUTHENTICATED", 401);
}

export async function appendEvent(transaction: JobTransaction, job: WorkflowJob, kind: WorkflowEvent["kind"], step: number) {
  const sequence = job.eventSequence + 1;
  await transaction.insert(workflowEvents).values({ jobId: job.id, attemptId: job.attemptId, sequence, step, kind });
  await transaction.update(workflowJobs).set({ eventSequence: sequence, updatedAt: sql`clock_timestamp()` }).where(eq(workflowJobs.id, job.id));
  job.eventSequence = sequence;
}

export async function createProbeJob(account: CurrentAccount, input: unknown, database: JobDatabase = getDatabase()) {
  const parsed = probeInput.safeParse(input);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  const inputHash = createHash("sha256").update(JSON.stringify({ scenario: parsed.data.scenario })).digest("hex");
  return database.transaction(async (transaction) => {
    await lockCurrentAccount(transaction, account);
    const [created] = await transaction.insert(workflowJobs).values({
      ownerId: account.id, requestKey: parsed.data.requestKey, inputHash, scenario: parsed.data.scenario,
      attemptId: randomUUID(), dispatchNonce: randomUUID(),
      attemptDeadline: sql`clock_timestamp() + ${workflowBounds.attemptMilliseconds} * interval '1 millisecond'`,
    }).onConflictDoNothing({ target: [workflowJobs.ownerId, workflowJobs.requestKey] }).returning();
    if (created) {
      await appendEvent(transaction, created, "accepted", 0);
      return { jobId: created.id, created: true };
    }
    const [existing] = await transaction.select().from(workflowJobs).where(and(
      eq(workflowJobs.ownerId, account.id), eq(workflowJobs.requestKey, parsed.data.requestKey),
    ));
    if (!existing || existing.inputHash !== inputHash) throw new AuthFailure("IDEMPOTENCY_CONFLICT", 409);
    return { jobId: existing.id, created: false };
  });
}

export async function applyWorkflowCallback(claims: CallbackClaims, database: JobDatabase = getDatabase()) {
  return database.transaction(async (transaction) => {
    const [job] = await transaction.select().from(workflowJobs).where(eq(workflowJobs.id, claims.jobId)).for("update");
    if (!job || job.attemptId !== claims.attemptId || job.attemptNumber !== claims.attemptNumber || job.dispatchNonce !== claims.dispatchNonce) {
      throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    }
    const [fresh] = await transaction.select({ id: workflowJobs.id }).from(workflowJobs).where(and(
      eq(workflowJobs.id, job.id), gt(workflowJobs.attemptDeadline, sql`clock_timestamp()`),
    ));
    if (!fresh || job.dispatchCount === 0) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    const [receipt] = await transaction.insert(workflowNonceReceipts).values({
      id: claims.jti, jobId: job.id, attemptId: job.attemptId, expiresAt: new Date((claims.exp + workflowBounds.clockToleranceSeconds) * 1000),
    }).onConflictDoNothing().returning({ id: workflowNonceReceipts.id });
    if (!receipt) throw new AuthFailure("WORKFLOW_REPLAY", 409);
    if (claims.purpose === "claim") {
      if (claims.step !== 1 || claims.outcome !== "pass") throw new AuthFailure("INVALID_WORKFLOW_EVENT", 400);
      if (job.executionId) {
        if (job.executionId !== claims.executionId) throw new AuthFailure("WORKFLOW_ALREADY_CLAIMED", 409);
        return { accepted: true, duplicate: true };
      }
      if (job.state !== "QUEUED") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);
      await transaction.update(workflowJobs).set({ state: "RUNNING", executionId: claims.executionId, step: 1,
        runLeaseUntil: sql`clock_timestamp() + ${workflowBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
      }).where(eq(workflowJobs.id, job.id));
      await appendEvent(transaction, job, "started", 1);
      return { accepted: true, duplicate: false };
    }
    if (job.executionId !== claims.executionId) throw new AuthFailure("INVALID_WORKFLOW_EXECUTION", 409);
    const expectedOutcome = claims.step === 3 && job.scenario === "validation_failure" ? "fail" : "pass";
    if (claims.outcome !== expectedOutcome) throw new AuthFailure("INVALID_SYNTHETIC_CHECK", 409);
    const kinds = { 2: "processing", 3: "deterministic_pass", 4: "judge_stub_pass", 5: "synthetic_completed" } as const;
    const kind = claims.outcome === "fail" ? "failed" : kinds[claims.step as keyof typeof kinds];
    if (!kind || (claims.outcome === "fail" && claims.step !== 3)) throw new AuthFailure("INVALID_WORKFLOW_EVENT", 400);
    const [previous] = await transaction.select().from(workflowEvents).where(and(
      eq(workflowEvents.jobId, job.id), eq(workflowEvents.attemptId, job.attemptId), eq(workflowEvents.step, claims.step),
    ));
    if (previous) {
      if (previous.kind !== kind) throw new AuthFailure("WORKFLOW_EVENT_CONFLICT", 409);
      return { accepted: true, duplicate: true };
    }
    if (job.state !== "RUNNING" || claims.step !== job.step + 1) throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);
    const [live] = await transaction.select({ id: workflowJobs.id }).from(workflowJobs).where(and(eq(workflowJobs.id, job.id), gt(workflowJobs.runLeaseUntil, sql`clock_timestamp()`)));
    if (!live) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    await transaction.update(workflowJobs).set({
      state: kind === "failed" ? "FAILED" : claims.step === 5 ? "COMPLETED" : "RUNNING", step: claims.step,
      runLeaseUntil: sql`clock_timestamp() + ${workflowBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
    }).where(eq(workflowJobs.id, job.id));
    await appendEvent(transaction, job, kind, claims.step);
    return { accepted: true, duplicate: false };
  });
}

export async function withOwnedEvents<T>(account: CurrentAccount, jobId: string, after: number,
  release: (events: WorkflowEvent[], terminal: boolean) => T, database: JobDatabase = getDatabase()) {
  return database.transaction(async (transaction) => {
    await lockCurrentAccount(transaction, account);
    const [job] = await transaction.select().from(workflowJobs).where(and(eq(workflowJobs.id, jobId), eq(workflowJobs.ownerId, account.id))).for("share");
    if (!job) throw new AuthFailure("NOT_FOUND", 404);
    if (after > job.eventSequence) throw new AuthFailure("INVALID_EVENT_CURSOR", 400);
    const events = await transaction.select().from(workflowEvents).where(and(eq(workflowEvents.jobId, job.id), gt(workflowEvents.sequence, after)))
      .orderBy(asc(workflowEvents.sequence)).limit(16);
    return release(events, job.state === "COMPLETED" || job.state === "FAILED");
  });
}
