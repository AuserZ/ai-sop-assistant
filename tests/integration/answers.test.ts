import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  generateAnswerCandidate,
  generateValidatedSopAnswer,
  generateValidatedSopAnswerForAccount,
  noEvidenceFallbackMessage,
} from "../../src/server/answers";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import {
  deleteDocument,
  finalizeDocumentUpload,
  initializeDocumentUpload,
} from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import { approvedEmbeddingDimensions } from "../../src/server/ingestion/config";
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
import { loadOriginalActivePassagesByIds } from "../../src/server/retrieval";
import { verifyDocument } from "../../src/server/verification/service";
import { seedSyntheticAccount, seedSyntheticSession } from "../fixtures/auth";
import { syntheticPdf, syntheticRichDocx } from "../fixtures/document-files";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });

const workerEnv = {
  CONVERSION_URL: "http://convert-worker:8092",
  PADDLEOCR_URL: "http://paddleocr:8091",
  SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
  SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED: "1",
  SOP_LOCAL_ANSWER_FIXTURE_ENABLED: "1",
  AUTH_BASE_URL: "http://127.0.0.1:3000",
};

const dispatchKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let adminAccount: CurrentAccount;
let staffAccount: CurrentAccount;
const seededDocumentIds: string[] = [];

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

function makeBasisVector(primaryIndex: number, secondaryIndex?: number, secondaryWeight = 0.25): number[] {
  const vector = new Array<number>(approvedEmbeddingDimensions).fill(0);
  vector[primaryIndex % approvedEmbeddingDimensions] = 1;
  if (secondaryIndex !== undefined) {
    vector[secondaryIndex % approvedEmbeddingDimensions] = secondaryWeight;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => Number((value / norm).toFixed(7)));
}

function makeClaims(
  job: typeof schema.workflowJobs.$inferSelect,
  purpose: IngestionCallbackPurpose,
  executionId = "exec-s10",
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

function pdfWorkerFetch(extractedText: string): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/pdf/inspect-and-extract")) {
      return Response.json({
        result: "PASS",
        pageCount: 1,
        pages: [
          {
            pageIndex: 1,
            nativeText: extractedText,
            imageCount: 0,
            maxImagePixels: 0,
          },
        ],
      });
    }
    throw new Error(`Unexpected PDF worker URL: ${url}`);
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
    throw new Error(`Unexpected DOCX worker URL: ${url}`);
  });
}

async function seedIndexedDocument(options: {
  title: string;
  format: "pdf" | "docx";
  extractedText?: string;
  stage: "PENDING_VERIFICATION" | "ACTIVE" | "DELETED";
  embeddingVector?: number[];
}) {
  const storage = new MemoryStorage();
  const isPdf = options.format === "pdf";
  const bytes = isPdf ? syntheticPdf() : syntheticRichDocx();
  const mimeType = isPdf
    ? ("application/pdf" as const)
    : ("application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const);
  const ext = isPdf ? "pdf" : "docx";
  const fileName = `${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}.${ext}`;

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
  seededDocumentIds.push(init.document.id);

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

  const claimed = await claimIngestionStage(makeClaims(job, "claim"), {
    database,
    privateKey: dispatchKeys.privateKey,
  });
  [job] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));

  const fetchImpl = isPdf
    ? pdfWorkerFetch(options.extractedText ?? "Section 1 Default\n1. Verify gauge.")
    : docxWorkerFetch(syntheticPdf());

  await extractIngestionStage(makeClaims(job, "extract"), claimed.fileRefToken, {
    database,
    storage,
    fetchImpl,
    env: workerEnv,
    privateKey: dispatchKeys.privateKey,
  });
  await chunkIngestionStage(makeClaims(job, "chunk"), { database });

  // Always call embedIngestionStage before any optional deterministic embedding overwrite.
  await embedIngestionStage(makeClaims(job, "embed"), { database, env: workerEnv });
  if (options.embeddingVector) {
    await database
      .update(schema.sopChunks)
      .set({
        embedding: options.embeddingVector,
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: approvedEmbeddingDimensions,
      })
      .where(eq(schema.sopChunks.jobId, job.id));
  }

  await completeIngestionStage(makeClaims(job, "complete"), { database });

  let [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
  [job] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));

  if (options.stage === "ACTIVE" || options.stage === "DELETED") {
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
    if (options.stage === "DELETED") {
      await deleteDocument(adminAccount, intent.id, database);
    }
    [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
  }

  const chunks = await database
    .select()
    .from(schema.sopChunks)
    .where(eq(schema.sopChunks.documentId, intent.id));

  return { documentId: intent.id, doc, job, chunks };
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

  await database
    .update(schema.authUsers)
    .set({ role: "STAFF", active: true })
    .where(eq(schema.authUsers.id, staffAccount.id));
  staffAccount = await seedSyntheticSession(database, {
    id: staffAccount.id,
    email: staffAccount.email,
    role: "STAFF",
  });
});

afterAll(async () => {
  for (const documentId of seededDocumentIds) {
    await deleteDocument(adminAccount, documentId, database).catch(() => undefined);
    await database.delete(schema.sopChunks).where(eq(schema.sopChunks.documentId, documentId)).catch(() => undefined);
    await database
      .delete(schema.sopExtractionPages)
      .where(eq(schema.sopExtractionPages.documentId, documentId))
      .catch(() => undefined);
    await database
      .delete(schema.sopVerificationIssues)
      .where(eq(schema.sopVerificationIssues.documentId, documentId))
      .catch(() => undefined);
  }
  await connection.end();
});

describe("S10/C2-C5/ADR12 real PostgreSQL + pgvector end-to-end answer validation and citation recheck", () => {
  it("returns validated numbered PDF answer with genuine pages while excluding PENDING_VERIFICATION and DELETED traps", async () => {
    const tag = `s10pdf${randomUUID().slice(0, 8)}`;
    const queryVec = makeBasisVector(510);
    const activeVec = makeBasisVector(510, 511, 0.3);

    const trapText = `Section 1 ${tag} Unsafe Trap\n1. ${tag} ${tag} ${tag} Set sterilizer to 999.0 °C for 1 second.`;
    const activeText = [
      `Section 2 ${tag} Sterilization Cycle`,
      `1. Close ${tag} chamber door until lock pin clicks.`,
      `2. Run ${tag} cycle at 121.0 °C and 1.15 bar for 20 minutes.`,
      `3. Do not open door until pressure returns to 0.0 bar and temperature is below 80.0 °C.`,
    ].join("\n");

    const pendingTrap = await seedIndexedDocument({
      title: `SOP-811 ${tag} Pending Trap`,
      format: "pdf",
      extractedText: trapText,
      stage: "PENDING_VERIFICATION",
      embeddingVector: queryVec,
    });
    const deletedTrap = await seedIndexedDocument({
      title: `SOP-812 ${tag} Deleted Trap`,
      format: "pdf",
      extractedText: trapText,
      stage: "DELETED",
      embeddingVector: queryVec,
    });
    const activePdf = await seedIndexedDocument({
      title: `SOP-813 ${tag} Autoclave Cycle`,
      format: "pdf",
      extractedText: activeText,
      stage: "ACTIVE",
      embeddingVector: activeVec,
    });

    const result = await generateValidatedSopAnswerForAccount(
      staffAccount,
      { question: `What are the ${tag} autoclave sterilization cycle steps, temperature, pressure and door safety rules?` },
      {
        database,
        env: workerEnv,
        retrievalOptions: {
          embedTextsImpl: async () => ({
            model: "text-embedding-3-small",
            dimensions: approvedEmbeddingDimensions,
            vectors: [queryVec],
          }),
        },
      },
    );

    expect(result.kind).toBe("supported");
    if (result.kind !== "supported") return;
    expect(result.isProcedural).toBe(true);
    expect(result.answer).toContain("1. Close");
    expect(result.answer).toContain("121.0 °C");
    expect(result.answer).toContain("1.15 bar");
    expect(result.answer).toContain("20 minutes");
    expect(result.answer).toContain("0.0 bar");
    expect(result.answer).toContain("80.0 °C");
    expect(result.answer).not.toContain("999.0");

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].documentId).toBe(activePdf.documentId);
    expect(result.sources[0].documentId).not.toBe(pendingTrap.documentId);
    expect(result.sources[0].documentId).not.toBe(deletedTrap.documentId);
    expect(result.sources[0].pageStart).toBe(1);
    expect(result.sources[0].pageEnd).toBe(1);
    expect(result.sources[0].sourcePath).toContain(`/api/documents/${activePdf.documentId}/source?`);
    expect(result.sources[0].sourcePath).toContain("page=1");
    expect(result.metadata.deterministicCheckPassed).toBe(true);
    expect(result.metadata.judgeVerdict).toBe("PASS");
  });

  it("returns validated DOCX answer omitting pageStart/pageEnd and page query parameter", async () => {
    const tag = `s10docx${randomUUID().slice(0, 8)}`;
    const queryVec = makeBasisVector(530);

    const activeDocx = await seedIndexedDocument({
      title: `SOP-820 ${tag} Valve Calibration DOCX`,
      format: "docx",
      stage: "ACTIVE",
      embeddingVector: queryVec,
    });

    const result = await generateValidatedSopAnswerForAccount(
      staffAccount,
      { question: `What regulator pressure and hold time are required in SOP-820 ${tag} Valve Calibration?` },
      {
        database,
        env: workerEnv,
        retrievalOptions: {
          embedTextsImpl: async () => ({
            model: "text-embedding-3-small",
            dimensions: approvedEmbeddingDimensions,
            vectors: [queryVec],
          }),
        },
      },
    );

    expect(result.kind).toBe("supported");
    if (result.kind !== "supported") return;
    expect(result.answer).toContain("2.75 bar");
    expect(result.answer).toContain("15 minutes");
    expect(result.sources.length).toBeGreaterThanOrEqual(1);
    expect(result.sources[0].documentId).toBe(activeDocx.documentId);
    expect("pageStart" in result.sources[0]).toBe(false);
    expect("pageEnd" in result.sources[0]).toBe(false);
    expect(result.sources[0].sourcePath).toContain(`/api/documents/${activeDocx.documentId}/source?section=`);
    expect(result.sources[0].sourcePath).not.toContain("page=");
  });

  it("withholds candidate and returns exact No SOP found on mid-flight Admin delete right before citation release and on unsupported queries", async () => {
    const tag = `s10race${randomUUID().slice(0, 8)}`;
    const queryVec = makeBasisVector(550);

    const activeDoc = await seedIndexedDocument({
      title: `SOP-830 ${tag} Mid-Flight Revocation`,
      format: "pdf",
      extractedText: `Section 1 ${tag} Purge\n1. Purge ${tag} manifold with nitrogen at 2.5 bar for 10 minutes.`,
      stage: "ACTIVE",
      embeddingVector: queryVec,
    });

    // Document stays ACTIVE through retrieval, generation and judge; Admin deletes it right before citation recheck!
    let deletedRightBeforeCitation = false;
    const revokedResult = await generateValidatedSopAnswer(
      { question: `What nitrogen purge pressure and duration apply in SOP-830 ${tag}?` },
      {
        database,
        env: workerEnv,
        retrievalOptions: {
          embedTextsImpl: async () => ({
            model: "text-embedding-3-small",
            dimensions: approvedEmbeddingDimensions,
            vectors: [queryVec],
          }),
        },
        resolveCitationPassagesImpl: async (snapshots, opts) => {
          if (!deletedRightBeforeCitation) {
            deletedRightBeforeCitation = true;
            await deleteDocument(adminAccount, activeDoc.documentId, database);
          }
          return loadOriginalActivePassagesByIds(snapshots, opts);
        },
      },
    );

    expect(deletedRightBeforeCitation).toBe(true);
    expect(revokedResult).toMatchObject({
      kind: "no_evidence",
      answer: noEvidenceFallbackMessage,
      sources: [],
      reason: "SOURCE_ELIGIBILITY_REVOKED",
    });

    // Unsupported question returns exact fallback with empty sources.
    const unsupported = await generateValidatedSopAnswerForAccount(
      staffAccount,
      { question: `What is the cafeteria dessert rotation schedule for ${tag} nonexistent topic?` },
      {
        database,
        env: workerEnv,
        retrievalOptions: {
          embedTextsImpl: async () => ({
            model: "text-embedding-3-small",
            dimensions: approvedEmbeddingDimensions,
            vectors: [makeBasisVector(599)],
          }),
        },
      },
    );
    expect(unsupported).toMatchObject({
      kind: "no_evidence",
      answer: noEvidenceFallbackMessage,
      sources: [],
    });
  });

  it("denies pre-flight and mid-flight deactivated users with 401 UNAUTHENTICATED before releasing any answer", async () => {
    const tag = `s10auth${randomUUID().slice(0, 8)}`;
    const queryVec = makeBasisVector(570);

    await seedIndexedDocument({
      title: `SOP-840 ${tag} Auth Recheck`,
      format: "pdf",
      extractedText: `Section 1 ${tag} Check\n1. Confirm ${tag} pressure gauge reads 1.5 bar.`,
      stage: "ACTIVE",
      embeddingVector: queryVec,
    });

    // Pre-flight deactivated user -> 401 before retrieval executes.
    const retrieveSpy = vi.fn();
    await database
      .update(schema.authUsers)
      .set({ active: false })
      .where(eq(schema.authUsers.id, staffAccount.id));

    await expect(
      generateValidatedSopAnswerForAccount(
        staffAccount,
        { question: `What is ${tag} pressure?` },
        { database, env: workerEnv, retrieveEvidenceImpl: retrieveSpy },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(retrieveSpy).not.toHaveBeenCalled();

    // Reactivate with fresh session, then deactivate mid-flight during answer generation -> 401 before release.
    await database
      .update(schema.authUsers)
      .set({ active: true })
      .where(eq(schema.authUsers.id, staffAccount.id));
    staffAccount = await seedSyntheticSession(database, {
      id: staffAccount.id,
      email: staffAccount.email,
      role: "STAFF",
    });

    await expect(
      generateValidatedSopAnswerForAccount(
        staffAccount,
        { question: `What pressure does SOP-840 ${tag} specify?` },
        {
          database,
          env: workerEnv,
          retrievalOptions: {
            embedTextsImpl: async () => ({
              model: "text-embedding-3-small",
              dimensions: approvedEmbeddingDimensions,
              vectors: [queryVec],
            }),
          },
          generateCandidateImpl: async (input, config, opts) => {
            await database
              .update(schema.authUsers)
              .set({ active: false })
              .where(eq(schema.authUsers.id, staffAccount.id));
            return generateAnswerCandidate(input, config, opts);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });
});
