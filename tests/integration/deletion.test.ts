import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { count, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { authConfiguration } from "../../src/server/auth/config";
import { handleAuthentication } from "../../src/server/auth/handler";
import {
  handleDocumentDeleteRequest,
  handleDocumentSourceContentRequest,
  handleDocumentSourceRequest,
} from "../../src/server/documents/http";
import {
  authorizeDocumentSource,
  deleteDocument,
  finalizeDocumentUpload,
  initializeDocumentUpload,
  listDocuments,
  queryEligibleActiveChunks,
  readDocumentSourceContent,
  reconcileDocumentDeletions,
  resolveDocumentCitationAvailability,
} from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import {
  ingestionWorkflowVersion,
  type IngestionCallbackClaims,
  type IngestionCallbackPurpose,
} from "../../src/server/jobs/contracts";
import { dispatchIngestionJobs, reconcileJobs } from "../../src/server/jobs/dispatch";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
  failIngestionStage,
  renewSourceRefStage,
} from "../../src/server/ingestion/service";
import {
  getDocumentReview,
  readDocumentPreview,
  reprocessDocument,
  verifyDocument,
} from "../../src/server/verification/service";
import { seedSyntheticAccount, seedSyntheticSession, syntheticPassword } from "../fixtures/auth";
import { syntheticPdf, syntheticRichDocx } from "../fixtures/document-files";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });
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

let adminAccount: CurrentAccount;
let staffAccount: CurrentAccount;

class MemoryStorage implements DocumentStorage {
  objects = new Map<string, StoredObject>();
  deletedKeys: string[] = [];
  failDelete = false;
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
    if (this.failDelete) {
      throw new Error("Simulated storage outage");
    }
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }
}

function makeClaims(
  job: typeof schema.workflowJobs.$inferSelect,
  purpose: IngestionCallbackPurpose,
  executionId = "exec-s08",
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
    jti: `${job.attemptId}:${executionId}:${purpose}:${randomUUID().slice(0, 8)}`,
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

function pdfWorkerFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/pdf/inspect-and-extract")) {
      return Response.json({
        result: "PASS",
        pageCount: 1,
        pages: [
          {
            pageIndex: 1,
            nativeText:
              "Section 1 Pump Isolation\n1. Close intake valve V-101.\n2. Confirm pressure reads 0.0 bar for 10 minutes.",
            imageCount: 0,
            maxImagePixels: 0,
          },
        ],
      });
    }
    throw new Error(`Unexpected worker URL: ${url}`);
  });
}

function docxWorkerFetch(previewPdfBytes = syntheticPdf()): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/convert/docx-to-pdf")) {
      return new Response(new Uint8Array(previewPdfBytes), {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    if (url.endsWith("/pdf/inspect-and-extract")) {
      return Response.json({ result: "PASS", pageCount: 1, pages: [] });
    }
    throw new Error(`Unexpected worker URL: ${url}`);
  });
}

async function signInCookie(email: string) {
  const baseUrl = authConfiguration().baseURL;
  const host = new URL(baseUrl).host;
  const response = await handleAuthentication(
    new Request(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl, Host: host },
      body: JSON.stringify({ email, password: syntheticPassword }),
    }),
  );
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie().map((entry) => entry.split(";")[0]);
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.join("; ");
}

async function seedDocument(options: {
  title: string;
  kind?: "pdf" | "docx";
  stage?: "UPLOADED" | "PROCESSING" | "PENDING_VERIFICATION" | "ACTIVE";
  storage?: MemoryStorage;
}) {
  const kind = options.kind ?? "pdf";
  const stage = options.stage ?? "ACTIVE";
  const storage = options.storage ?? new MemoryStorage();
  const bytes = kind === "pdf" ? syntheticPdf() : syntheticRichDocx();
  const mimeType =
    kind === "pdf"
      ? ("application/pdf" as const)
      : ("application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const);
  const fileName = kind === "pdf" ? `${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf` : `${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.docx`;

  const init = await initializeDocumentUpload(
    adminAccount,
    {
      requestKey: randomUUID(),
      title: options.title,
      fileName,
      mimeType,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    database,
    storage,
    1_000_000_000,
  );
  const [intent] = await database
    .select()
    .from(schema.documentUploadIntents)
    .where(eq(schema.documentUploadIntents.id, init.document.id));
  storage.objects.set(intent.stagingKey, { bytes, contentType: mimeType });
  const accepted = await finalizeDocumentUpload(adminAccount, intent.id, database, storage);
  await database
    .update(schema.workflowJobs)
    .set({
      dispatchCount: 1,
      dispatchNextAt: sql`clock_timestamp() + interval '60 seconds'`,
    })
    .where(eq(schema.workflowJobs.id, accepted.document.job!.id));

  let [job] = await database
    .select()
    .from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.id, accepted.document.job!.id));

  if (stage === "UPLOADED") {
    const [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
    return { documentId: intent.id, doc, intent, job, storage, fileRefToken: null as string | null };
  }

  const claimed = await claimIngestionStage(makeClaims(job, "claim"), {
    database,
    privateKey: dispatchKeys.privateKey,
  });
  [job] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));

  if (stage === "PROCESSING") {
    const [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
    return { documentId: intent.id, doc, intent, job, storage, fileRefToken: claimed.fileRefToken };
  }

  await extractIngestionStage(makeClaims(job, "extract"), claimed.fileRefToken, {
    database,
    storage,
    fetchImpl: kind === "pdf" ? pdfWorkerFetch() : docxWorkerFetch(),
    env: workerEnv,
    privateKey: dispatchKeys.privateKey,
  });
  await chunkIngestionStage(makeClaims(job, "chunk"), { database });
  await embedIngestionStage(makeClaims(job, "embed"), { database, env: workerEnv });
  await completeIngestionStage(makeClaims(job, "complete"), { database });

  let [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
  [job] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));

  if (stage === "ACTIVE") {
    await verifyDocument(
      adminAccount,
      intent.id,
      {
        decision: "APPROVE",
        expectedSha256: doc.sha256,
        expectedJobId: job.id,
        expectedPipelineVersion: doc.processedPipelineVersion!,
        expectedAttemptId: doc.processedAttemptId!,
        explicitConfirmation: true,
      },
      database,
    );
    [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
  }

  return { documentId: intent.id, doc, intent, job, storage, fileRefToken: claimed.fileRefToken };
}

beforeAll(async () => {
  adminAccount = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  staffAccount = await seedSyntheticSession(database, await seedSyntheticAccount(database, "STAFF"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database
    .update(schema.authUsers)
    .set({ role: "ADMIN", active: true })
    .where(eq(schema.authUsers.id, adminAccount.id));
  adminAccount = await seedSyntheticSession(database, {
    id: adminAccount.id,
    email: adminAccount.email,
    role: "ADMIN",
  });
});

afterAll(async () => {
  await connection.end();
});

describe("S08/D4 SOP deletion, reliable unindexing, race guards and DB invariants", () => {
  it("enforces Admin-only HTTP DELETE boundaries and rejects anonymous, Staff, cross-origin, deactivated and unknown IDs", async () => {
    const baseUrl = authConfiguration().baseURL;
    const host = new URL(baseUrl).host;
    const seeded = await seedDocument({ title: "S08 Auth Boundary SOP", stage: "ACTIVE" });
    const staffCookie = await signInCookie(staffAccount.email);
    const adminCookie = await signInCookie(adminAccount.email);

    // Anonymous -> 401
    expect(
      (
        await handleDocumentDeleteRequest(
          new Request(`${baseUrl}/api/documents/${seeded.documentId}`, {
            method: "DELETE",
            headers: { Origin: baseUrl, Host: host },
          }),
          seeded.documentId,
        )
      ).status,
    ).toBe(401);

    // Staff -> 403
    const staffDeleteRes = await handleDocumentDeleteRequest(
      new Request(`${baseUrl}/api/documents/${seeded.documentId}`, {
        method: "DELETE",
        headers: { Origin: baseUrl, Host: host, Cookie: staffCookie },
      }),
      seeded.documentId,
    );
    expect(staffDeleteRes.status).toBe(403);
    expect(await staffDeleteRes.json()).toEqual({ error: { code: "FORBIDDEN" } });

    // Cross-origin Admin -> 403
    expect(
      (
        await handleDocumentDeleteRequest(
          new Request(`${baseUrl}/api/documents/${seeded.documentId}`, {
            method: "DELETE",
            headers: { Origin: "https://evil.example.invalid", Host: host, Cookie: adminCookie },
          }),
          seeded.documentId,
        )
      ).status,
    ).toBe(403);

    // Invalid and nonexistent UUIDs -> 404
    expect(
      (
        await handleDocumentDeleteRequest(
          new Request(`${baseUrl}/api/documents/not-a-uuid`, {
            method: "DELETE",
            headers: { Origin: baseUrl, Host: host, Cookie: adminCookie },
          }),
          "not-a-uuid",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleDocumentDeleteRequest(
          new Request(`${baseUrl}/api/documents/${randomUUID()}`, {
            method: "DELETE",
            headers: { Origin: baseUrl, Host: host, Cookie: adminCookie },
          }),
          randomUUID(),
        )
      ).status,
    ).toBe(404);

    // Deactivated Admin -> 401
    await database
      .update(schema.authUsers)
      .set({ active: false })
      .where(eq(schema.authUsers.id, adminAccount.id));
    expect(
      (
        await handleDocumentDeleteRequest(
          new Request(`${baseUrl}/api/documents/${seeded.documentId}`, {
            method: "DELETE",
            headers: { Origin: baseUrl, Host: host, Cookie: adminCookie },
          }),
          seeded.documentId,
        )
      ).status,
    ).toBe(401);

    // Document remains ACTIVE after all denied delete attempts.
    const eligible = await queryEligibleActiveChunks(database, { documentId: seeded.documentId });
    expect(eligible.length).toBeGreaterThan(0);

    // Re-activate Admin with a fresh session and confirm HTTP DELETE returns 202 then idempotent 200.
    await database
      .update(schema.authUsers)
      .set({ active: true })
      .where(eq(schema.authUsers.id, adminAccount.id));
    const freshAdminCookie = await signInCookie(adminAccount.email);
    const httpDeleteFirst = await handleDocumentDeleteRequest(
      new Request(`${baseUrl}/api/documents/${seeded.documentId}`, {
        method: "DELETE",
        headers: { Origin: baseUrl, Host: host, Cookie: freshAdminCookie },
      }),
      seeded.documentId,
    );
    expect(httpDeleteFirst.status).toBe(202);
    expect(httpDeleteFirst.headers.get("cache-control")).toBe("private, no-store");
    expect(await httpDeleteFirst.json()).toMatchObject({
      deleted: true,
      created: true,
      document: { id: seeded.documentId, status: "DELETED" },
    });

    const httpDeleteSecond = await handleDocumentDeleteRequest(
      new Request(`${baseUrl}/api/documents/${seeded.documentId}`, {
        method: "DELETE",
        headers: { Origin: baseUrl, Host: host, Cookie: freshAdminCookie },
      }),
      seeded.documentId,
    );
    expect(httpDeleteSecond.status).toBe(200);
    expect(await httpDeleteSecond.json()).toMatchObject({
      deleted: true,
      created: false,
      document: { id: seeded.documentId, status: "DELETED" },
    });
  });

  it("removes eligibility and historical source/citation access immediately even when storage cleanup fails, then converges across retries and worker crash", async () => {
    const tag = `S08-Conv-${randomUUID().slice(0, 8)}`;
    const storage = new MemoryStorage();
    const seeded = await seedDocument({
      title: `${tag} DOCX Valve Procedure`,
      kind: "docx",
      stage: "ACTIVE",
      storage,
    });
    const originalPreviewKey = seeded.doc.previewKey;
    expect(originalPreviewKey).toBeTruthy();
    expect(storage.objects.has(seeded.doc.originalKey)).toBe(true);
    expect(storage.objects.has(originalPreviewKey!)).toBe(true);
    expect(storage.objects.has(seeded.intent.stagingKey)).toBe(true);

    // Before deletion: chunks eligible, citations available, signed source tokens valid.
    expect(
      (await queryEligibleActiveChunks(database, { documentId: seeded.documentId })).length,
    ).toBeGreaterThan(0);
    expect(
      await resolveDocumentCitationAvailability(staffAccount, seeded.documentId, database),
    ).toEqual({
      available: true,
      documentId: seeded.documentId,
      title: seeded.doc.title,
      status: "ACTIVE",
    });

    const staffSourceAuth = await authorizeDocumentSource(
      staffAccount,
      seeded.documentId,
      { disposition: "inline" },
      database,
    );
    const adminSourceAuth = await authorizeDocumentSource(
      adminAccount,
      seeded.documentId,
      { disposition: "attachment" },
      database,
    );
    const staffToken = new URL(`http://127.0.0.1${staffSourceAuth.source.url}`).searchParams.get("token")!;
    const adminToken = new URL(`http://127.0.0.1${adminSourceAuth.source.url}`).searchParams.get("token")!;

    // 1. Admin deletes ACTIVE SOP.
    const firstDelete = await deleteDocument(adminAccount, seeded.documentId, database);
    expect(firstDelete).toMatchObject({
      deleted: true,
      created: true,
      document: {
        id: seeded.documentId,
        status: "DELETED",
        cleanup: { state: "PENDING", attempts: 0, errorCode: null, completedAt: null },
      },
    });

    // Immediately after tombstone commit (BEFORE physical cleanup runs):
    // Eligible chunks are already empty, citations are unavailable, source/preview access fails (404).
    expect(
      await queryEligibleActiveChunks(database, { documentId: seeded.documentId }),
    ).toEqual([]);
    expect(
      await resolveDocumentCitationAvailability(staffAccount, seeded.documentId, database),
    ).toEqual({ available: false, documentId: seeded.documentId, reason: "UNAVAILABLE" });
    expect(
      await resolveDocumentCitationAvailability(adminAccount, seeded.documentId, database),
    ).toEqual({ available: false, documentId: seeded.documentId, reason: "DELETED" });
    expect(
      await resolveDocumentCitationAvailability(staffAccount, randomUUID(), database),
    ).toEqual({ available: false, documentId: expect.any(String), reason: "UNAVAILABLE" });

    await expect(
      readDocumentSourceContent(staffAccount, seeded.documentId, { token: staffToken }, database, storage),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      readDocumentSourceContent(adminAccount, seeded.documentId, { token: adminToken }, database, storage),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      authorizeDocumentSource(staffAccount, seeded.documentId, {}, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      authorizeDocumentSource(adminAccount, seeded.documentId, {}, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      readDocumentPreview(adminAccount, seeded.documentId, database, storage),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    const reviewAfterDelete = await getDocumentReview(adminAccount, seeded.documentId, database);
    expect(reviewAfterDelete.document.status).toBe("DELETED");
    expect(reviewAfterDelete.document.hasPreview).toBe(false);
    expect(reviewAfterDelete.document.previewUrl).toBeNull();

    // Staff list excludes DELETED; Admin list includes DELETED with deletedAt and cleanup diagnostics.
    const staffList = await listDocuments(staffAccount, { q: tag }, database);
    expect(staffList.items).toHaveLength(0);
    const adminList = await listDocuments(adminAccount, { q: tag }, database);
    expect(adminList.items).toHaveLength(1);
    expect(adminList.items[0]).toMatchObject({
      id: seeded.documentId,
      status: "DELETED",
      deletedAt: firstDelete.document.deletedAt,
      diagnostics: {
        hasPreview: false,
        cleanup: { state: "PENDING", attempts: 0, errorCode: null, completedAt: null },
      },
    });

    // 2. Simulate storage outage during reconciliation: DB chunks/pages/issues STILL purge immediately!
    storage.failDelete = true;
    const failedRun = await reconcileDocumentDeletions(database, storage, {
      documentIds: [seeded.documentId],
    });
    expect(failedRun).toEqual({ processed: 1, completed: 0, failed: 1 });

    const [chunksAfterFail] = await database
      .select({ total: count() })
      .from(schema.sopChunks)
      .where(eq(schema.sopChunks.documentId, seeded.documentId));
    const [pagesAfterFail] = await database
      .select({ total: count() })
      .from(schema.sopExtractionPages)
      .where(eq(schema.sopExtractionPages.documentId, seeded.documentId));
    const [issuesAfterFail] = await database
      .select({ total: count() })
      .from(schema.sopVerificationIssues)
      .where(eq(schema.sopVerificationIssues.documentId, seeded.documentId));
    expect(chunksAfterFail.total).toBe(0);
    expect(pagesAfterFail.total).toBe(0);
    expect(issuesAfterFail.total).toBe(0);

    const [failedDoc] = await database
      .select()
      .from(schema.sopDocuments)
      .where(eq(schema.sopDocuments.id, seeded.documentId));
    expect(failedDoc.status).toBe("DELETED");
    expect(failedDoc.cleanupState).toBe("FAILED");
    expect(failedDoc.cleanupAttempts).toBe(1);
    expect(failedDoc.cleanupErrorCode).toBe("CLEANUP_STORAGE_UNAVAILABLE");
    expect(failedDoc.cleanupNextAt!.getTime()).toBeGreaterThan(Date.now());

    // 3. Duplicate Admin delete while FAILED resets cleanup_state -> PENDING while preserving tombstone.
    const retryDelete = await deleteDocument(adminAccount, seeded.documentId, database);
    expect(retryDelete).toMatchObject({
      deleted: true,
      created: false,
      document: {
        id: seeded.documentId,
        status: "DELETED",
        deletedAt: firstDelete.document.deletedAt,
        cleanup: { state: "PENDING", attempts: 1, errorCode: null, completedAt: null },
      },
    });

    // 4. Simulate worker crash mid-cleanup (expired RUNNING lease).
    await database
      .update(schema.sopDocuments)
      .set({
        cleanupState: "RUNNING",
        cleanupLeaseToken: randomUUID(),
        cleanupLeaseUntil: sql`clock_timestamp() - interval '5 seconds'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(schema.sopDocuments.id, seeded.documentId));

    // 5. Storage recovers -> reconciler reclaims expired lease and completes cleanup.
    storage.failDelete = false;
    const recoveredRun = await reconcileDocumentDeletions(database, storage, {
      documentIds: [seeded.documentId],
    });
    expect(recoveredRun).toEqual({ processed: 1, completed: 1, failed: 0 });

    const [completedDoc] = await database
      .select()
      .from(schema.sopDocuments)
      .where(eq(schema.sopDocuments.id, seeded.documentId));
    expect(completedDoc.status).toBe("DELETED");
    expect(completedDoc.deletedBy).toBe(adminAccount.id);
    expect(completedDoc.deletedAt?.toISOString()).toBe(firstDelete.document.deletedAt);
    expect(completedDoc.cleanupState).toBe("COMPLETED");
    expect(completedDoc.cleanupAttempts).toBe(2);
    expect(completedDoc.cleanupErrorCode).toBeNull();
    expect(completedDoc.cleanupLeaseToken).toBeNull();
    expect(completedDoc.cleanupLeaseUntil).toBeNull();
    expect(completedDoc.cleanupCompletedAt).not.toBeNull();
    expect(completedDoc.previewKey).toBeNull();

    // All private objects (original, preview, staging) removed from storage.
    expect(storage.objects.has(seeded.doc.originalKey)).toBe(false);
    expect(storage.objects.has(originalPreviewKey!)).toBe(false);
    expect(storage.objects.has(seeded.intent.stagingKey)).toBe(false);
    expect(storage.deletedKeys).toEqual(
      expect.arrayContaining([seeded.doc.originalKey, originalPreviewKey!, seeded.intent.stagingKey]),
    );

    // Idempotent duplicate delete after COMPLETED leaves tombstone & COMPLETED intact.
    const postCompleteDelete = await deleteDocument(adminAccount, seeded.documentId, database);
    expect(postCompleteDelete).toMatchObject({
      deleted: true,
      created: false,
      document: {
        id: seeded.documentId,
        status: "DELETED",
        deletedAt: firstDelete.document.deletedAt,
        cleanup: { state: "COMPLETED", attempts: 2, errorCode: null },
      },
    });
    expect(
      await reconcileDocumentDeletions(database, storage, { documentIds: [seeded.documentId] }),
    ).toEqual({ processed: 0, completed: 0, failed: 0 });

    // Audit trail captures lifecycle transitions with sanitized metadata (no storage keys).
    const audits = await database
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, seeded.documentId));
    expect(audits.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "document.deleted",
        "document.cleanup_failed",
        "document.cleanup_completed",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain("originals/");
    expect(JSON.stringify(audits)).not.toContain("previews/");
    expect(JSON.stringify(audits)).not.toContain("staging/");
  });

  it("rejects stale ingestion, verification, reprocess, upload-finalize, and dispatcher operations on DELETED documents", async () => {
    // 1. Delete an in-flight PROCESSING document and verify every ingestion callback fails 409 DOCUMENT_DELETED.
    const processingSeed = await seedDocument({ title: "S08 Processing Race SOP", stage: "PROCESSING" });
    await deleteDocument(adminAccount, processingSeed.documentId, database);

    const [failedJob] = await database
      .select()
      .from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, processingSeed.job.id));
    expect(failedJob.state).toBe("FAILED");
    expect(failedJob.errorCode).toBe("DOCUMENT_DELETED");
    expect(failedJob.runLeaseUntil).toBeNull();
    expect(failedJob.dispatchLeaseToken).toBeNull();

    await expect(
      claimIngestionStage(makeClaims(processingSeed.job, "claim"), {
        database,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      renewSourceRefStage(makeClaims(processingSeed.job, "renew-source-ref"), {
        database,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      extractIngestionStage(makeClaims(processingSeed.job, "extract"), processingSeed.fileRefToken!, {
        database,
        storage: processingSeed.storage,
        fetchImpl: pdfWorkerFetch(),
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      chunkIngestionStage(makeClaims(processingSeed.job, "chunk"), { database }),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      embedIngestionStage(makeClaims(processingSeed.job, "embed"), { database, env: workerEnv }),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      completeIngestionStage(makeClaims(processingSeed.job, "complete"), { database }),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      failIngestionStage(
        makeClaims(processingSeed.job, "fail"),
        { errorCode: "OCR_WORKER_TRANSIENT", transient: true },
        { database },
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      finalizeDocumentUpload(adminAccount, processingSeed.documentId, database, processingSeed.storage),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    // 2. Delete a PENDING_VERIFICATION document and verify verifyDocument & reprocessDocument fail 409 DOCUMENT_DELETED.
    const pendingSeed = await seedDocument({ title: "S08 Verify Race SOP", stage: "PENDING_VERIFICATION" });
    await deleteDocument(adminAccount, pendingSeed.documentId, database);

    await expect(
      verifyDocument(
        adminAccount,
        pendingSeed.documentId,
        {
          decision: "APPROVE",
          expectedSha256: pendingSeed.doc.sha256,
          expectedJobId: pendingSeed.job.id,
          expectedPipelineVersion: pendingSeed.doc.processedPipelineVersion!,
          expectedAttemptId: pendingSeed.doc.processedAttemptId!,
          explicitConfirmation: true,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    await expect(
      reprocessDocument(
        adminAccount,
        pendingSeed.documentId,
        { expectedSha256: pendingSeed.doc.sha256 },
        database,
      ),
    ).rejects.toMatchObject({ code: "DOCUMENT_DELETED", status: 409 });

    // 3. Dispatcher and job reconciler skip DELETED documents even if a queued job existed.
    const uploadedSeed = await seedDocument({ title: "S08 Dispatch Skip SOP", stage: "UPLOADED" });
    await deleteDocument(adminAccount, uploadedSeed.documentId, database);

    // Even if a job row were forced back to QUEUED/due in a race, dispatchIngestionJobs must skip it.
    await database
      .update(schema.workflowJobs)
      .set({
        state: "QUEUED",
        dispatchCount: 0,
        dispatchAcceptedAt: null,
        dispatchNextAt: sql`clock_timestamp() - interval '5 seconds'`,
        attemptDeadline: sql`clock_timestamp() + interval '60 seconds'`,
      })
      .where(eq(schema.workflowJobs.id, uploadedSeed.job.id));

    const dispatchedUrls: string[] = [];
    await dispatchIngestionJobs(
      database,
      vi.fn<typeof fetch>(async (url) => {
        dispatchedUrls.push(String(url));
        return new Response("{}", { status: 200 });
      }),
      async () => "synthetic-dispatch-jwt",
      "http://n8n-main:5678/webhook/sop-s05-ingestion-v1",
    );
    expect(dispatchedUrls).toEqual([]);
    const [afterDispatchJob] = await database
      .select()
      .from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, uploadedSeed.job.id));
    expect(afterDispatchJob.dispatchCount).toBe(0);
    expect(afterDispatchJob.dispatchAcceptedAt).toBeNull();

    // And if an expired job belongs to a DELETED document, reconcileJobs marks it FAILED instead of retrying.
    await database
      .update(schema.workflowJobs)
      .set({ attemptDeadline: sql`clock_timestamp() - interval '5 seconds'` })
      .where(eq(schema.workflowJobs.id, uploadedSeed.job.id));
    await reconcileJobs(database);
    const [afterReconcileJob] = await database
      .select()
      .from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, uploadedSeed.job.id));
    expect(afterReconcileJob.state).toBe("FAILED");
    expect(afterReconcileJob.errorCode).toBe("DOCUMENT_DELETED");
  });

  it("enforces PostgreSQL DELETED tombstone irreversibility, artifact blocking (23514) and column immutability (42501) under sop_runtime", async () => {
    const activeSeed = await seedDocument({ title: "S08 SQL Trigger SOP", stage: "ACTIVE" });
    const pendingSeed = await seedDocument({ title: "S08 Staff Delete Trigger SOP", stage: "PENDING_VERIFICATION" });

    // Non-Admin deleted_by -> 23514.
    await expect(
      connection`
        update app.sop_documents
        set status = 'DELETED',
            active_job_id = null,
            active_pipeline_version = null,
            active_attempt_id = null,
            rejection_reason = null,
            deleted_by = ${staffAccount.id},
            deleted_at = clock_timestamp(),
            cleanup_state = 'PENDING',
            cleanup_next_at = clock_timestamp()
        where id = ${pendingSeed.documentId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // Admin deletes the ACTIVE document.
    await deleteDocument(adminAccount, activeSeed.documentId, database);

    // Tombstone cannot be revived to ACTIVE or UPLOADED -> 23514.
    await expect(
      connection`
        update app.sop_documents
        set status = 'UPLOADED',
            deleted_by = null,
            deleted_at = null,
            cleanup_state = null,
            cleanup_error_code = null,
            cleanup_next_at = null,
            cleanup_lease_token = null,
            cleanup_lease_until = null,
            cleanup_completed_at = null
        where id = ${activeSeed.documentId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection`
        update app.sop_documents
        set status = 'ACTIVE',
            active_job_id = ${activeSeed.job.id},
            active_pipeline_version = ${activeSeed.doc.processedPipelineVersion!},
            active_attempt_id = ${activeSeed.doc.processedAttemptId!},
            deleted_by = null,
            deleted_at = null,
            cleanup_state = null,
            cleanup_error_code = null,
            cleanup_next_at = null,
            cleanup_lease_token = null,
            cleanup_lease_until = null,
            cleanup_completed_at = null
        where id = ${activeSeed.documentId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // Ungranted column (title) fails with 42501; sop_runtime-granted non-cleanup columns on DELETED fail with 23514.
    await expect(
      connection`update app.sop_documents set title = 'Tampered' where id = ${activeSeed.documentId}`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connection`update app.sop_documents set deleted_by = ${staffAccount.id} where id = ${activeSeed.documentId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection`update app.sop_documents set processing_error_code = 'TAMPERED' where id = ${activeSeed.documentId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection`update app.sop_documents set preview_key = ${`previews/${activeSeed.documentId}/injected.pdf`} where id = ${activeSeed.documentId}`,
    ).rejects.toMatchObject({ code: "23514" });

    // Late artifact INSERTs on DELETED document fail with 23514 across all 4 tables.
    await expect(
      connection`
        insert into app.sop_chunks
          (document_id, job_id, source_sha256, pipeline_version, sequence, section_path, content_type, text, content_hash, token_estimate)
        values
          (${activeSeed.documentId}, ${activeSeed.job.id}, ${activeSeed.doc.sha256}, ${activeSeed.doc.processedPipelineVersion!}, 99, 'Section 99', 'procedure', 'Injected chunk', ${"c".repeat(64)}, 5)
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection`
        insert into app.sop_extraction_pages
          (document_id, job_id, source_sha256, pipeline_version, page_index, page_kind, source_location_kind, raw_text, normalized_text)
        values
          (${activeSeed.documentId}, ${activeSeed.job.id}, ${activeSeed.doc.sha256}, ${activeSeed.doc.processedPipelineVersion!}, 99, 'native', 'pdf_page', 'Injected', 'Injected')
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection`
        insert into app.sop_verification_issues
          (document_id, job_id, severity, issue_code, summary)
        values
          (${activeSeed.documentId}, ${activeSeed.job.id}, 'warning', 'INJECTED', 'Injected issue')
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection`
        insert into app.sop_verification_records
          (document_id, source_sha256, job_id, pipeline_version, attempt_id, reviewer_id, decision, notes, issue_summary, before_status, after_status)
        values
          (${activeSeed.documentId}, ${activeSeed.doc.sha256}, ${activeSeed.job.id}, ${activeSeed.doc.processedPipelineVersion!}, ${activeSeed.doc.processedAttemptId!}, ${adminAccount.id}, 'APPROVED', null, '{"total":0,"resolved":0,"unresolved":0,"bySeverity":{"error":0,"warning":0,"info":0}}'::jsonb, 'PENDING_VERIFICATION', 'ACTIVE')
      `,
    ).rejects.toMatchObject({ code: "23514" });

    // Immutable columns remain protected by column-level grants (42501).
    await expect(
      connection`update app.sop_documents set sha256 = ${"0".repeat(64)} where id = ${activeSeed.documentId}`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connection`update app.sop_documents set original_key = 'originals/tampered' where id = ${activeSeed.documentId}`,
    ).rejects.toMatchObject({ code: "42501" });

    // Historical verification records remain append-only even after deletion (42501).
    await expect(
      connection`delete from app.sop_verification_records where document_id = ${activeSeed.documentId}`,
    ).rejects.toMatchObject({ code: "42501" });

    // HTTP source/content endpoints return 404 after deletion.
    const baseUrl = authConfiguration().baseURL;
    const adminCookie = await signInCookie(adminAccount.email);
    expect(
      (
        await handleDocumentSourceRequest(
          new Request(`${baseUrl}/api/documents/${activeSeed.documentId}/source`, {
            headers: { Cookie: adminCookie },
          }),
          activeSeed.documentId,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleDocumentSourceContentRequest(
          new Request(`${baseUrl}/api/documents/${activeSeed.documentId}/source/content?token=invalid`, {
            headers: { Cookie: adminCookie },
          }),
          activeSeed.documentId,
        )
      ).status,
    ).toBe(403);
  });
});
