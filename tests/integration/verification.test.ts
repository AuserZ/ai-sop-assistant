import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { importPKCS8, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { authConfiguration } from "../../src/server/auth/config";
import { handleAuthentication } from "../../src/server/auth/handler";
import { finalizeDocumentUpload, initializeDocumentUpload } from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import { ingestionWorkflowVersion, type IngestionCallbackClaims, type IngestionCallbackPurpose } from "../../src/server/jobs/contracts";
import { signSourceRefToken } from "../../src/server/jobs/signatures";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
} from "../../src/server/ingestion/service";
import { handleVerificationRequest } from "../../src/server/verification/http";
import { getDocumentReview, readDocumentPreview, reprocessDocument, verifyDocument } from "../../src/server/verification/service";
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
const workerKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let uploaderAdmin: CurrentAccount;
let reviewerAdmin: CurrentAccount;
let staffAccount: CurrentAccount;

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
}

function makeClaims(
  job: typeof schema.workflowJobs.$inferSelect,
  purpose: IngestionCallbackPurpose,
  executionId = "exec-s06",
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

function nativePdfWorkerFetch(): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/pdf/inspect-and-extract")) {
      return Response.json({
        result: "PASS",
        pageCount: 2,
        pages: [
          {
            pageIndex: 1,
            nativeText: "Section 1 Lockout\n1. Set breaker to OFF.\n2. Confirm 0.00 V and 2.5 bar max.\n| Parameter | Limit |\n| --- | --- |\n| Pressure | 2.5 bar |",
            imageCount: 0,
            maxImagePixels: 0,
          },
          {
            pageIndex: 2,
            nativeText: "   ",
            imageCount: 0,
            maxImagePixels: 0,
          },
        ],
      });
    }
    throw new Error(`Unexpected worker URL: ${url}`);
  });
}

function docxWorkerFetch(previewPdf: Buffer): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/convert/docx-to-pdf")) {
      return new Response(new Uint8Array(previewPdf), { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (url.endsWith("/pdf/inspect-and-extract")) {
      return Response.json({ result: "PASS", pageCount: 1, pages: [] });
    }
    throw new Error(`Unexpected worker URL: ${url}`);
  });
}

async function runIngestionToPendingVerification(
  documentId: string,
  storage: MemoryStorage,
  fetchImpl: typeof fetch = nativePdfWorkerFetch(),
  executionId = `exec-${randomUUID().slice(0, 8)}`,
) {
  const [job] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.documentId, documentId));
  await database.update(schema.workflowJobs).set({ dispatchCount: 1 }).where(eq(schema.workflowJobs.id, job.id));
  const [dispatched] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));

  const claimed = await claimIngestionStage(makeClaims(dispatched, "claim", executionId), {
    database,
    privateKey: dispatchKeys.privateKey,
  });
  await extractIngestionStage(makeClaims(dispatched, "extract", executionId), claimed.fileRefToken, {
    database,
    storage,
    fetchImpl,
    env: workerEnv,
    privateKey: dispatchKeys.privateKey,
  });
  await chunkIngestionStage(makeClaims(dispatched, "chunk", executionId), { database });
  await embedIngestionStage(makeClaims(dispatched, "embed", executionId), { database, env: workerEnv });
  await completeIngestionStage(makeClaims(dispatched, "complete", executionId), { database });
  const [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, documentId));
  return { doc, job: dispatched, executionId };
}

async function seedPendingVerificationDocument(
  kind: "pdf" | "docx" = "pdf",
) {
  const storage = new MemoryStorage();
  const bytes = kind === "pdf" ? syntheticPdf() : syntheticRichDocx();
  const mimeType =
    kind === "pdf"
      ? ("application/pdf" as const)
      : ("application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const);
  const input = {
    requestKey: randomUUID(),
    title: kind === "pdf" ? "Synthetic S06 PDF SOP" : "Synthetic S06 DOCX SOP",
    fileName: kind === "pdf" ? "synthetic-s06.pdf" : "synthetic-s06.docx",
    mimeType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const init = await initializeDocumentUpload(uploaderAdmin, input, database, storage, 1_000_000_000);
  const [intent] = await database.select().from(schema.documentUploadIntents).where(eq(schema.documentUploadIntents.id, init.document.id));
  storage.objects.set(intent.stagingKey, { bytes, contentType: mimeType });
  await finalizeDocumentUpload(uploaderAdmin, intent.id, database, storage);
  const previewPdf = syntheticPdf();
  const { doc, job, executionId } = await runIngestionToPendingVerification(
    intent.id,
    storage,
    kind === "pdf" ? nativePdfWorkerFetch() : docxWorkerFetch(previewPdf),
  );
  return { documentId: intent.id, doc, job, storage, bytes, previewPdf, executionId };
}

beforeAll(async () => {
  uploaderAdmin = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  reviewerAdmin = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  staffAccount = await seedSyntheticSession(database, await seedSyntheticAccount(database, "STAFF"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database.update(schema.authUsers).set({ role: "ADMIN", active: true }).where(eq(schema.authUsers.id, reviewerAdmin.id));
  reviewerAdmin = await seedSyntheticSession(database, { id: reviewerAdmin.id, email: reviewerAdmin.email, role: "ADMIN" });
});

afterAll(async () => {
  await connection.end();
});

describe("S06/ADR17 assisted verification, atomic activation and DB invariants", () => {
  it("allows another Admin to review, resolve issues, stream previews and atomically activate a valid snapshot", async () => {
    const { documentId, doc, job, storage, bytes, executionId } = await seedPendingVerificationDocument("pdf");
    const review = await getDocumentReview(reviewerAdmin, documentId, database);
    expect(review.document).toMatchObject({
      id: documentId,
      status: "PENDING_VERIFICATION",
      processedJobId: job.id,
      processedAttemptId: job.attemptId,
      hasPreview: true,
      previewUrl: `/api/documents/${documentId}/preview?v=${encodeURIComponent(job.attemptId)}`,
    });
    expect(JSON.stringify(review)).not.toMatch(/originals\/|previews\//);
    expect(review.pages).toHaveLength(2);
    expect(review.chunks.length).toBeGreaterThanOrEqual(1);
    expect(review.issues.length).toBeGreaterThanOrEqual(1);

    const preview = await readDocumentPreview(reviewerAdmin, documentId, database, storage);
    expect(preview.bytes).toEqual(bytes);

    const docxSeed = await seedPendingVerificationDocument("docx");
    const docxPreview = await readDocumentPreview(reviewerAdmin, docxSeed.documentId, database, docxSeed.storage);
    expect(docxPreview.bytes).toEqual(docxSeed.previewPdf);
    await database.update(schema.sopDocuments).set({ previewKey: null }).where(eq(schema.sopDocuments.id, docxSeed.documentId));
    await expect(readDocumentPreview(reviewerAdmin, docxSeed.documentId, database, docxSeed.storage)).rejects.toMatchObject({
      code: "PREVIEW_NOT_AVAILABLE",
      status: 404,
    });

    const resolvedIds = review.issues.map((issue) => issue.id);
    const verified = await verifyDocument(
      reviewerAdmin,
      documentId,
      {
        decision: "APPROVE",
        expectedSha256: doc.sha256,
        expectedJobId: job.id,
        expectedPipelineVersion: doc.processedPipelineVersion!,
        expectedAttemptId: job.attemptId,
        explicitConfirmation: true,
        notes: "Verified numbers, units, and blank page note against PDF preview.",
        resolvedIssueIds: resolvedIds,
      },
      database,
    );

    expect(verified.document).toMatchObject({
      status: "ACTIVE",
      activeJobId: job.id,
      activePipelineVersion: doc.processedPipelineVersion,
      activeAttemptId: job.attemptId,
      verifiedBy: reviewerAdmin.id,
      rejectionReason: null,
    });
    expect(verified.record).toMatchObject({
      decision: "APPROVED",
      attemptId: job.attemptId,
      beforeStatus: "PENDING_VERIFICATION",
      afterStatus: "ACTIVE",
      reviewerId: reviewerAdmin.id,
      issueSummary: { total: resolvedIds.length, resolved: resolvedIds.length, unresolved: 0 },
    });
    expect(verified.pages.every((page) => page.verificationStatus === "APPROVED")).toBe(true);
    expect(verified.issues.every((issue) => issue.resolvedAt !== null && issue.resolvedBy === reviewerAdmin.id)).toBe(true);

    const [audit] = await database
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.targetId, documentId), eq(schema.auditEvents.action, "document.verification_approved")));
    expect(audit).toMatchObject({ actorId: reviewerAdmin.id, outcome: "active" });

    await expect(
      reprocessDocument(reviewerAdmin, documentId, { expectedSha256: doc.sha256 }, database),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_ACTIVE", status: 409 });

    // Defense-in-depth: ingestion stage callbacks cannot mutate an already-ACTIVE document.
    await database
      .update(schema.workflowJobs)
      .set({ state: "RUNNING", step: 1, runLeaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(schema.workflowJobs.id, job.id));
    const [tamperedJob1] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    const refToken = await signSourceRefToken(
      {
        jobId: tamperedJob1.id,
        documentId,
        sourceSha256: doc.sha256,
        attemptId: tamperedJob1.attemptId,
        executionId,
      },
      dispatchKeys.privateKey,
    );
    await expect(
      extractIngestionStage(makeClaims(tamperedJob1, "extract", executionId), refToken, {
        database,
        storage,
        fetchImpl: nativePdfWorkerFetch(),
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_ACTIVE", status: 409 });

    await database.update(schema.workflowJobs).set({ step: 4 }).where(eq(schema.workflowJobs.id, job.id));
    const [tamperedJob4] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    await expect(
      completeIngestionStage(makeClaims(tamperedJob4, "complete", executionId), { database }),
    ).rejects.toMatchObject({ code: "DOCUMENT_ALREADY_ACTIVE", status: 409 });
  });

  it("rotates attemptId on reprocess, rejects pre-reprocess attemptId/issues and requires renewed verification", async () => {
    const { documentId, doc, job, storage } = await seedPendingVerificationDocument();
    const initialReview = await getDocumentReview(reviewerAdmin, documentId, database);
    const staleAttemptId = initialReview.document.processedAttemptId!;
    const staleIssueIds = initialReview.issues.map((issue) => issue.id);

    const rejected = await verifyDocument(
      reviewerAdmin,
      documentId,
      {
        decision: "REJECT",
        expectedSha256: doc.sha256,
        expectedJobId: job.id,
        expectedPipelineVersion: doc.processedPipelineVersion!,
        expectedAttemptId: staleAttemptId,
        explicitConfirmation: true,
        notes: "Page 1 table unit requires manual check before activation.",
      },
      database,
    );
    expect(rejected.document).toMatchObject({
      status: "REJECTED",
      activeJobId: null,
      activeAttemptId: null,
      rejectionReason: "Page 1 table unit requires manual check before activation.",
    });
    expect(rejected.pages.every((page) => page.verificationStatus === "REJECTED")).toBe(true);
    expect(rejected.verificationHistory).toHaveLength(1);

    const reprocessed = await reprocessDocument(
      reviewerAdmin,
      documentId,
      { expectedSha256: doc.sha256, notes: "Re-running extraction after review." },
      database,
    );
    expect(reprocessed.document).toMatchObject({
      status: "UPLOADED",
      processedJobId: null,
      processedAttemptId: null,
      activeJobId: null,
      activeAttemptId: null,
      verifiedBy: null,
      verifiedAt: null,
      rejectionReason: null,
    });
    expect(reprocessed.pages).toHaveLength(0);
    expect(reprocessed.chunks).toHaveLength(0);
    expect(reprocessed.verificationHistory).toHaveLength(1);

    await expect(
      verifyDocument(
        reviewerAdmin,
        documentId,
        {
          decision: "APPROVE",
          expectedSha256: doc.sha256,
          expectedJobId: job.id,
          expectedPipelineVersion: doc.processedPipelineVersion!,
          expectedAttemptId: staleAttemptId,
          explicitConfirmation: true,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_STATE_CONFLICT", status: 409 });

    const renewed = await runIngestionToPendingVerification(documentId, storage);
    expect(renewed.doc.processedAttemptId).not.toBe(staleAttemptId);

    // Pre-reprocess attemptId must be rejected even though jobId/sha256/pipelineVersion match.
    await expect(
      verifyDocument(
        reviewerAdmin,
        documentId,
        {
          decision: "APPROVE",
          expectedSha256: renewed.doc.sha256,
          expectedJobId: renewed.job.id,
          expectedPipelineVersion: renewed.doc.processedPipelineVersion!,
          expectedAttemptId: staleAttemptId,
          explicitConfirmation: true,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_STALE_SNAPSHOT", status: 409 });

    // Stale pre-reprocess resolvedIssueIds are also rejected against the renewed attempt.
    await expect(
      verifyDocument(
        reviewerAdmin,
        documentId,
        {
          decision: "APPROVE",
          expectedSha256: renewed.doc.sha256,
          expectedJobId: renewed.job.id,
          expectedPipelineVersion: renewed.doc.processedPipelineVersion!,
          expectedAttemptId: renewed.doc.processedAttemptId!,
          explicitConfirmation: true,
          resolvedIssueIds: staleIssueIds,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_STALE_SNAPSHOT", status: 409 });

    const approved = await verifyDocument(
      reviewerAdmin,
      documentId,
      {
        decision: "APPROVE",
        expectedSha256: renewed.doc.sha256,
        expectedJobId: renewed.job.id,
        expectedPipelineVersion: renewed.doc.processedPipelineVersion!,
        expectedAttemptId: renewed.doc.processedAttemptId!,
        explicitConfirmation: true,
        notes: "Renewed snapshot matches original PDF.",
      },
      database,
    );
    expect(approved.document).toMatchObject({ status: "ACTIVE", activeAttemptId: renewed.doc.processedAttemptId });
    expect(approved.verificationHistory).toHaveLength(2);
    expect(approved.verificationHistory.map((entry) => entry.decision)).toEqual(["APPROVED", "REJECTED"]);
  });

  it("rejects stale snapshots, incomplete artifacts, concurrent changed-state decisions and rolls back atomically on failure", async () => {
    const staleCase = await seedPendingVerificationDocument();
    const validBody = {
      decision: "APPROVE" as const,
      expectedSha256: staleCase.doc.sha256,
      expectedJobId: staleCase.job.id,
      expectedPipelineVersion: staleCase.doc.processedPipelineVersion!,
      expectedAttemptId: staleCase.doc.processedAttemptId!,
      explicitConfirmation: true as const,
    };

    await expect(verifyDocument(reviewerAdmin, staleCase.documentId, { ...validBody, expectedSha256: "0".repeat(64) }, database)).rejects.toMatchObject({
      code: "VERIFICATION_STALE_SNAPSHOT",
      status: 409,
    });
    await expect(verifyDocument(reviewerAdmin, staleCase.documentId, { ...validBody, expectedJobId: randomUUID() }, database)).rejects.toMatchObject({
      code: "VERIFICATION_STALE_SNAPSHOT",
      status: 409,
    });
    await expect(
      verifyDocument(reviewerAdmin, staleCase.documentId, { ...validBody, expectedPipelineVersion: "other-v2" }, database),
    ).rejects.toMatchObject({ code: "VERIFICATION_STALE_SNAPSHOT", status: 409 });
    await expect(
      verifyDocument(reviewerAdmin, staleCase.documentId, { ...validBody, expectedAttemptId: randomUUID() }, database),
    ).rejects.toMatchObject({ code: "VERIFICATION_STALE_SNAPSHOT", status: 409 });

    await expect(
      verifyDocument(reviewerAdmin, staleCase.documentId, validBody, database, {
        beforeDocumentCommit: () => {
          throw new Error("Synthetic crash after record insert");
        },
      }),
    ).rejects.toThrow("Synthetic crash after record insert");
    const [afterRollbackDoc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, staleCase.documentId));
    const [afterRollbackRecords] = await database
      .select({ total: count() })
      .from(schema.sopVerificationRecords)
      .where(eq(schema.sopVerificationRecords.documentId, staleCase.documentId));
    expect(afterRollbackDoc.status).toBe("PENDING_VERIFICATION");
    expect(afterRollbackRecords.total).toBe(0);

    const concurrentOutcomes = await Promise.allSettled([
      verifyDocument(reviewerAdmin, staleCase.documentId, validBody, database),
      verifyDocument(
        uploaderAdmin,
        staleCase.documentId,
        { ...validBody, decision: "REJECT", notes: "Concurrent reject" },
        database,
      ),
    ]);
    expect(concurrentOutcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(concurrentOutcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const [concurrentRecords] = await database
      .select({ total: count() })
      .from(schema.sopVerificationRecords)
      .where(eq(schema.sopVerificationRecords.documentId, staleCase.documentId));
    expect(concurrentRecords.total).toBe(1);

    const incompleteCase = await seedPendingVerificationDocument();
    await database.update(schema.sopChunks).set({ embedding: null }).where(eq(schema.sopChunks.jobId, incompleteCase.job.id));
    await expect(
      verifyDocument(
        reviewerAdmin,
        incompleteCase.documentId,
        {
          decision: "APPROVE",
          expectedSha256: incompleteCase.doc.sha256,
          expectedJobId: incompleteCase.job.id,
          expectedPipelineVersion: incompleteCase.doc.processedPipelineVersion!,
          expectedAttemptId: incompleteCase.doc.processedAttemptId!,
          explicitConfirmation: true,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_INCOMPLETE_ARTIFACTS", status: 409 });

    await database.delete(schema.sopChunks).where(eq(schema.sopChunks.jobId, incompleteCase.job.id));
    await expect(
      verifyDocument(
        reviewerAdmin,
        incompleteCase.documentId,
        {
          decision: "APPROVE",
          expectedSha256: incompleteCase.doc.sha256,
          expectedJobId: incompleteCase.job.id,
          expectedPipelineVersion: incompleteCase.doc.processedPipelineVersion!,
          expectedAttemptId: incompleteCase.doc.processedAttemptId!,
          explicitConfirmation: true,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_INCOMPLETE_ARTIFACTS", status: 409 });
  });

  it("denies Staff, anonymous, n8n worker JWT, demoted Admin, revoked session and cross-origin mutations on HTTP verification routes", async () => {
    const { documentId, doc, job } = await seedPendingVerificationDocument();
    const base = authConfiguration().baseURL;
    const host = new URL(base).host;
    const verifyPayload = {
      decision: "APPROVE",
      expectedSha256: doc.sha256,
      expectedJobId: job.id,
      expectedPipelineVersion: doc.processedPipelineVersion!,
      expectedAttemptId: doc.processedAttemptId!,
      explicitConfirmation: true,
    };

    await expect(getDocumentReview(staffAccount, documentId, database)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await expect(verifyDocument(staffAccount, documentId, verifyPayload, database)).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    await database.update(schema.authUsers).set({ role: "STAFF" }).where(eq(schema.authUsers.id, reviewerAdmin.id));
    await expect(getDocumentReview(reviewerAdmin, documentId, database)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await database.update(schema.authUsers).set({ role: "ADMIN" }).where(eq(schema.authUsers.id, reviewerAdmin.id));
    await database.update(schema.authSessions).set({ expiresAt: new Date(0) }).where(eq(schema.authSessions.id, reviewerAdmin.sessionId));
    await expect(getDocumentReview(reviewerAdmin, documentId, database)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });

    expect(
      (await handleVerificationRequest(new Request(`${base}/api/documents/${documentId}/review`, { method: "GET", headers: { host } }), documentId, "review")).status,
    ).toBe(401);

    // Signed n8n worker Bearer JWT (no Admin session cookie) cannot activate a document.
    const workerToken = await new SignJWT(makeClaims(job, "complete", "exec-forged"))
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .sign(await importPKCS8(workerKeys.privateKey, "RS256"));
    expect(
      (
        await handleVerificationRequest(
          new Request(`${base}/api/documents/${documentId}/verify`, {
            method: "POST",
            headers: {
              host,
              origin: base,
              "content-type": "application/json",
              authorization: `Bearer ${workerToken}`,
            },
            body: JSON.stringify(verifyPayload),
          }),
          documentId,
          "verify",
        )
      ).status,
    ).toBe(401);

    expect(
      (
        await handleVerificationRequest(
          new Request(`${base}/api/documents/${documentId}/verify`, {
            method: "POST",
            headers: { host, origin: "https://evil.invalid", "content-type": "application/json" },
            body: JSON.stringify(verifyPayload),
          }),
          documentId,
          "verify",
        )
      ).status,
    ).toBe(403);

    const staffLogin = await handleAuthentication(
      new Request(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { host, origin: base, "content-type": "application/json" },
        body: JSON.stringify({ email: staffAccount.email, password: syntheticPassword }),
      }),
    );
    const staffCookie = staffLogin.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");

    expect(
      (
        await handleVerificationRequest(
          new Request(`${base}/api/documents/${documentId}/review`, { method: "GET", headers: { host, cookie: staffCookie } }),
          documentId,
          "review",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleVerificationRequest(
          new Request(`${base}/api/documents/${documentId}/preview`, { method: "GET", headers: { host, cookie: staffCookie } }),
          documentId,
          "preview",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleVerificationRequest(
          new Request(`${base}/api/documents/${documentId}/verify`, {
            method: "POST",
            headers: { host, origin: base, "content-type": "application/json", cookie: staffCookie },
            body: JSON.stringify(verifyPayload),
          }),
          documentId,
          "verify",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleVerificationRequest(
          new Request(`${base}/api/documents/${documentId}/reprocess`, {
            method: "POST",
            headers: { host, origin: base, "content-type": "application/json", cookie: staffCookie },
            body: JSON.stringify({ expectedSha256: doc.sha256 }),
          }),
          documentId,
          "reprocess",
        )
      ).status,
    ).toBe(403);
  });

  it("enforces PostgreSQL activation triggers, ACTIVE chunk/page immutability and append-only verification records under sop_runtime", async () => {
    const { documentId, doc, job } = await seedPendingVerificationDocument();

    await expect(
      connection`
        update app.sop_documents
        set status = 'ACTIVE',
            active_job_id = ${job.id},
            active_pipeline_version = ${doc.processedPipelineVersion!},
            active_attempt_id = ${doc.processedAttemptId!},
            verified_by = ${reviewerAdmin.id},
            verified_at = clock_timestamp()
        where id = ${documentId}
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      connection`
        insert into app.sop_verification_records
          (document_id, source_sha256, job_id, pipeline_version, attempt_id, reviewer_id, decision, notes, issue_summary, before_status, after_status)
        values
          (${documentId}, ${doc.sha256}, ${job.id}, ${doc.processedPipelineVersion!}, ${doc.processedAttemptId!}, ${staffAccount.id}, 'APPROVED', null, '{"total":0,"resolved":0,"unresolved":0,"bySeverity":{"error":0,"warning":0,"info":0}}'::jsonb, 'PENDING_VERIFICATION', 'ACTIVE')
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await verifyDocument(
      reviewerAdmin,
      documentId,
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

    await expect(
      connection`update app.sop_documents set status = 'UPLOADED', active_job_id = null, active_pipeline_version = null, active_attempt_id = null where id = ${documentId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection`update app.sop_documents set sha256 = ${"0".repeat(64)} where id = ${documentId}`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connection`update app.sop_chunks set text = 'tampered' where document_id = ${documentId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection`delete from app.sop_chunks where document_id = ${documentId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection`update app.sop_extraction_pages set normalized_text = 'tampered' where document_id = ${documentId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection`delete from app.sop_extraction_pages where document_id = ${documentId}`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection`update app.sop_verification_records set notes = 'tampered' where document_id = ${documentId}`,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      connection`delete from app.sop_verification_records where document_id = ${documentId}`,
    ).rejects.toMatchObject({ code: "42501" });
  });
});
