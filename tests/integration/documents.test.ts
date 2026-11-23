import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { authConfiguration } from "../../src/server/auth/config";
import { handleAuthentication } from "../../src/server/auth/handler";
import { AuthFailure } from "../../src/server/auth/errors";
import { handleDocumentRequest } from "../../src/server/documents/http";
import { initializeDocumentUpload, finalizeDocumentUpload, getDocumentUploadStatus } from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import { dispatchJobs, reconcileJobs } from "../../src/server/jobs/dispatch";
import { applyWorkflowCallback, createProbeJob, withOwnedEvents } from "../../src/server/jobs/service";
import { workflowVersion } from "../../src/server/jobs/contracts";
import { seedSyntheticAccount, seedSyntheticSession, syntheticPassword } from "../fixtures/auth";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });
const pdf = Buffer.from("%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
const metadata = (bytes = pdf) => ({ requestKey: randomUUID(), title: "Synthetic upload", fileName: "synthetic.pdf", mimeType: "application/pdf" as const, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
let owner: CurrentAccount, otherAdmin: CurrentAccount, staff: CurrentAccount;

class SyntheticStorage implements DocumentStorage {
  objects = new Map<string, StoredObject>();
  beforeCreate?: () => Promise<void>;
  beforeRead?: (key: string, signal: AbortSignal) => Promise<void>;
  writes = 0;
  async authorizeUpload(object: { mimeType: string; sizeBytes: number; uploadExpiresAt: Date }) {
    return { url: "http://127.0.0.1/synthetic-only", method: "PUT" as const,
      headers: { "Content-Type": object.mimeType, "If-None-Match": "*" as const }, sizeBytes: object.sizeBytes, expiresAt: object.uploadExpiresAt.toISOString() };
  }
  async read(key: string, _maximumBytes: number, signal: AbortSignal) { await this.beforeRead?.(key, signal); return this.objects.get(key) ?? null; }
  async create(key: string, object: StoredObject) {
    await this.beforeCreate?.();
    if (this.objects.has(key)) throw new Error("Synthetic PreconditionFailed");
    this.objects.set(key, { bytes: Buffer.from(object.bytes), contentType: object.contentType }); this.writes++;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function quota() {
  const [row] = await database.select({ total: sql<string>`coalesce(sum(${schema.documentUploadIntents.reservedBytes}), 0)` }).from(schema.documentUploadIntents);
  return Number(row.total);
}

async function initialized(storage = new SyntheticStorage(), bytes = pdf) {
  const input = metadata(bytes);
  const result = await initializeDocumentUpload(owner, input, database, storage, 1_000_000_000);
  const [intent] = await database.select().from(schema.documentUploadIntents).where(eq(schema.documentUploadIntents.id, result.document.id));
  storage.objects.set(intent.stagingKey, { bytes, contentType: input.mimeType });
  return { result, intent, input, storage };
}

async function noAccepted(id: string) {
  expect(await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, id))).toHaveLength(0);
  expect(await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.documentId, id))).toHaveLength(0);
}

beforeAll(async () => {
  owner = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  otherAdmin = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  staff = await seedSyntheticSession(database, await seedSyntheticAccount(database, "STAFF"));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  await database.update(schema.authUsers).set({ role: "ADMIN", active: true }).where(eq(schema.authUsers.id, owner.id));
  owner = await seedSyntheticSession(database, { id: owner.id, email: owner.email, role: "ADMIN" });
});
// Immutable upload rows and their synthetic owners are removed by disposable-project teardown.
afterAll(async () => { await connection.end(); });

describe("D2/D1/ADR03 private upload transactions and parked ingestion", () => {
  it("serializes duplicate initiation, rejects conflicting metadata and retains one2x reservation", async () => {
    const input = metadata(), storage = new SyntheticStorage(), before = await quota();
    const results = await Promise.all(Array.from({ length: 5 }, () => initializeDocumentUpload(owner, input, database, storage, 1_000_000_000)));
    expect(new Set(results.map((result) => result.document.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await quota()).toBe(before + 2 * pdf.length);
    await expect(initializeDocumentUpload(owner, { ...input, title: "Changed" }, database, storage, 1_000_000_000)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await noAccepted(results[0].document.id);
  });

  it("atomically rejects concurrent reservations above the explicitly configured quota", async () => {
    const before = await quota(), storage = new SyntheticStorage(), maximum = before + 2 * pdf.length;
    const outcomes = await Promise.allSettled([initializeDocumentUpload(owner, metadata(), database, storage, maximum),
      initializeDocumentUpload(otherAdmin, metadata(), database, storage, maximum)]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((value) => value.status === "rejected")).toMatchObject({ reason: { code: "UPLOAD_QUOTA_EXCEEDED" } });
    expect(await quota()).toBe(maximum);
  });

  it("accepts immutable bytes and one queued ingestion job; retries and staged replay preserve the final object", async () => {
    const { intent, storage } = await initialized();
    const before = await quota();
    const accepted = await finalizeDocumentUpload(owner, intent.id, database, storage);
    expect(accepted.document).toMatchObject({ uploadStatus: "ACCEPTED", status: "UPLOADED", job: { state: "QUEUED" } });
    storage.objects.set(intent.stagingKey, { bytes: Buffer.from("overwritten staging"), contentType: "text/plain" });
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => finalizeDocumentUpload(owner, intent.id, database, storage)));
    const retried = [];
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled") retried.push(outcome.value);
      else {
        expect(outcome.reason).toMatchObject({ code: "UPLOAD_BUSY" });
        retried.push(await finalizeDocumentUpload(owner, intent.id, database, storage));
      }
    }
    expect(retried).toHaveLength(4);
    expect(retried.every((result) => !result.created && result.document.job?.id === accepted.document.job?.id)).toBe(true);
    expect(storage.objects.get(intent.finalKey)?.bytes).toEqual(pdf);
    expect(storage.writes).toBe(1);
    expect(await quota()).toBe(before);
    expect(JSON.stringify(accepted)).not.toContain("originals/");
    const [jobs] = await database.select({ total: count() }).from(schema.workflowJobs).where(eq(schema.workflowJobs.documentId, intent.id));
    expect(jobs.total).toBe(1);
  });

  it("denies stale role/session, foreign uploader and Staff without trusting the supplied account snapshot", async () => {
    const { intent, storage } = await initialized();
    await expect(initializeDocumentUpload(staff, metadata(), database, storage, 1_000_000_000)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(finalizeDocumentUpload(otherAdmin, intent.id, database, storage)).rejects.toMatchObject({ status: 404 });
    await expect(getDocumentUploadStatus(otherAdmin, intent.id, database)).rejects.toMatchObject({ status: 404 });
    await database.update(schema.authUsers).set({ role: "STAFF" }).where(eq(schema.authUsers.id, owner.id));
    await expect(finalizeDocumentUpload(owner, intent.id, database, storage)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(getDocumentUploadStatus(owner, intent.id, database)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await database.update(schema.authUsers).set({ role: "ADMIN" }).where(eq(schema.authUsers.id, owner.id));
    await database.update(schema.authSessions).set({ expiresAt: new Date(0) }).where(eq(schema.authSessions.id, owner.sessionId));
    await expect(initializeDocumentUpload(owner, metadata(), database, storage, 1_000_000_000)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("allows demotion during storage without held user locks and rejects the post-seal commit", async () => {
    const { intent, storage } = await initialized();
    storage.beforeCreate = async () => { await database.update(schema.authUsers).set({ role: "STAFF" }).where(eq(schema.authUsers.id, owner.id)); };
    await expect(finalizeDocumentUpload(owner, intent.id, database, storage)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(storage.objects.get(intent.finalKey)?.bytes).toEqual(pdf);
    await noAccepted(intent.id);
  });

  it("rejects a session revoked during the seal even if the actor remains an active Admin", async () => {
    const { intent, storage } = await initialized();
    storage.beforeCreate = async () => { await database.delete(schema.authSessions).where(eq(schema.authSessions.id, owner.sessionId)); };
    await expect(finalizeDocumentUpload(owner, intent.id, database, storage)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await noAccepted(intent.id);
  });

  it("does not accept missing, mismatched MIME, size, SHA256 or format", async () => {
    for (const variant of ["missing", "mime", "size", "hash", "format"] as const) {
      const bytes = variant === "format" ? Buffer.from("not a PDF %%EOF") : pdf;
      const { intent, storage } = await initialized(new SyntheticStorage(), bytes);
      if (variant === "missing") storage.objects.delete(intent.stagingKey);
      if (variant === "mime") storage.objects.set(intent.stagingKey, { bytes, contentType: "text/plain" });
      if (variant === "size") storage.objects.set(intent.stagingKey, { bytes: Buffer.concat([bytes, Buffer.from("x")]), contentType: "application/pdf" });
      if (variant === "hash") storage.objects.set(intent.stagingKey, { bytes: Buffer.from(bytes.toString().replace("Catalog", "Changed")), contentType: "application/pdf" });
      await expect(finalizeDocumentUpload(owner, intent.id, database, storage)).rejects.toBeInstanceOf(AuthFailure);
      await noAccepted(intent.id);
      expect(storage.objects.has(intent.finalKey)).toBe(false);
      const status = await getDocumentUploadStatus(owner, intent.id, database);
      expect(status.document).toMatchObject({ uploadStatus: "FAILED", status: null, job: null });
    }
  });

  it("recovers an ambiguous successful conditional PUT by independently rereading its bytes", async () => {
    const { intent, storage } = await initialized();
    const create = storage.create.bind(storage);
    storage.create = async (key, object) => { await create(key, object); throw new Error("Synthetic lost write response with private detail"); };
    const accepted = await finalizeDocumentUpload(owner, intent.id, database, storage);
    expect(accepted.document.status).toBe("UPLOADED");
    expect(storage.writes).toBe(1);
  });

  it("rolls back document/job writes after sealing and safely retries the same original", async () => {
    const { intent, storage } = await initialized();
    const transaction = database.transaction.bind(database);
    let transactions = 0;
    const spy = vi.spyOn(database, "transaction").mockImplementation((operation) => transaction(async (tx) => {
      const result = await operation(tx);
      if (++transactions === 2) throw new Error("Synthetic database failure after document/job inserts");
      return result;
    }));
    await expect(finalizeDocumentUpload(owner, intent.id, database, storage)).rejects.toMatchObject({ code: "UPLOAD_STORAGE_UNAVAILABLE" });
    spy.mockRestore();
    await noAccepted(intent.id);
    storage.objects.delete(intent.stagingKey);
    expect((await finalizeDocumentUpload(owner, intent.id, database, storage)).document.status).toBe("UPLOADED");
    expect(storage.writes).toBe(1);
  });

  it("fences a delayed finalizer after its lease expires and a replacement commits", async () => {
    const { intent, storage } = await initialized();
    const entered = barrier(), release = barrier();
    let calls = 0;
    storage.beforeCreate = async () => { if (++calls === 1) { entered.release(); await release.promise; } };
    const old = finalizeDocumentUpload(owner, intent.id, database, storage);
    const outcome = old.then(() => ({ code: "unexpected success" }), (error: unknown) => error);
    try {
      await entered.promise;
      await database.update(schema.documentUploadIntents).set({ finalizeLeaseUntil: new Date(0) }).where(eq(schema.documentUploadIntents.id, intent.id));
      const replacement = await finalizeDocumentUpload(owner, intent.id, database, storage);
      release.release();
      expect(await outcome).toMatchObject({ code: "UPLOAD_STALE_FINALIZER" });
      expect((await getDocumentUploadStatus(owner, intent.id, database)).document.job?.id).toBe(replacement.document.job?.id);
      expect(storage.writes).toBe(1);
    } finally { release.release(); await outcome; }
  });

  it("bounds process-wide finalization concurrency and gives a safe retry instead of starting a third lease", async () => {
    const first = await initialized(), second = await initialized(), third = await initialized();
    const release = barrier(), entered = barrier(); let count = 0;
    const block = async () => { if (++count === 2) entered.release(); await release.promise; };
    first.storage.beforeCreate = block; second.storage.beforeCreate = block;
    const running = [finalizeDocumentUpload(owner, first.intent.id, database, first.storage), finalizeDocumentUpload(owner, second.intent.id, database, second.storage)];
    try {
      await entered.promise;
      await expect(finalizeDocumentUpload(owner, third.intent.id, database, third.storage)).rejects.toMatchObject({ code: "UPLOAD_BUSY" });
      expect((await getDocumentUploadStatus(owner, third.intent.id, database)).document.uploadStatus).toBe("AWAITING_UPLOAD");
      release.release(); await Promise.all(running);
    } finally { release.release(); await Promise.allSettled(running); }
  });

  it("enforces one overall30s deadline even for a storage implementation that ignores abort", async () => {
    const { intent, storage } = await initialized();
    const entered = barrier(), release = barrier();
    let readSignal: AbortSignal | undefined;
    storage.beforeRead = async (_key, signal) => { readSignal = signal; entered.release(); await release.promise; };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const running = finalizeDocumentUpload(owner, intent.id, database, storage);
    let settled = false;
    const outcome = running.then(() => ({ code: "unexpected success" }), (error: unknown) => error).finally(() => { settled = true; });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(29_000);
      expect(readSignal?.aborted).toBe(false);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(readSignal?.aborted).toBe(true);
      expect(await outcome).toMatchObject({ code: "UPLOAD_STORAGE_UNAVAILABLE" });
    } finally { release.release(); vi.useRealTimers(); await outcome; }
    await noAccepted(intent.id);
    expect((await getDocumentUploadStatus(owner, intent.id, database)).document.uploadStatus).toBe("FAILED");
  });

  it("rejects expired upload acceptance while retaining its reservation", async () => {
    const input = metadata(), storage = new SyntheticStorage();
    const [intent] = await database.insert(schema.documentUploadIntents).values({
      ...input, id: randomUUID(), ownerId: owner.id, inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      reservedBytes: 2 * input.sizeBytes, stagingKey: `staging/${randomUUID()}`, finalKey: `originals/${randomUUID()}`,
      uploadExpiresAt: new Date(0), expiresAt: new Date(0),
    }).returning();
    storage.objects.set(intent.stagingKey, { bytes: pdf, contentType: input.mimeType });
    const before = await quota();
    expect((await getDocumentUploadStatus(owner, intent.id, database)).document.uploadStatus).toBe("EXPIRED");
    await expect(finalizeDocumentUpload(owner, intent.id, database, storage)).rejects.toMatchObject({ code: "UPLOAD_EXPIRED" });
    await noAccepted(intent.id);
    expect(storage.writes).toBe(0);
    expect(await quota()).toBe(before);
  });

  it("rejects a simultaneous finalizer for the same intent and later returns the accepted job", async () => {
    const { intent, storage } = await initialized();
    const entered = barrier(), release = barrier();
    storage.beforeCreate = async () => { entered.release(); await release.promise; };
    const first = finalizeDocumentUpload(owner, intent.id, database, storage);
    try {
      await entered.promise;
      await expect(finalizeDocumentUpload(owner, intent.id, database, storage)).rejects.toMatchObject({ code: "UPLOAD_FINALIZING" });
      release.release();
      const accepted = await first;
      expect((await finalizeDocumentUpload(owner, intent.id, database, storage)).document.job?.id).toBe(accepted.document.job?.id);
      expect(storage.writes).toBe(1);
    } finally { release.release(); await Promise.allSettled([first]); }
  });

  it("does not dispatch via synthetic probe, stream via probe SSE or accept synthetic callbacks for ingestion jobs", async () => {
    const { intent, storage } = await initialized();
    const accepted = await finalizeDocumentUpload(owner, intent.id, database, storage);
    const [before] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, accepted.document.job!.id));
    const send = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    await reconcileJobs(database);
    await dispatchJobs(database, send, async () => "synthetic-token", "http://n8n-main:5678/webhook/sop-s03-probe-v1");
    const [after] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, before.id));
    expect(after).toEqual(before);
    expect(before).toMatchObject({ state: "QUEUED", dispatchCount: 0, runLeaseUntil: null, executionId: null });
    expect(before.attemptDeadline).toBeInstanceOf(Date);
    await expect(withOwnedEvents(owner, before.id, 0, () => undefined, database)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const now = Math.floor(Date.now() / 1000);
    await expect(applyWorkflowCallback({ v: 1, workflow: workflowVersion, purpose: "claim", iss: "sop-n8n", aud: "sop-app", method: "POST",
      path: `/api/internal/jobs/${before.id}/claim`, jobId: before.id, attemptId: before.attemptId, attemptNumber: 1,
      dispatchNonce: before.dispatchNonce, jti: randomUUID(), executionId: "synthetic", step: 1, outcome: "pass", iat: now, nbf: now, exp: now + 30 }, database)).rejects.toMatchObject({ code: "STALE_WORKFLOW_ATTEMPT" });
    const probe = await createProbeJob(owner, { requestKey: intent.requestKey, scenario: "success" }, database);
    expect(probe.jobId).not.toBe(before.id);
    await database.delete(schema.workflowJobs).where(eq(schema.workflowJobs.id, probe.jobId));
  });

  it("enforces immutable reservations, original identity, non-ACTIVE status and ingestion source binding in PostgreSQL", async () => {
    const { intent, storage } = await initialized();
    await finalizeDocumentUpload(owner, intent.id, database, storage);
    await expect(database.update(schema.documentUploadIntents).set({ finalKey: "foreign-key" }).where(eq(schema.documentUploadIntents.id, intent.id))).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.delete(schema.documentUploadIntents).where(eq(schema.documentUploadIntents.id, intent.id))).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(database.update(schema.sopDocuments).set({ sha256: "0".repeat(64) }).where(eq(schema.sopDocuments.id, intent.id))).rejects.toMatchObject({ cause: { code: "42501" } });
    await expect(connection`update app.sop_documents set status = 'ACTIVE' where id = ${intent.id}`).rejects.toMatchObject({ code: "23514" });
    await expect(database.insert(schema.workflowJobs).values({ ownerId: owner.id, requestKey: randomUUID(), inputHash: "0".repeat(64),
      kind: "document_ingestion", documentId: intent.id, sourceSha256: "0".repeat(64), pipelineVersion: "forged-v1", state: "WAITING_FOR_PIPELINE",
      attemptId: randomUUID(), dispatchNonce: randomUUID() })).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(database.update(schema.workflowJobs).set({ state: "QUEUED", attemptDeadline: null })
      .where(eq(schema.workflowJobs.documentId, intent.id))).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("uses safe real API errors for anonymous/Staff/cross-origin/oversized/direct forged requests", async () => {
    const base = authConfiguration().baseURL;
    const request = (body: unknown, headers: Record<string, string> = {}) => new Request(`${base}/api/documents/upload-init`, {
      method: "POST", headers: { host: new URL(base).host, origin: base, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await handleDocumentRequest(request(metadata()), "init")).status).toBe(401);
    expect((await handleDocumentRequest(request(metadata(), { origin: "https://hostile.invalid" }), "init")).status).toBe(403);
    const signIn = await handleAuthentication(new Request(`${base}/api/auth/sign-in/email`, { method: "POST",
      headers: { host: new URL(base).host, origin: base, "content-type": "application/json" }, body: JSON.stringify({ email: staff.email, password: syntheticPassword }) }));
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const denied = await handleDocumentRequest(request(metadata(), { cookie }), "init");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: "FORBIDDEN" } });
    const adminLogin = await handleAuthentication(new Request(`${base}/api/auth/sign-in/email`, { method: "POST",
      headers: { host: new URL(base).host, origin: base, "content-type": "application/json" }, body: JSON.stringify({ email: owner.email, password: syntheticPassword }) }));
    const adminCookie = adminLogin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const invalid = await handleDocumentRequest(request({ ...metadata(), stagingKey: "foreign" }, { cookie: adminCookie }), "init");
    expect(invalid.status).toBe(400);
    const oversized = await handleDocumentRequest(request({ padding: "x".repeat(5000) }, { cookie: adminCookie }), "init");
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(await invalid.json())).not.toContain("foreign");
    const [rows] = await database.select({ total: count() }).from(schema.sopDocuments).where(and(eq(schema.sopDocuments.uploadedBy, staff.id)));
    expect(rows.total).toBe(0);
  });

  it("enforces the document-init route's durable per-account limit before storage work", async () => {
    const admin = await seedSyntheticAccount(database, "ADMIN");
    const base = authConfiguration().baseURL;
    const headers = { host: new URL(base).host, origin: base, "content-type": "application/json" };
    const login = await handleAuthentication(new Request(`${base}/api/auth/sign-in/email`, {
      method: "POST", headers, body: JSON.stringify({ email: admin.email, password: syntheticPassword }),
    }));
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    for (let index = 0; index < 20; index++) {
      const response = await handleDocumentRequest(new Request(`${base}/api/documents/upload-init`, {
        method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ invalid: true }),
      }), "init");
      expect(response.status).toBe(400);
    }
    const limited = await handleDocumentRequest(new Request(`${base}/api/documents/upload-init`, {
      method: "POST", headers: { ...headers, cookie }, body: JSON.stringify({ invalid: true }),
    }), "init");
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: { code: "RATE_LIMITED" } });
  });
});
