import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { and, asc, count, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { importPKCS8, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { initializeDocumentUpload, finalizeDocumentUpload, getDocumentUploadStatus } from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import { dispatchIngestionJobs, reconcileJobs } from "../../src/server/jobs/dispatch";
import { ingestionWorkflowVersion, type IngestionCallbackClaims, type IngestionCallbackPurpose } from "../../src/server/jobs/contracts";
import { signSourceRefToken } from "../../src/server/jobs/signatures";
import { handleIngestionStageRequest } from "../../src/server/ingestion/http";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
  failIngestionStage,
  renewSourceRefStage,
} from "../../src/server/ingestion/service";
import { seedSyntheticAccount, seedSyntheticSession } from "../fixtures/auth";
import { syntheticPdf, syntheticRichDocx } from "../fixtures/document-files";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });
const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
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
const callbackKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let owner: CurrentAccount;
let staff: CurrentAccount;

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

async function seedAcceptedDocument(
  bytes: Buffer,
  mimeType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
) {
  const storage = new MemoryStorage();
  const input = {
    requestKey: randomUUID(),
    title: "Synthetic Ingestion SOP",
    fileName: mimeType === "application/pdf" ? "synthetic-sop.pdf" : "synthetic-sop.docx",
    mimeType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const init = await initializeDocumentUpload(owner, input, database, storage, 1_000_000_000);
  const [intent] = await database.select().from(schema.documentUploadIntents).where(eq(schema.documentUploadIntents.id, init.document.id));
  storage.objects.set(intent.stagingKey, { bytes, contentType: mimeType });
  const accepted = await finalizeDocumentUpload(owner, intent.id, database, storage);
  await database.update(schema.workflowJobs).set({ dispatchCount: 1 }).where(eq(schema.workflowJobs.id, accepted.document.job!.id));
  const [job] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, accepted.document.job!.id));
  return { documentId: intent.id, job, storage };
}

function makeClaims(job: typeof schema.workflowJobs.$inferSelect, purpose: IngestionCallbackPurpose, executionId = "exec-s05"): IngestionCallbackClaims {
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
  let ocrCount = 0;
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/pdf/inspect-and-extract")) {
      return Response.json({
        result: "PASS",
        pageCount: 4,
        pages: [
          { pageIndex: 1, nativeText: "Section 1 Pre-Start\n1. Check interlock switch S-01.\n2. Confirm voltage 24.0 V DC.", imageCount: 0, maxImagePixels: 0 },
          { pageIndex: 2, nativeText: "", imageCount: 0, maxImagePixels: 0 },
          { pageIndex: 3, nativeText: "", imageCount: 1, maxImagePixels: 900_000 },
          { pageIndex: 4, nativeText: "Section 4 Diagram Check\nConfirm gauge needle inside green band.", imageCount: 1, maxImagePixels: 100_000 },
        ],
      });
    }
    if (url.includes("/pdf/render-page")) {
      return new Response(validPng, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (url.endsWith("/ocr")) {
      ocrCount++;
      const segments = ocrCount === 1
        ? [
            { order: 0, text: "Section 3 Purge Cycle", confidence: 0.94, box: [[0, 0], [100, 0], [100, 20], [0, 20]] },
            { order: 1, text: "Hold 3.25 bar for 12 minutes", confidence: 0.78, box: [[0, 30], [100, 30], [100, 50], [0, 50]] },
          ]
        : [
            { order: 0, text: "Confirm gauge needle inside green band.", confidence: 0.96, box: [[0, 0], [100, 0], [100, 20], [0, 20]] },
            { order: 1, text: "Max temp 80 C", confidence: 0.91, box: [[0, 30], [100, 30], [100, 50], [0, 50]] },
          ];
      return Response.json({
        result: "PASS",
        pipelineVersion: "paddleocr-v1",
        verificationStatus: "UNVERIFIED",
        input: { sha256: "b".repeat(64), width: 1000, height: 800 },
        models: { detection: "det", recognition: "rec" },
        segmentCount: segments.length,
        segments,
        text: segments.map((s) => s.text).join("\n"),
      });
    }
    throw new Error(`Unexpected worker URL: ${url}`);
  });
}

beforeAll(async () => {
  owner = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  staff = await seedSyntheticSession(database, await seedSyntheticAccount(database, "STAFF"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await connection.end();
});

describe("D3/ADR04/05/08/11/21/22 end-to-end ingestion persistence, embeddings and security", () => {
  it("processes native, blank, scanned and mixed PDF pages into unverified pgvector/tsvector artifacts without activating", async () => {
    const { documentId, job, storage } = await seedAcceptedDocument(syntheticPdf(), "application/pdf");
    const fetchImpl = pdfWorkerFetch();

    const claimed = await claimIngestionStage(makeClaims(job, "claim"), { database, privateKey: dispatchKeys.privateKey });
    expect(claimed).toMatchObject({ accepted: true, duplicate: false });
    expect(claimed.fileRefToken).toBeTruthy();

    const extracted = await extractIngestionStage(makeClaims(job, "extract"), claimed.fileRefToken, {
      database,
      storage,
      fetchImpl,
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    });
    expect(extracted).toMatchObject({ accepted: true, duplicate: false, pageCount: 4, hasPreview: false });

    const chunked = await chunkIngestionStage(makeClaims(job, "chunk"), { database });
    expect(chunked).toMatchObject({ accepted: true, duplicate: false });
    expect(chunked.chunkCount).toBeGreaterThanOrEqual(3);

    const embedded = await embedIngestionStage(makeClaims(job, "embed"), { database, env: workerEnv });
    expect(embedded).toMatchObject({
      accepted: true,
      duplicate: false,
      embeddingModel: "text-embedding-3-small",
      embeddingDimensions: 1536,
    });

    const completed = await completeIngestionStage(makeClaims(job, "complete"), { database });
    expect(completed).toMatchObject({ accepted: true, duplicate: false, status: "PENDING_VERIFICATION" });

    // Duplicate completion callback with fresh nonce is idempotent and does not duplicate chunks.
    expect(await completeIngestionStage(makeClaims(job, "complete"), { database })).toMatchObject({ accepted: true, duplicate: true });

    const [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, documentId));
    expect(doc.status).toBe("PENDING_VERIFICATION");
    expect(doc.processedJobId).toBe(job.id);
    expect(doc.processedPipelineVersion).toBe(job.pipelineVersion);

    const pages = await database
      .select()
      .from(schema.sopExtractionPages)
      .where(eq(schema.sopExtractionPages.jobId, job.id))
      .orderBy(asc(schema.sopExtractionPages.pageIndex));
    expect(pages.map((page) => page.pageKind)).toEqual(["native", "blank", "scanned_ocr", "mixed_ocr"]);
    expect(pages.every((page) => page.verificationStatus === "UNVERIFIED")).toBe(true);

    const chunks = await database
      .select()
      .from(schema.sopChunks)
      .where(eq(schema.sopChunks.jobId, job.id))
      .orderBy(asc(schema.sopChunks.sequence));
    expect(chunks.length).toBe(chunked.chunkCount);
    expect(chunks.every((chunk) => chunk.pageStart !== null && chunk.pageEnd !== null && chunk.embeddingDimensions === 1536)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("24.0 V DC");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("3.25 bar for 12 minutes");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("Max temp 80 C");

    // Verify pgvector 1536 dimensions and generated tsvector full-text index in PostgreSQL.
    const [vectorCheck] = await connection`
      select count(*)::int as total, min(vector_dims(embedding))::int as dims
      from app.sop_chunks where job_id = ${job.id} and embedding is not null
    `;
    expect(vectorCheck).toEqual({ total: chunks.length, dims: 1536 });

    const [ftsCheck] = await connection`
      select count(*)::int as matches
      from app.sop_chunks
      where job_id = ${job.id} and search_vector @@ plainto_tsquery('simple', '3.25 bar')
    `;
    expect(ftsCheck.matches).toBeGreaterThanOrEqual(1);

    const status = await getDocumentUploadStatus(owner, documentId, database);
    expect(status.document).toMatchObject({
      status: "PENDING_VERIFICATION",
      summary: { pageCount: 4, chunkCount: chunks.length, hasPreview: false },
      job: { id: job.id, state: "COMPLETED", stage: "complete" },
    });
    expect(JSON.stringify(status)).not.toMatch(/originals\/|previews\//);
    await expect(getDocumentUploadStatus(staff, documentId, database)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("extracts DOCX natively, stores private PDF preview and omits page numbers on DOCX chunks", async () => {
    const docxBytes = syntheticRichDocx();
    const previewPdf = syntheticPdf();
    const { documentId, job, storage } = await seedAcceptedDocument(
      docxBytes,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/convert/docx-to-pdf")) {
        return new Response(new Uint8Array(previewPdf), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      if (url.endsWith("/pdf/inspect-and-extract")) {
        return Response.json({ result: "PASS", pageCount: 1, pages: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const claimed = await claimIngestionStage(makeClaims(job, "claim"), { database, privateKey: dispatchKeys.privateKey });
    const extracted = await extractIngestionStage(makeClaims(job, "extract"), claimed.fileRefToken, {
      database,
      storage,
      fetchImpl,
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    });
    expect(extracted).toMatchObject({ accepted: true, hasPreview: true, pageCount: 1 });
    await chunkIngestionStage(makeClaims(job, "chunk"), { database });
    await embedIngestionStage(makeClaims(job, "embed"), { database, env: workerEnv });
    await completeIngestionStage(makeClaims(job, "complete"), { database });

    const [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, documentId));
    expect(doc.previewKey).toBe(`previews/${documentId}/${job.id}.pdf`);
    expect(storage.objects.has(doc.previewKey!)).toBe(true);

    const chunks = await database.select().from(schema.sopChunks).where(eq(schema.sopChunks.jobId, job.id));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.every((chunk) => chunk.pageStart === null && chunk.pageEnd === null)).toBe(true);
    expect(chunks[0].sectionPath).toBe("Section 1 Valve Calibration");
    expect(chunks.map((c) => c.text).join("\n")).toContain("| Pressure | 2.75 bar |");

    const issues = await database.select().from(schema.sopVerificationIssues).where(eq(schema.sopVerificationIssues.jobId, job.id));
    expect(issues.map((issue) => issue.issueCode)).toEqual(expect.arrayContaining(["DOCX_PREVIEW_PAGINATION_NOTE", "TABLE_STRUCTURE_REVIEW"]));

    const status = await getDocumentUploadStatus(owner, documentId, database);
    expect(status.document.summary?.hasPreview).toBe(true);
    expect(JSON.stringify(status)).not.toContain("previews/");
  });

  it("rejects expired fileRefToken, renews only via authenticated renew-source-ref and prevents nonce replay", async () => {
    const { job, storage } = await seedAcceptedDocument(syntheticPdf(), "application/pdf");
    const claimed = await claimIngestionStage(makeClaims(job, "claim"), { database, privateKey: dispatchKeys.privateKey });

    const expiredToken = await new SignJWT({
      v: 1,
      iss: "sop-app",
      aud: "sop-app-source-ref",
      purpose: "source_read",
      jobId: job.id,
      documentId: job.documentId!,
      sourceSha256: job.sourceSha256!,
      attemptId: job.attemptId,
      executionId: "exec-s05",
      jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000) - 60,
      nbf: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) - 15,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .sign(await importPKCS8(dispatchKeys.privateKey, "RS256"));

    await expect(
      extractIngestionStage(makeClaims(job, "extract"), expiredToken, {
        database,
        storage,
        fetchImpl: pdfWorkerFetch(),
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_REF_EXPIRED", status: 401 });

    const wrongExecToken = await signSourceRefToken(
      { jobId: job.id, documentId: job.documentId!, sourceSha256: job.sourceSha256!, attemptId: job.attemptId, executionId: "other-exec" },
      dispatchKeys.privateKey,
    );
    await expect(
      extractIngestionStage(makeClaims(job, "extract"), wrongExecToken, {
        database,
        storage,
        fetchImpl: pdfWorkerFetch(),
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE_REF", status: 403 });

    const renewed = await renewSourceRefStage(makeClaims(job, "renew-source-ref"), { database, privateKey: dispatchKeys.privateKey });
    expect(renewed.accepted).toBe(true);
    expect(renewed.fileRefToken).not.toBe(claimed.fileRefToken);

    const extractClaims = makeClaims(job, "extract");
    await expect(
      extractIngestionStage(extractClaims, renewed.fileRefToken, {
        database,
        storage,
        fetchImpl: pdfWorkerFetch(),
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).resolves.toMatchObject({ accepted: true, duplicate: false });

    await expect(
      extractIngestionStage(extractClaims, renewed.fileRefToken, {
        database,
        storage,
        fetchImpl: pdfWorkerFetch(),
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_REPLAY", status: 409 });
  });

  it("handles transient vs permanent failures, bounded retries, timeout reconciliation and Admin retry without duplicate chunks", async () => {
    const { documentId, job, storage } = await seedAcceptedDocument(syntheticPdf(), "application/pdf");

    const claimed1 = await claimIngestionStage(makeClaims(job, "claim"), { database, privateKey: dispatchKeys.privateKey });
    const transientFetch = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
    await expect(
      extractIngestionStage(makeClaims(job, "extract"), claimed1.fileRefToken, {
        database,
        storage,
        fetchImpl: transientFetch,
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).rejects.toMatchObject({ code: "PDF_INSPECT_TRANSIENT", status: 503 });

    const [attempt2] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    expect(attempt2).toMatchObject({ state: "QUEUED", attemptNumber: 2 });
    expect(attempt2.attemptId).not.toBe(job.attemptId);

    const sentTokens: string[] = [];
    await database
      .update(schema.workflowJobs)
      .set({ dispatchNextAt: new Date(Date.now() + 60_000) })
      .where(and(eq(schema.workflowJobs.kind, "document_ingestion"), eq(schema.workflowJobs.state, "QUEUED"), ne(schema.workflowJobs.id, job.id)));
    await database.update(schema.workflowJobs).set({ dispatchNextAt: new Date(0) }).where(eq(schema.workflowJobs.id, job.id));
    await dispatchIngestionJobs(
      database,
      vi.fn<typeof fetch>(async (_url, init) => {
        sentTokens.push(String((init?.headers as Record<string, string>)?.Authorization));
        return new Response("{}", { status: 200 });
      }),
      async () => "synthetic-dispatch-jwt",
      "http://n8n-main:5678/webhook/sop-s05-ingestion-v1",
    );
    expect(sentTokens).toHaveLength(1);

    const [dispatched2] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    await claimIngestionStage(makeClaims(dispatched2, "claim", "exec-2"), { database, privateKey: dispatchKeys.privateKey });
    await failIngestionStage(makeClaims(dispatched2, "fail", "exec-2"), { errorCode: "OCR_PAGE_FAILED", transient: false }, { database });

    const [failedDoc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, documentId));
    expect(failedDoc).toMatchObject({ status: "FAILED", processingErrorCode: "OCR_PAGE_FAILED" });

    // R-S05b-3 / Q-S05b-4: duplicate claim on a terminal FAILED job rejects and keeps runLeaseUntil null.
    await expect(
      claimIngestionStage(makeClaims(dispatched2, "claim", "exec-2"), { database, privateKey: dispatchKeys.privateKey }),
    ).rejects.toMatchObject({ code: "INVALID_WORKFLOW_STATE", status: 409 });
    const [failedJobAfterClaim] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    expect(failedJobAfterClaim.runLeaseUntil).toBeNull();

    const retried = await finalizeDocumentUpload(owner, documentId, database, storage);
    expect(retried.created).toBe(false);
    expect(retried.document).toMatchObject({ status: "UPLOADED", processingErrorCode: null, job: { id: job.id, state: "QUEUED", attemptNumber: 1 } });

    for (let attempt = 1; attempt <= 3; attempt++) {
      await database.update(schema.workflowJobs).set({ attemptDeadline: new Date(0) }).where(eq(schema.workflowJobs.id, job.id));
      await reconcileJobs(database);
    }
    const [timedOutJob] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    const [timedOutDoc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, documentId));
    expect(timedOutJob).toMatchObject({ state: "FAILED", errorCode: "INGESTION_TIMEOUT", attemptNumber: 3 });
    expect(timedOutDoc).toMatchObject({ status: "FAILED", processingErrorCode: "INGESTION_TIMEOUT" });

    await finalizeDocumentUpload(owner, documentId, database, storage);
    await database.update(schema.workflowJobs).set({ dispatchCount: 1 }).where(eq(schema.workflowJobs.id, job.id));
    const [freshJob] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    const claimedFinal = await claimIngestionStage(makeClaims(freshJob, "claim", "exec-final"), { database, privateKey: dispatchKeys.privateKey });
    await expect(
      claimIngestionStage(makeClaims(freshJob, "claim", "exec-final"), { database, privateKey: dispatchKeys.privateKey }),
    ).resolves.toMatchObject({ accepted: true, duplicate: true });
    await extractIngestionStage(makeClaims(freshJob, "extract", "exec-final"), claimedFinal.fileRefToken, {
      database,
      storage,
      fetchImpl: pdfWorkerFetch(),
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    });
    await expect(
      extractIngestionStage(makeClaims(freshJob, "extract", "exec-final"), claimedFinal.fileRefToken, {
        database,
        storage,
        fetchImpl: pdfWorkerFetch(),
        env: workerEnv,
        privateKey: dispatchKeys.privateKey,
      }),
    ).resolves.toMatchObject({ accepted: true, duplicate: true });
    const chunkedFinal = await chunkIngestionStage(makeClaims(freshJob, "chunk", "exec-final"), { database });
    await expect(chunkIngestionStage(makeClaims(freshJob, "chunk", "exec-final"), { database })).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
    });
    await embedIngestionStage(makeClaims(freshJob, "embed", "exec-final"), { database, env: workerEnv });
    await expect(embedIngestionStage(makeClaims(freshJob, "embed", "exec-final"), { database, env: workerEnv })).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
    });
    await completeIngestionStage(makeClaims(freshJob, "complete", "exec-final"), { database });

    // R-S05b-3 / Q-S05b-4: duplicate claim on a terminal COMPLETED job rejects and keeps runLeaseUntil null.
    await expect(
      claimIngestionStage(makeClaims(freshJob, "claim", "exec-final"), { database, privateKey: dispatchKeys.privateKey }),
    ).rejects.toMatchObject({ code: "INVALID_WORKFLOW_STATE", status: 409 });
    const [completedJob] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));
    expect(completedJob.runLeaseUntil).toBeNull();

    const [chunkTotal] = await database.select({ total: count() }).from(schema.sopChunks).where(eq(schema.sopChunks.jobId, job.id));
    expect(chunkTotal.total).toBe(chunkedFinal.chunkCount);
  });

  it("handles NO_EXTRACTABLE_TEXT and embedding transient retry / permanent failure transitions cleanly", async () => {
    const blankSeed = await seedAcceptedDocument(syntheticPdf(), "application/pdf");
    const blankClaim = await claimIngestionStage(makeClaims(blankSeed.job, "claim", "exec-blank"), {
      database,
      privateKey: dispatchKeys.privateKey,
    });
    await extractIngestionStage(makeClaims(blankSeed.job, "extract", "exec-blank"), blankClaim.fileRefToken, {
      database,
      storage: blankSeed.storage,
      fetchImpl: vi.fn<typeof fetch>(async () =>
        Response.json({ result: "PASS", pageCount: 1, pages: [{ pageIndex: 1, nativeText: "   ", imageCount: 0, maxImagePixels: 0 }] }),
      ),
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    });
    await expect(chunkIngestionStage(makeClaims(blankSeed.job, "chunk", "exec-blank"), { database })).rejects.toMatchObject({
      code: "NO_EXTRACTABLE_TEXT",
      status: 422,
    });
    const [blankJob] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, blankSeed.job.id));
    const [blankDoc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, blankSeed.documentId));
    expect(blankJob).toMatchObject({ state: "FAILED", errorCode: "NO_EXTRACTABLE_TEXT" });
    expect(blankDoc).toMatchObject({ status: "FAILED", processingErrorCode: "NO_EXTRACTABLE_TEXT" });

    const embedSeed = await seedAcceptedDocument(syntheticPdf(), "application/pdf");
    const embedClaim1 = await claimIngestionStage(makeClaims(embedSeed.job, "claim", "exec-emb-1"), {
      database,
      privateKey: dispatchKeys.privateKey,
    });
    await extractIngestionStage(makeClaims(embedSeed.job, "extract", "exec-emb-1"), embedClaim1.fileRefToken, {
      database,
      storage: embedSeed.storage,
      fetchImpl: pdfWorkerFetch(),
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    });
    await chunkIngestionStage(makeClaims(embedSeed.job, "chunk", "exec-emb-1"), { database });
    await expect(
      embedIngestionStage(makeClaims(embedSeed.job, "embed", "exec-emb-1"), {
        database,
        env: { OPENAI_API_KEY: "sk-synthetic" },
        fetchImpl: vi.fn<typeof fetch>(async () => new Response("rate limit", { status: 429 })),
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_PROVIDER_TRANSIENT", status: 503 });

    const [embedAttempt2] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, embedSeed.job.id));
    expect(embedAttempt2).toMatchObject({ state: "QUEUED", attemptNumber: 2, errorCode: "EMBEDDING_PROVIDER_TRANSIENT" });

    await database.update(schema.workflowJobs).set({ dispatchCount: 1 }).where(eq(schema.workflowJobs.id, embedAttempt2.id));
    const [embedDispatched2] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, embedAttempt2.id));
    const embedClaim2 = await claimIngestionStage(makeClaims(embedDispatched2, "claim", "exec-emb-2"), {
      database,
      privateKey: dispatchKeys.privateKey,
    });
    await extractIngestionStage(makeClaims(embedDispatched2, "extract", "exec-emb-2"), embedClaim2.fileRefToken, {
      database,
      storage: embedSeed.storage,
      fetchImpl: pdfWorkerFetch(),
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    });
    await chunkIngestionStage(makeClaims(embedDispatched2, "chunk", "exec-emb-2"), { database });
    await expect(
      embedIngestionStage(makeClaims(embedDispatched2, "embed", "exec-emb-2"), {
        database,
        env: { OPENAI_API_KEY: "sk-synthetic" },
        fetchImpl: vi.fn<typeof fetch>(async () => new Response("bad key", { status: 401 })),
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_PROVIDER_REJECTED", status: 422 });

    const [embedFailedJob] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, embedAttempt2.id));
    const [embedFailedDoc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, embedSeed.documentId));
    expect(embedFailedJob).toMatchObject({ state: "FAILED", errorCode: "EMBEDDING_PROVIDER_REJECTED" });
    expect(embedFailedDoc).toMatchObject({ status: "FAILED", processingErrorCode: "EMBEDDING_PROVIDER_REJECTED" });
  });

  it("enforces DB invariants (no ACTIVE status, immutable originals, bound artifacts/issues) and raw HTTP callback boundary", async () => {
    const { documentId, job } = await seedAcceptedDocument(syntheticPdf(), "application/pdf");
    const otherDoc = await seedAcceptedDocument(syntheticPdf(), "application/pdf");

    await expect(connection`update app.sop_documents set status = 'ACTIVE' where id = ${documentId}`).rejects.toMatchObject({ code: "23514" });
    await expect(connection`update app.sop_documents set sha256 = ${"0".repeat(64)} where id = ${documentId}`).rejects.toMatchObject({ code: "42501" });
    await expect(
      database.insert(schema.sopExtractionPages).values({
        documentId,
        jobId: job.id,
        sourceSha256: "0".repeat(64),
        pipelineVersion: job.pipelineVersion!,
        pageIndex: 1,
        pageKind: "native",
        sourceLocationKind: "pdf_page",
        rawText: "forged",
        normalizedText: "forged",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      database.insert(schema.sopVerificationIssues).values({
        documentId: otherDoc.documentId,
        jobId: job.id,
        pageIndex: 1,
        sectionPath: null,
        severity: "warning",
        issueCode: "FORGED_ISSUE",
        summary: "Mismatched document/job binding",
        region: null,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      connection`
        insert into app.sop_extraction_pages (document_id, job_id, source_sha256, pipeline_version, page_index, page_kind, source_location_kind, raw_text, normalized_text, verification_status)
        values (${documentId}, ${job.id}, ${job.sourceSha256!}, ${job.pipelineVersion!}, 1, 'native', 'pdf_page', 'a', 'a', 'VERIFIED')
      `,
    ).rejects.toMatchObject({ code: "23514" });

    vi.stubEnv("WORKFLOW_CALLBACK_PUBLIC_KEY", callbackKeys.publicKey);
    vi.stubEnv("WORKFLOW_CALLBACK_PUBLIC_KEY_FILE", "");
    vi.stubEnv("WORKFLOW_DISPATCH_PRIVATE_KEY", dispatchKeys.privateKey);
    vi.stubEnv("WORKFLOW_DISPATCH_PRIVATE_KEY_FILE", "");

    const claim = makeClaims(job, "claim", "exec-http");
    const token = await new SignJWT(claim)
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .sign(await importPKCS8(callbackKeys.privateKey, "RS256"));

    const buildRequest = (body: string, path = claim.path, contentType = "application/json", auth = `Bearer ${token}`) =>
      new Request(`http://app:3000${path}`, {
        method: "POST",
        headers: { "content-type": contentType, ...(auth ? { authorization: auth } : {}) },
        body,
      });

    expect((await handleIngestionStageRequest(buildRequest("{}", claim.path, "text/plain"), job.id, "claim", { database })).status).toBe(415);
    expect((await handleIngestionStageRequest(buildRequest('{"extra":1}'), job.id, "claim", { database })).status).toBe(400);
    expect((await handleIngestionStageRequest(buildRequest("{}", claim.path, "application/json", ""), job.id, "claim", { database })).status).toBe(401);
    expect((await handleIngestionStageRequest(buildRequest("{}", `/api/internal/ingestion/${job.id}/chunk`), job.id, "chunk", { database })).status).toBe(403);
    expect((await handleIngestionStageRequest(buildRequest("{}"), job.id, "claim", { database })).status).toBe(200);
    expect((await handleIngestionStageRequest(buildRequest("{}"), job.id, "claim", { database })).status).toBe(409);
  });
});
