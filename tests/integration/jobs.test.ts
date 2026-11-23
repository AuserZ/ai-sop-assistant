import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { importPKCS8, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import { getDatabase } from "../../src/server/db/client";
import * as schema from "../../src/server/db/schema";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { workflowBounds, workflowVersion, type CallbackClaims } from "../../src/server/jobs/contracts";
import { dispatchJobs, reconcileJobs } from "../../src/server/jobs/dispatch";
import { handleWorkflowCallback } from "../../src/server/jobs/http";
import { applyWorkflowCallback, createProbeJob, withOwnedEvents, type WorkflowJob } from "../../src/server/jobs/service";
import { createJobEventStream } from "../../src/server/jobs/stream";
import { seedSyntheticAccount, seedSyntheticSession } from "../fixtures/auth";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });
const ownerIds: string[] = [];
let owner: CurrentAccount;
let stranger: CurrentAccount;
const destination = "http://n8n-main:5678/webhook/sop-s03-probe-v1";

async function job(scenario: "success" | "validation_failure" = "success") {
  const created = await createProbeJob(owner, { requestKey: randomUUID(), scenario }, database);
  const [saved] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, created.jobId));
  return saved;
}

function callback(job: WorkflowJob, step = 1, changes: Partial<CallbackClaims> = {}): CallbackClaims {
  const now = Math.floor(Date.now() / 1000);
  const purpose = step === 1 ? "claim" : "callback";
  return { v: 1, workflow: workflowVersion, jobId: job.id, attemptId: job.attemptId, attemptNumber: job.attemptNumber,
    dispatchNonce: job.dispatchNonce, jti: randomUUID(), iat: now, nbf: now, exp: now + 30,
    iss: "sop-n8n", aud: "sop-app", purpose, method: "POST", path: `/api/internal/jobs/${job.id}/${purpose}`,
    executionId: "synthetic-execution", step, outcome: "pass", ...changes };
}

async function preparedJob(scenario: "success" | "validation_failure" = "success") {
  const saved = await job(scenario);
  await database.update(schema.workflowJobs).set({ dispatchCount: 1 }).where(eq(schema.workflowJobs.id, saved.id));
  return { ...saved, dispatchCount: 1 };
}

beforeAll(async () => {
  for (const role of ["STAFF", "ADMIN"] as const) {
    const user = await seedSyntheticAccount(database, role);
    ownerIds.push(user.id);
    const account = await seedSyntheticSession(database, user);
    if (role === "STAFF") owner = account; else stranger = account;
  }
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (ownerIds.length) {
    await database.delete(schema.workflowJobs).where(inArray(schema.workflowJobs.ownerId, ownerIds));
    await database.delete(schema.authUsers).where(inArray(schema.authUsers.id, ownerIds));
  }
  await Promise.all([connection.end(), getDatabase().$client.end()]);
});

describe("ADR08/D3 durable jobs, attempts, nonce receipts and outbox fencing", () => {
  it("creates one owned job under concurrent retries, rejects conflicting input and keeps ownership immutable", async () => {
    const input = { requestKey: randomUUID(), scenario: "success" };
    const created = await Promise.all(Array.from({ length: 8 }, () => createProbeJob(owner, input, database)));
    expect(new Set(created.map((value) => value.jobId)).size).toBe(1);
    expect(created.filter((value) => value.created)).toHaveLength(1);
    await expect(createProbeJob(owner, { ...input, scenario: "validation_failure" }, database)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const other = await createProbeJob(stranger, input, database);
    expect(other.jobId).not.toBe(created[0].jobId);
    await expect(withOwnedEvents(stranger, created[0].jobId, 0, () => undefined, database)).rejects.toMatchObject({ status: 404 });
    await expect(database.update(schema.workflowJobs).set({ ownerId: stranger.id }).where(eq(schema.workflowJobs.id, created[0].jobId))).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("consumes a concurrent nonce exactly once and deduplicates logical events with a fresh nonce", async () => {
    const saved = await preparedJob();
    const claim = callback(saved);
    const outcomes = await Promise.allSettled([applyWorkflowCallback(claim, database), applyWorkflowCallback(claim, database)]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    await expect(applyWorkflowCallback({ ...claim, jti: randomUUID() }, database)).resolves.toMatchObject({ duplicate: true });
    await expect(applyWorkflowCallback({ ...claim, jti: randomUUID(), executionId: "another-execution" }, database)).rejects.toMatchObject({ code: "WORKFLOW_ALREADY_CLAIMED" });
    const [events] = await database.select({ total: count() }).from(schema.workflowEvents).where(eq(schema.workflowEvents.jobId, saved.id));
    expect(events.total).toBe(2);
  });

  it("requires ordered synthetic checks and produces one literal-only terminal outcome", async () => {
    const saved = await preparedJob();
    await applyWorkflowCallback(callback(saved), database);
    await expect(applyWorkflowCallback(callback(saved, 5), database)).rejects.toMatchObject({ code: "INVALID_WORKFLOW_ORDER" });
    await expect(applyWorkflowCallback(callback(saved, 2, { executionId: "wrong-execution" }), database)).rejects.toMatchObject({ code: "INVALID_WORKFLOW_EXECUTION" });
    for (let step = 2; step <= 5; step++) await applyWorkflowCallback(callback(saved, step), database);
    await expect(applyWorkflowCallback(callback(saved, 5), database)).resolves.toMatchObject({ duplicate: true });
    const response = await createJobEventStream(new Request("http://local.invalid/events"), saved.id, owner, database);
    const bytes = await response.text();
    expect(bytes).toContain("S03_SYNTHETIC_VALIDATED");
    expect(bytes.match(/event: completed/g)).toHaveLength(1);
    expect(bytes.indexOf('"stage":"judge_stub_pass"')).toBeLessThan(bytes.indexOf("S03_SYNTHETIC_VALIDATED"));
    expect(bytes).not.toMatch(/draftAnswer|sourceUrl|session_token|actual_judge/);
    const resumed = await createJobEventStream(new Request("http://local.invalid/events", { headers: { "last-event-id": `${saved.id}:5` } }), saved.id, owner, database);
    expect((await resumed.text()).match(/event: completed/g)).toHaveLength(1);
    await expect(createJobEventStream(new Request("http://local.invalid/events", { headers: { "last-event-id": `${saved.id}:99` } }), saved.id, owner, database)).rejects.toMatchObject({ code: "INVALID_EVENT_CURSOR" });
  });

  it("fails a negative synthetic gate and cannot claim that gate passed", async () => {
    const saved = await preparedJob("validation_failure");
    await applyWorkflowCallback(callback(saved), database);
    await applyWorkflowCallback(callback(saved, 2), database);
    await expect(applyWorkflowCallback(callback(saved, 3), database)).rejects.toMatchObject({ code: "INVALID_SYNTHETIC_CHECK" });
    await applyWorkflowCallback(callback(saved, 3, { outcome: "fail" }), database);
    const response = await createJobEventStream(new Request("http://local.invalid/events"), saved.id, owner, database);
    const bytes = await response.text();
    expect(bytes).toContain("SYNTHETIC_WORKFLOW_FAILED");
    expect(bytes).not.toContain("S03_SYNTHETIC_VALIDATED");
  });

  it("accepts completion before dispatch acknowledgement without status regression", async () => {
    await database.update(schema.workflowJobs).set({ dispatchNextAt: new Date(Date.now() + 60000) })
      .where(and(eq(schema.workflowJobs.kind, "synthetic_probe"), eq(schema.workflowJobs.state, "QUEUED")));
    const saved = await job();
    const send = vi.fn(async () => {
      for (let step = 1; step <= 5; step++) await applyWorkflowCallback(callback(saved, step), database);
      return new Response("{}", { status: 200 });
    });
    await dispatchJobs(database, send, async () => "synthetic-transport-token", destination);
    expect(send).toHaveBeenCalledOnce();
    const [current] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, saved.id));
    expect(current).toMatchObject({ state: "COMPLETED", step: 5, dispatchCount: 1 });
    expect(current.dispatchAcceptedAt).toBeInstanceOf(Date);
  });

  it("starts the entire bounded dispatch batch together, and competing dispatchers cannot double-claim it", async () => {
    await database.update(schema.workflowJobs).set({ dispatchNextAt: new Date(Date.now() + 60000) })
      .where(and(eq(schema.workflowJobs.kind, "synthetic_probe"), eq(schema.workflowJobs.state, "QUEUED")));
    const jobs = await Promise.all(Array.from({ length: workflowBounds.dispatchBatch }, () => job()));
    let release!: () => void;
    let signalStarted!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const allStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const send = vi.fn(async () => { if (send.mock.calls.length === jobs.length) signalStarted(); await pending; return new Response("{}"); });
    const sending = dispatchJobs(database, send, async () => "synthetic-transport-token", destination);
    await allStarted;
    await dispatchJobs(database, send, async () => "synthetic-transport-token", destination);
    expect(send).toHaveBeenCalledTimes(workflowBounds.dispatchBatch);
    release();
    await sending;
    const saved = await database.select().from(schema.workflowJobs).where(inArray(schema.workflowJobs.id, jobs.map((value) => value.id)));
    expect(saved.every((value) => value.dispatchCount === 1)).toBe(true);
  });

  it("bounds delivery retries, recovers lost leases and fences stale attempts after reconciliation", async () => {
    await database.update(schema.workflowJobs).set({ dispatchNextAt: new Date(Date.now() + 60000) })
      .where(and(eq(schema.workflowJobs.kind, "synthetic_probe"), eq(schema.workflowJobs.state, "QUEUED")));
    const saved = await job();
    const failed = vi.fn(async () => { throw new Error("synthetic network interruption"); });
    for (let attempt = 0; attempt < workflowBounds.maximumDispatches + 1; attempt++) {
      await database.update(schema.workflowJobs).set({ dispatchNextAt: new Date(0), dispatchLeaseUntil: new Date(0) }).where(eq(schema.workflowJobs.id, saved.id));
      await dispatchJobs(database, failed, async () => "synthetic-transport-token", destination);
    }
    expect(failed).toHaveBeenCalledTimes(workflowBounds.maximumDispatches);
    await database.update(schema.workflowJobs).set({ attemptDeadline: new Date(0) }).where(eq(schema.workflowJobs.id, saved.id));
    await Promise.all([reconcileJobs(database), reconcileJobs(database)]);
    const [next] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, saved.id));
    expect(next.attemptNumber).toBe(2);
    expect(next.attemptId).not.toBe(saved.attemptId);
    await expect(applyWorkflowCallback(callback(saved), database)).rejects.toMatchObject({ code: "STALE_WORKFLOW_ATTEMPT" });
    for (let attempt = next.attemptNumber; attempt <= workflowBounds.maximumAttempts; attempt++) {
      await database.update(schema.workflowJobs).set({ attemptDeadline: new Date(0) }).where(eq(schema.workflowJobs.id, saved.id));
      await reconcileJobs(database);
    }
    const [terminal] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, saved.id));
    expect(terminal).toMatchObject({ state: "FAILED", attemptNumber: workflowBounds.maximumAttempts });
    const [events] = await database.select({ total: count() }).from(schema.workflowEvents).where(and(eq(schema.workflowEvents.jobId, saved.id), eq(schema.workflowEvents.kind, "failed")));
    expect(events.total).toBe(1);
    await reconcileJobs(database);
    expect((await database.select({ total: count() }).from(schema.workflowEvents).where(and(eq(schema.workflowEvents.jobId, saved.id), eq(schema.workflowEvents.kind, "failed"))))[0].total).toBe(1);
  });

  it("enforces the raw HTTP signature/body/path boundary against real database state", async () => {
    const saved = await preparedJob();
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    vi.stubEnv("SOP_WORKFLOW_PROBE_ENABLED", "1"); vi.stubEnv("AUTH_BASE_URL", "http://127.0.0.1:3000");
    vi.stubEnv("WORKFLOW_CALLBACK_PUBLIC_KEY", keys.publicKey); vi.stubEnv("WORKFLOW_CALLBACK_PUBLIC_KEY_FILE", "");
    vi.stubEnv("WORKFLOW_PROBE_CALLBACK_DELAY_MS", "0");
    const claim = callback(saved);
    const sign = async (value: CallbackClaims) => new SignJWT(value).setProtectedHeader({ alg: "RS256", typ: "JWT" }).sign(await importPKCS8(keys.privateKey, "RS256"));
    const token = await sign(claim);
    const request = (body: string, path = claim.path) => new Request(`http://app:3000${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body });
    expect((await handleWorkflowCallback(request('{"step":5}'), saved.id, "claim")).status).toBe(400);
    expect((await handleWorkflowCallback(request("{}", `/api/internal/jobs/${randomUUID()}/claim`), saved.id, "claim")).status).toBe(403);
    expect((await handleWorkflowCallback(request("{}"), saved.id, "claim")).status).toBe(200);
    expect((await handleWorkflowCallback(request("{}"), saved.id, "claim")).status).toBe(409);
    vi.unstubAllEnvs();
  });

  it("stops an open stream after revocation and leaves durable work available for an authorized reconnect", async () => {
    const isolated = await seedSyntheticAccount(database);
    ownerIds.push(isolated.id);
    const current = await seedSyntheticSession(database, isolated);
    const saved = await createProbeJob(current, { requestKey: randomUUID() }, database);
    const response = await createJobEventStream(new Request("http://local.invalid/events"), saved.jobId, current, database);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"stage":"accepted"');
    await database.update(schema.authUsers).set({ active: false }).where(eq(schema.authUsers.id, current.id));
    expect((await reader.read()).done).toBe(true);
    await expect(createJobEventStream(new Request("http://local.invalid/events"), saved.jobId, current, database)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const [stored] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, saved.jobId));
    expect(stored.state).toBe("QUEUED");
    await reader.cancel();
  });

  it("fences expired running leases and safely reconnects after a browser cancellation", async () => {
    const saved = await preparedJob();
    await applyWorkflowCallback(callback(saved), database);
    const first = await createJobEventStream(new Request("http://local.invalid/events"), saved.id, owner, database);
    const reader = first.body!.getReader();
    let bytes = "";
    for (let frames = 0; frames < 16 && !bytes.includes('"stage":"started"'); frames++) {
      const frame = await reader.read();
      if (frame.done) break;
      bytes += new TextDecoder().decode(frame.value);
    }
    expect(bytes).toContain('"stage":"started"');
    await reader.cancel();
    await database.update(schema.workflowJobs).set({ runLeaseUntil: new Date(0) }).where(eq(schema.workflowJobs.id, saved.id));
    await reconcileJobs(database);
    await expect(applyWorkflowCallback(callback(saved, 2), database)).rejects.toMatchObject({ code: "STALE_WORKFLOW_ATTEMPT" });
    const resumed = await createJobEventStream(new Request("http://local.invalid/events", { headers: { "last-event-id": `${saved.id}:2` } }), saved.id, owner, database);
    const resumedReader = resumed.body!.getReader();
    expect(new TextDecoder().decode((await resumedReader.read()).value)).toContain('"stage":"retrying"');
    await resumedReader.cancel();
    const [current] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, saved.id));
    expect(current).toMatchObject({ state: "QUEUED", attemptNumber: 2 });
  });

  it("closes a timed-out authorized stream without fabricating a terminal workflow result", async () => {
    const saved = await job();
    const response = await createJobEventStream(new Request("http://local.invalid/events"), saved.id, owner, database);
    const reader = response.body!.getReader();
    await reader.read();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + workflowBounds.streamMilliseconds + 1);
    try {
      const bytes = new TextDecoder().decode((await reader.read()).value);
      expect(bytes).toContain("event: stream_timeout");
      expect(bytes).not.toContain("S03_SYNTHETIC_VALIDATED");
      expect((await reader.read()).done).toBe(true);
    } finally { clock.mockRestore(); await reader.cancel(); }
  });

  it("denies event rewrites and nonce rewrites under the runtime database identity", async () => {
    await expect(connection`update app.workflow_events set kind='synthetic_completed' where false`).rejects.toMatchObject({ code: "42501" });
    await expect(connection`delete from app.workflow_events where false`).rejects.toMatchObject({ code: "42501" });
    await expect(connection`update app.workflow_nonce_receipts set expires_at=now() where false`).rejects.toMatchObject({ code: "42501" });
    const ordered = await database.select().from(schema.workflowEvents).where(eq(schema.workflowEvents.jobId, (await job()).id)).orderBy(asc(schema.workflowEvents.sequence));
    expect(ordered.map((event) => event.sequence)).toEqual([1]);
  });
});
