import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { authConfiguration } from "../../src/server/auth/config";
import { handleAuthentication } from "../../src/server/auth/handler";
import {
  signDocumentSourceToken,
  sourceLinkTtlSeconds,
} from "../../src/server/documents/contracts";
import {
  handleDocumentLibraryRequest,
  handleDocumentSourceContentRequest,
  handleDocumentSourceRequest,
} from "../../src/server/documents/http";
import {
  authorizeDocumentSource,
  finalizeDocumentUpload,
  initializeDocumentUpload,
  listDocuments,
  readDocumentSourceContent,
} from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import {
  ingestionWorkflowVersion,
  type IngestionCallbackClaims,
  type IngestionCallbackPurpose,
} from "../../src/server/jobs/contracts";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
  failIngestionStage,
} from "../../src/server/ingestion/service";
import { handleVerificationRequest } from "../../src/server/verification/http";
import { verifyDocument } from "../../src/server/verification/service";
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
let otherAdmin: CurrentAccount;
let staffAccount: CurrentAccount;
let otherStaff: CurrentAccount;

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
  executionId = "exec-s07",
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
        pageCount: 1,
        pages: [
          {
            pageIndex: 1,
            nativeText: "Section 1 Lockout\n1. Open isolation valve to 0 bar.\n2. Verify 0.00 V.",
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
      return new Response(new Uint8Array(previewPdf), {
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

async function seedUploadedDocument(
  storage: MemoryStorage,
  options: {
    title: string;
    fileName?: string;
    kind?: "pdf" | "docx";
    uploader?: CurrentAccount;
  },
) {
  const kind = options.kind ?? "pdf";
  const bytes = kind === "pdf" ? syntheticPdf() : syntheticRichDocx();
  const mimeType =
    kind === "pdf"
      ? ("application/pdf" as const)
      : ("application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const);
  const fileName = options.fileName ?? (kind === "pdf" ? "synthetic-s07.pdf" : "synthetic-s07.docx");
  const uploader = options.uploader ?? adminAccount;
  const input = {
    requestKey: randomUUID(),
    title: options.title,
    fileName,
    mimeType,
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const init = await initializeDocumentUpload(uploader, input, database, storage, 1_000_000_000);
  const [intent] = await database
    .select()
    .from(schema.documentUploadIntents)
    .where(eq(schema.documentUploadIntents.id, init.document.id));
  storage.objects.set(intent.stagingKey, { bytes, contentType: mimeType });
  await finalizeDocumentUpload(uploader, intent.id, database, storage);
  const [doc] = await database
    .select()
    .from(schema.sopDocuments)
    .where(eq(schema.sopDocuments.id, intent.id));
  const [job] = await database
    .select()
    .from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.documentId, intent.id));
  return { documentId: intent.id, doc, job, bytes, mimeType, fileName };
}

async function advanceDocumentState(
  documentId: string,
  storage: MemoryStorage,
  targetStatus: "PROCESSING" | "PENDING_VERIFICATION" | "ACTIVE" | "REJECTED" | "FAILED",
  kind: "pdf" | "docx" = "pdf",
) {
  const executionId = `exec-${randomUUID().slice(0, 8)}`;
  const [job] = await database
    .select()
    .from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.documentId, documentId));
  await database.update(schema.workflowJobs).set({ dispatchCount: 1 }).where(eq(schema.workflowJobs.id, job.id));
  const [dispatched] = await database
    .select()
    .from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.id, job.id));

  const claimed = await claimIngestionStage(makeClaims(dispatched, "claim", executionId), {
    database,
    privateKey: dispatchKeys.privateKey,
  });
  if (targetStatus === "PROCESSING") {
    const [doc] = await database
      .select()
      .from(schema.sopDocuments)
      .where(eq(schema.sopDocuments.id, documentId));
    return { doc, job: dispatched };
  }

  if (targetStatus === "FAILED") {
    await failIngestionStage(
      makeClaims(dispatched, "fail", executionId),
      { errorCode: "PDF_EMPTY", transient: false },
      { database },
    );
    const [doc] = await database
      .select()
      .from(schema.sopDocuments)
      .where(eq(schema.sopDocuments.id, documentId));
    return { doc, job: dispatched };
  }

  const previewPdf = syntheticPdf();
  await extractIngestionStage(makeClaims(dispatched, "extract", executionId), claimed.fileRefToken, {
    database,
    storage,
    fetchImpl: kind === "pdf" ? nativePdfWorkerFetch() : docxWorkerFetch(previewPdf),
    env: workerEnv,
    privateKey: dispatchKeys.privateKey,
  });
  await chunkIngestionStage(makeClaims(dispatched, "chunk", executionId), { database });
  await embedIngestionStage(makeClaims(dispatched, "embed", executionId), { database, env: workerEnv });
  await completeIngestionStage(makeClaims(dispatched, "complete", executionId), { database });

  const [pendingDoc] = await database
    .select()
    .from(schema.sopDocuments)
    .where(eq(schema.sopDocuments.id, documentId));

  if (targetStatus === "PENDING_VERIFICATION") {
    return { doc: pendingDoc, job: dispatched };
  }

  await verifyDocument(
    otherAdmin,
    documentId,
    {
      decision: targetStatus === "ACTIVE" ? "APPROVE" : "REJECT",
      expectedSha256: pendingDoc.sha256,
      expectedJobId: dispatched.id,
      expectedPipelineVersion: pendingDoc.processedPipelineVersion!,
      expectedAttemptId: pendingDoc.processedAttemptId!,
      explicitConfirmation: true,
      notes:
        targetStatus === "ACTIVE"
          ? "Verified original bytes and units."
          : "Rejected due to unit discrepancy on page 1.",
    },
    database,
  );
  const [finalDoc] = await database
    .select()
    .from(schema.sopDocuments)
    .where(eq(schema.sopDocuments.id, documentId));
  return { doc: finalDoc, job: dispatched };
}

beforeAll(async () => {
  adminAccount = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  otherAdmin = await seedSyntheticSession(database, await seedSyntheticAccount(database, "ADMIN"));
  staffAccount = await seedSyntheticSession(database, await seedSyntheticAccount(database, "STAFF"));
  otherStaff = await seedSyntheticSession(database, await seedSyntheticAccount(database, "STAFF"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await database
    .update(schema.authUsers)
    .set({ role: "ADMIN", active: true })
    .where(eq(schema.authUsers.id, adminAccount.id));
  await database
    .update(schema.authUsers)
    .set({ role: "STAFF", active: true })
    .where(eq(schema.authUsers.id, staffAccount.id));
  adminAccount = await seedSyntheticSession(database, {
    id: adminAccount.id,
    email: adminAccount.email,
    role: "ADMIN",
  });
  staffAccount = await seedSyntheticSession(database, {
    id: staffAccount.id,
    email: staffAccount.email,
    role: "STAFF",
  });
});

afterAll(async () => {
  await connection.end();
});

describe("S07/D1/D5 searchable SOP library and authorized original source access", () => {
  it("exposes ONLY ACTIVE documents without diagnostics to Staff while returning all lifecycle states and diagnostics to Admin", async () => {
    const storage = new MemoryStorage();
    const prefix = `S07-RoleMatrix-${randomUUID().slice(0, 8)}`;

    const uploaded = await seedUploadedDocument(storage, { title: `${prefix} Uploaded PDF` });
    const processing = await seedUploadedDocument(storage, { title: `${prefix} Processing PDF` });
    await advanceDocumentState(processing.documentId, storage, "PROCESSING");

    const pending = await seedUploadedDocument(storage, { title: `${prefix} Pending PDF` });
    await advanceDocumentState(pending.documentId, storage, "PENDING_VERIFICATION");

    const rejected = await seedUploadedDocument(storage, { title: `${prefix} Rejected PDF` });
    await advanceDocumentState(rejected.documentId, storage, "REJECTED");

    const failed = await seedUploadedDocument(storage, { title: `${prefix} Failed PDF` });
    await advanceDocumentState(failed.documentId, storage, "FAILED");

    const activePdf = await seedUploadedDocument(storage, {
      title: `${prefix} Active 100% _Valve\\SOP`,
      fileName: "active-valve.pdf",
      kind: "pdf",
    });
    await advanceDocumentState(activePdf.documentId, storage, "ACTIVE", "pdf");

    const activeDocx = await seedUploadedDocument(storage, {
      title: `${prefix} Active Pump DOCX`,
      fileName: "active-pump.docx",
      kind: "docx",
    });
    await advanceDocumentState(activeDocx.documentId, storage, "ACTIVE", "docx");

    // Staff list query scoped to prefix returns ONLY the 2 ACTIVE documents.
    const staffList = await listDocuments(staffAccount, { q: prefix, limit: 25 }, database);
    expect(staffList.items.map((item) => item.id).sort()).toEqual(
      [activePdf.documentId, activeDocx.documentId].sort(),
    );
    expect(staffList.items.every((item) => item.status === "ACTIVE")).toBe(true);
    expect(staffList.items.every((item) => item.diagnostics === null)).toBe(true);
    expect(JSON.stringify(staffList)).not.toMatch(/originals\/|previews\/|sha256|token=/);

    // Wildcard characters %, _ and \ in search query match literally without matching arbitrary titles.
    const staffWildcardMatch = await listDocuments(
      staffAccount,
      { q: `${prefix} Active 100% _Valve\\SOP` },
      database,
    );
    expect(staffWildcardMatch.items.map((item) => item.id)).toEqual([activePdf.documentId]);

    const staffUnmatchedWildcard = await listDocuments(
      staffAccount,
      { q: `${prefix} %` },
      database,
    );
    expect(staffUnmatchedWildcard.items).toHaveLength(0);

    // Admin list query returns all 7 lifecycle documents with diagnostics.
    const adminList = await listDocuments(adminAccount, { q: prefix, limit: 25 }, database);
    expect(adminList.items).toHaveLength(7);
    expect(adminList.items.map((item) => item.status).sort()).toEqual(
      ["ACTIVE", "ACTIVE", "FAILED", "PENDING_VERIFICATION", "PROCESSING", "REJECTED", "UPLOADED"].sort(),
    );
    expect(JSON.stringify(adminList)).not.toMatch(/originals\/|previews\/|sha256/);

    const adminFailed = adminList.items.find((item) => item.id === failed.documentId)!;
    expect(adminFailed.diagnostics).toMatchObject({
      processingErrorCode: "PDF_EMPTY",
      latestJob: { state: "FAILED", errorCode: "PDF_EMPTY" },
    });

    const adminRejected = adminList.items.find((item) => item.id === rejected.documentId)!;
    expect(adminRejected.diagnostics).toMatchObject({
      rejectionReason: "Rejected due to unit discrepancy on page 1.",
      latestJob: { state: "COMPLETED" },
    });
    expect(adminRejected.diagnostics!.pageCount).toBeGreaterThanOrEqual(1);
    expect(adminRejected.diagnostics!.chunkCount).toBeGreaterThanOrEqual(1);

    const adminUploaded = adminList.items.find((item) => item.id === uploaded.documentId)!;
    expect(adminUploaded.diagnostics).toMatchObject({
      processingErrorCode: null,
      rejectionReason: null,
      latestJob: { state: "QUEUED" },
      pageCount: 0,
      chunkCount: 0,
      issueCount: 0,
    });

    // Keyset pagination walks all 7 Admin items without duplicates or drops.
    const page1 = await listDocuments(adminAccount, { q: prefix, limit: 3 }, database);
    expect(page1.items).toHaveLength(3);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = await listDocuments(
      adminAccount,
      { q: prefix, limit: 3, cursor: page1.nextCursor! },
      database,
    );
    expect(page2.items).toHaveLength(3);
    expect(page2.nextCursor).toEqual(expect.any(String));

    const page3 = await listDocuments(
      adminAccount,
      { q: prefix, limit: 3, cursor: page2.nextCursor! },
      database,
    );
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const paginatedIds = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
    expect(paginatedIds).toEqual(adminList.items.map((item) => item.id));
  });

  it("issues short-lived signed source links, records sanitized audit events and delivers exact original PDF and DOCX bytes", async () => {
    const storage = new MemoryStorage();
    const prefix = `S07-Source-${randomUUID().slice(0, 8)}`;

    const pdfSeed = await seedUploadedDocument(storage, {
      title: `${prefix} Verified PDF`,
      fileName: "verified-lockout.pdf",
      kind: "pdf",
    });
    await advanceDocumentState(pdfSeed.documentId, storage, "ACTIVE", "pdf");

    const docxSeed = await seedUploadedDocument(storage, {
      title: `${prefix} Verified DOCX`,
      fileName: "verified-calibration.docx",
      kind: "docx",
    });
    await advanceDocumentState(docxSeed.documentId, storage, "ACTIVE", "docx");

    // Staff inline access with section and page context on ACTIVE PDF.
    const pdfAuth = await authorizeDocumentSource(
      staffAccount,
      pdfSeed.documentId,
      { disposition: "inline", page: 1, section: "Section 1 Lockout" },
      database,
    );
    expect(pdfAuth.source).toMatchObject({
      documentId: pdfSeed.documentId,
      title: `${prefix} Verified PDF`,
      fileName: "verified-lockout.pdf",
      mimeType: "application/pdf",
      disposition: "inline",
      ttlSeconds: sourceLinkTtlSeconds,
      context: { page: 1, section: "Section 1 Lockout" },
    });
    expect(pdfAuth.source.url).toMatch(
      new RegExp(`^/api/documents/${pdfSeed.documentId}/source/content\\?token=`),
    );
    expect(pdfAuth.source.url).not.toContain("#");

    const pdfToken = new URL(pdfAuth.source.url, "http://127.0.0.1:3000").searchParams.get("token")!;
    const pdfContent = await readDocumentSourceContent(
      staffAccount,
      pdfSeed.documentId,
      { token: pdfToken },
      database,
      storage,
    );
    expect(pdfContent.bytes).toEqual(pdfSeed.bytes);
    expect(createHash("sha256").update(pdfContent.bytes).digest("hex")).toBe(pdfSeed.doc.sha256);
    expect(pdfContent.disposition).toBe("inline");
    expect(pdfContent.mimeType).toBe("application/pdf");

    // Staff attachment access on ACTIVE DOCX delivers original .docx bytes (not derivative preview PDF).
    const docxAuth = await authorizeDocumentSource(
      staffAccount,
      docxSeed.documentId,
      { disposition: "attachment", section: "Section 2 Calibration" },
      database,
    );
    const docxToken = new URL(docxAuth.source.url, "http://127.0.0.1:3000").searchParams.get("token")!;
    const docxContent = await readDocumentSourceContent(
      staffAccount,
      docxSeed.documentId,
      { token: docxToken },
      database,
      storage,
    );
    expect(docxContent.bytes).toEqual(docxSeed.bytes);
    expect(createHash("sha256").update(docxContent.bytes).digest("hex")).toBe(docxSeed.doc.sha256);
    expect(docxContent.disposition).toBe("attachment");
    expect(docxContent.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    // Audit event records authorization metadata without leaking token or signed URL.
    const audits = await database
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.targetId, pdfSeed.documentId),
          eq(schema.auditEvents.action, "document.source_authorized"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: staffAccount.id,
      outcome: "authorized",
      metadata: {
        disposition: "inline",
        status: "ACTIVE",
        page: 1,
        section: "Section 1 Lockout",
      },
    });
    expect(JSON.stringify(audits[0])).not.toContain(pdfToken);
    expect(JSON.stringify(audits[0])).not.toContain("/source/content");
  });

  it("enforces negative security boundaries: guessed IDs, non-ACTIVE Staff denial without oracle, preview denial, token expiry, tampering, cross-user replay, deactivation and post-issue status change", async () => {
    const storage = new MemoryStorage();
    const prefix = `S07-Security-${randomUUID().slice(0, 8)}`;

    const uploaded = await seedUploadedDocument(storage, { title: `${prefix} Uploaded` });
    const processing = await seedUploadedDocument(storage, { title: `${prefix} Processing` });
    await advanceDocumentState(processing.documentId, storage, "PROCESSING");
    const pending = await seedUploadedDocument(storage, { title: `${prefix} Pending` });
    await advanceDocumentState(pending.documentId, storage, "PENDING_VERIFICATION");
    const rejected = await seedUploadedDocument(storage, { title: `${prefix} Rejected` });
    await advanceDocumentState(rejected.documentId, storage, "REJECTED");
    const failed = await seedUploadedDocument(storage, { title: `${prefix} Failed` });
    await advanceDocumentState(failed.documentId, storage, "FAILED");
    const active = await seedUploadedDocument(storage, { title: `${prefix} Active` });
    await advanceDocumentState(active.documentId, storage, "ACTIVE");

    // 1. Guessed UUID returns 404 NOT_FOUND for both Staff and Admin.
    const guessedId = randomUUID();
    await expect(
      authorizeDocumentSource(staffAccount, guessedId, {}, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      authorizeDocumentSource(adminAccount, guessedId, {}, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    // 2. Staff requesting any non-ACTIVE state gets identical 404 NOT_FOUND (zero existence oracle).
    for (const nonActiveId of [
      uploaded.documentId,
      processing.documentId,
      pending.documentId,
      rejected.documentId,
      failed.documentId,
    ]) {
      await expect(
        authorizeDocumentSource(staffAccount, nonActiveId, {}, database),
      ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    }

    // Admin can still authorize original access on non-ACTIVE documents for troubleshooting/review.
    const adminPendingAuth = await authorizeDocumentSource(
      adminAccount,
      pending.documentId,
      { disposition: "inline" },
      database,
    );
    const adminPendingToken = new URL(
      adminPendingAuth.source.url,
      "http://127.0.0.1:3000",
    ).searchParams.get("token")!;
    const adminPendingContent = await readDocumentSourceContent(
      adminAccount,
      pending.documentId,
      { token: adminPendingToken },
      database,
      storage,
    );
    expect(adminPendingContent.bytes).toEqual(pending.bytes);

    // 3. Cross-user token replay: Staff cannot use Admin's token, and otherStaff cannot use staffAccount's token.
    await expect(
      readDocumentSourceContent(
        staffAccount,
        pending.documentId,
        { token: adminPendingToken },
        database,
        storage,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    const nowSeconds = 1_795_100_000;
    const staffActiveAuth = await authorizeDocumentSource(
      staffAccount,
      active.documentId,
      { disposition: "inline" },
      database,
      { nowSeconds },
    );
    const staffActiveToken = new URL(
      staffActiveAuth.source.url,
      "http://127.0.0.1:3000",
    ).searchParams.get("token")!;

    await expect(
      readDocumentSourceContent(
        otherStaff,
        active.documentId,
        { token: staffActiveToken },
        database,
        storage,
        { nowSeconds: nowSeconds + 5 },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    // 4. Expired token (now >= exp) fails with 410 SOURCE_LINK_EXPIRED.
    await expect(
      readDocumentSourceContent(
        staffAccount,
        active.documentId,
        { token: staffActiveToken },
        database,
        storage,
        { nowSeconds: nowSeconds + sourceLinkTtlSeconds },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_LINK_EXPIRED", status: 410 });

    // 5. Tampered token and wrong-document token fail with 403 SOURCE_LINK_INVALID.
    await expect(
      readDocumentSourceContent(
        staffAccount,
        active.documentId,
        { token: `${staffActiveToken}tamper` },
        database,
        storage,
        { nowSeconds: nowSeconds + 5 },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_LINK_INVALID", status: 403 });

    await expect(
      readDocumentSourceContent(
        staffAccount,
        pending.documentId,
        { token: staffActiveToken },
        database,
        storage,
        { nowSeconds: nowSeconds + 5 },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_LINK_INVALID", status: 403 });

    // 6. Document status changed to REJECTED after link issuance -> /source/content rechecks live DB status and fails with 404 NOT_FOUND.
    const statusChangeSeed = await seedUploadedDocument(storage, {
      title: `${prefix} StatusChange`,
    });
    const pendingState = await advanceDocumentState(
      statusChangeSeed.documentId,
      storage,
      "PENDING_VERIFICATION",
    );
    const { token: preRejectStaffToken } = signDocumentSourceToken(
      {
        documentId: statusChangeSeed.documentId,
        accountId: staffAccount.id,
        role: "STAFF",
        statusAtIssue: "ACTIVE",
        sha256: pendingState.doc.sha256,
        disposition: "inline",
        page: 1,
        section: "Section 1 Lockout",
      },
      { nowSeconds },
    );
    const adminPreRejectAuth = await authorizeDocumentSource(
      adminAccount,
      statusChangeSeed.documentId,
      { disposition: "inline" },
      database,
      { nowSeconds },
    );
    const adminPreRejectToken = new URL(
      adminPreRejectAuth.source.url,
      "http://127.0.0.1:3000",
    ).searchParams.get("token")!;

    await verifyDocument(
      otherAdmin,
      statusChangeSeed.documentId,
      {
        decision: "REJECT",
        expectedSha256: pendingState.doc.sha256,
        expectedJobId: pendingState.job.id,
        expectedPipelineVersion: pendingState.doc.processedPipelineVersion!,
        expectedAttemptId: pendingState.doc.processedAttemptId!,
        explicitConfirmation: true,
        notes: "Rejected before content fetch.",
      },
      database,
    );

    // Staff presenting a valid unexpired token with statusAtIssue="ACTIVE" against a now-REJECTED document fails with 404 NOT_FOUND.
    await expect(
      readDocumentSourceContent(
        staffAccount,
        statusChangeSeed.documentId,
        { token: preRejectStaffToken },
        database,
        storage,
        { nowSeconds: nowSeconds + 5 },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    // Admin demoted to STAFF after link issuance also loses access to the REJECTED document immediately (404 NOT_FOUND).
    await database
      .update(schema.authUsers)
      .set({ role: "STAFF" })
      .where(eq(schema.authUsers.id, adminAccount.id));
    await expect(
      readDocumentSourceContent(
        adminAccount,
        statusChangeSeed.documentId,
        { token: adminPreRejectToken },
        database,
        storage,
        { nowSeconds: nowSeconds + 5 },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await database
      .update(schema.authUsers)
      .set({ role: "ADMIN" })
      .where(eq(schema.authUsers.id, adminAccount.id));

    // 7. Deactivated account or expired session after link issuance immediately fails with 401 UNAUTHENTICATED.
    await database
      .update(schema.authUsers)
      .set({ active: false })
      .where(eq(schema.authUsers.id, staffAccount.id));
    await expect(
      listDocuments(staffAccount, {}, database),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(
      authorizeDocumentSource(staffAccount, active.documentId, {}, database),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(
      readDocumentSourceContent(
        staffAccount,
        active.documentId,
        { token: staffActiveToken },
        database,
        storage,
        { nowSeconds: nowSeconds + 5 },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });

    // 8. HTTP route headers, preview denial for Staff (403) and anonymous denial (401).
    await database
      .update(schema.authUsers)
      .set({ active: true })
      .where(eq(schema.authUsers.id, staffAccount.id));
    const base = authConfiguration().baseURL;
    const host = new URL(base).host;

    expect(
      (
        await handleDocumentLibraryRequest(
          new Request(`${base}/api/documents`, { method: "GET", headers: { host } }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleDocumentSourceRequest(
          new Request(`${base}/api/documents/${active.documentId}/source`, {
            method: "GET",
            headers: { host },
          }),
          active.documentId,
        )
      ).status,
    ).toBe(401);

    const staffLogin = await handleAuthentication(
      new Request(`${base}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { host, origin: base, "content-type": "application/json" },
        body: JSON.stringify({ email: staffAccount.email, password: syntheticPassword }),
      }),
    );
    const staffCookie = staffLogin.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    // Staff requesting Admin /preview even on an ACTIVE document is denied with 403 FORBIDDEN.
    expect(
      (
        await handleVerificationRequest(
          new Request(`${base}/api/documents/${active.documentId}/preview`, {
            method: "GET",
            headers: { host, cookie: staffCookie },
          }),
          active.documentId,
          "preview",
        )
      ).status,
    ).toBe(403);

    const listRes = await handleDocumentLibraryRequest(
      new Request(`${base}/api/documents?q=${encodeURIComponent(prefix)}`, {
        method: "GET",
        headers: { host, cookie: staffCookie },
      }),
    );
    expect(listRes.status).toBe(200);
    expect(listRes.headers.get("cache-control")).toBe("private, no-store");

    const sourceRes = await handleDocumentSourceRequest(
      new Request(`${base}/api/documents/${active.documentId}/source?disposition=attachment&page=1`, {
        method: "GET",
        headers: { host, cookie: staffCookie },
      }),
      active.documentId,
    );
    expect(sourceRes.status).toBe(200);
    expect(sourceRes.headers.get("cache-control")).toBe("private, no-store");
    const sourcePayload = await sourceRes.json();

    // Missing token on HTTP content route -> 403 SOURCE_LINK_INVALID.
    const missingTokenRes = await handleDocumentSourceContentRequest(
      new Request(`${base}/api/documents/${active.documentId}/source/content`, {
        method: "GET",
        headers: { host, cookie: staffCookie },
      }),
      active.documentId,
    );
    expect(missingTokenRes.status).toBe(403);
    expect(await missingTokenRes.json()).toEqual({ error: { code: "SOURCE_LINK_INVALID" } });

    // Expired token on HTTP content route -> 410 SOURCE_LINK_EXPIRED.
    const expiredHttpRes = await handleDocumentSourceContentRequest(
      new Request(`${base}${sourcePayload.source.url}`, {
        method: "GET",
        headers: { host, cookie: staffCookie },
      }),
      active.documentId,
      { nowSeconds: Math.floor(Date.now() / 1000) + sourceLinkTtlSeconds + 1 },
    );
    expect(expiredHttpRes.status).toBe(410);
    expect(await expiredHttpRes.json()).toEqual({ error: { code: "SOURCE_LINK_EXPIRED" } });
  });
});
