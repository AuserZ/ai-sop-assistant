import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  failIngestionStage,
} from "../../src/server/ingestion/service";
import {
  ingestionWorkflowVersion,
  type IngestionCallbackClaims,
  type IngestionCallbackPurpose,
} from "../../src/server/jobs/contracts";
import {
  loadOriginalActivePassagesByIds,
  noEvidenceFallbackMessage,
  retrieveActiveSopEvidence,
  retrieveActiveSopEvidenceForAccount,
  searchKeywordActiveChunks,
  searchSemanticActiveChunks,
} from "../../src/server/retrieval";
import { reprocessDocument, verifyDocument } from "../../src/server/verification/service";
import { seedSyntheticAccount, seedSyntheticSession } from "../fixtures/auth";
import { syntheticPdf } from "../fixtures/document-files";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });
const workerEnv = {
  CONVERSION_URL: "http://convert-worker:8092",
  PADDLEOCR_URL: "http://paddleocr:8091",
  SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
  SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED: "1",
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
  executionId = "exec-s09",
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
    throw new Error(`Unexpected worker URL: ${url}`);
  });
}

async function seedIndexedDocument(options: {
  title: string;
  extractedText: string;
  stage: "PENDING_VERIFICATION" | "ACTIVE" | "REJECTED" | "FAILED" | "DELETED";
  embeddingVector?: number[];
}) {
  const storage = new MemoryStorage();
  const bytes = syntheticPdf();
  const fileName = `${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID().slice(0, 6)}.pdf`;

  const init = await initializeDocumentUpload(
    adminAccount,
    {
      requestKey: randomUUID(),
      title: options.title,
      fileName,
      mimeType: "application/pdf",
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
  storage.objects.set(intent.stagingKey, { bytes, contentType: "application/pdf" });

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

  await extractIngestionStage(makeClaims(job, "extract"), claimed.fileRefToken, {
    database,
    storage,
    fetchImpl: pdfWorkerFetch(options.extractedText),
    env: workerEnv,
    privateKey: dispatchKeys.privateKey,
  });
  await chunkIngestionStage(makeClaims(job, "chunk"), { database });

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

  if (options.stage === "FAILED") {
    await failIngestionStage(
      makeClaims(job, "fail"),
      { errorCode: "OCR_UNTRUSTED_DIGITS", transient: false },
      { database },
    );
  } else {
    await completeIngestionStage(makeClaims(job, "complete"), { database });
  }

  let [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
  [job] = await database.select().from(schema.workflowJobs).where(eq(schema.workflowJobs.id, job.id));

  if (options.stage === "REJECTED") {
    await verifyDocument(
      adminAccount,
      intent.id,
      {
        decision: "REJECT",
        notes: "Synthetic trap rejection",
        expectedSha256: doc.sha256,
        expectedJobId: job.id,
        expectedPipelineVersion: doc.processedPipelineVersion!,
        expectedAttemptId: doc.processedAttemptId!,
        explicitConfirmation: true,
      },
      database,
    );
    [doc] = await database.select().from(schema.sopDocuments).where(eq(schema.sopDocuments.id, intent.id));
  } else if (options.stage === "ACTIVE" || options.stage === "DELETED") {
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
      // Tombstone without physical cleanup so chunks remain in sop_chunks to prove SQL eligibility gating.
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
    await database.delete(schema.sopExtractionPages).where(eq(schema.sopExtractionPages.documentId, documentId)).catch(() => undefined);
    await database.delete(schema.sopVerificationIssues).where(eq(schema.sopVerificationIssues.documentId, documentId)).catch(() => undefined);
  }
  await connection.end();
});

describe("S09/C2/ADR10 real PostgreSQL + pgvector hybrid retrieval, ACTIVE-only gating and race guards", () => {
  it("independently excludes high-scoring PENDING_VERIFICATION, FAILED, REJECTED, DELETED and stale-snapshot traps BEFORE LIMIT 1 in BOTH semantic and keyword branches", async () => {
    const tag = `s09trap${randomUUID().slice(0, 8)}`;
    const queryVec = makeBasisVector(42);
    const activeVec = makeBasisVector(42, 43, 0.35);

    const trapText = `Section 1 ${tag} Calibration\n${tag} ${tag} ${tag} ${tag} CRITICAL UNSAFE OVERRIDE 999.9 bar.`;
    const activeText = `Section 2 ${tag} Verified Valve Procedure\n1. Set intake regulator to 2.75 bar.\n2. Hold for 15 minutes at 121.0 °C.`;

    // Every trap gets an EXACT cosine-distance 0.0 vector and higher term frequency than the ACTIVE chunk.
    const pendingTrap = await seedIndexedDocument({
      title: `SOP-901 ${tag} Pending Trap`,
      extractedText: trapText,
      stage: "PENDING_VERIFICATION",
      embeddingVector: queryVec,
    });
    const failedTrap = await seedIndexedDocument({
      title: `SOP-902 ${tag} Failed Trap`,
      extractedText: trapText,
      stage: "FAILED",
      embeddingVector: queryVec,
    });
    const rejectedTrap = await seedIndexedDocument({
      title: `SOP-903 ${tag} Rejected Trap`,
      extractedText: trapText,
      stage: "REJECTED",
      embeddingVector: queryVec,
    });
    const deletedTrap = await seedIndexedDocument({
      title: `SOP-904 ${tag} Deleted Tombstone Trap`,
      extractedText: trapText,
      stage: "DELETED",
      embeddingVector: queryVec,
    });
    const activeDoc = await seedIndexedDocument({
      title: `SOP-905 ${tag} Verified Active Procedure`,
      extractedText: activeText,
      stage: "ACTIVE",
      embeddingVector: activeVec,
    });

    // Attach a superseded stale-snapshot job + high-scoring chunk directly onto the ACTIVE document.
    const [staleJob] = await database
      .insert(schema.workflowJobs)
      .values({
        ownerId: adminAccount.id,
        requestKey: randomUUID(),
        inputHash: createHash("sha256").update(`stale-${tag}`).digest("hex"),
        kind: "document_ingestion",
        documentId: activeDoc.documentId,
        sourceSha256: activeDoc.doc.sha256,
        pipelineVersion: "s05-ingestion-superseded-v0",
        state: "COMPLETED",
        stage: "completed",
        attemptId: randomUUID(),
        attemptNumber: 1,
        dispatchNonce: randomUUID(),
        dispatchCount: 1,
        dispatchNextAt: sql`clock_timestamp() + interval '60 seconds'`,
        attemptDeadline: sql`clock_timestamp() + interval '60 seconds'`,
      })
      .returning();

    const staleChunkText = `${trapText} STALE SNAPSHOT SHOULD NEVER RETURN`;
    const [staleChunk] = await database
      .insert(schema.sopChunks)
      .values({
        documentId: activeDoc.documentId,
        jobId: staleJob.id,
        sourceSha256: activeDoc.doc.sha256,
        pipelineVersion: staleJob.pipelineVersion!,
        sequence: 0,
        sectionPath: `Section 0 > ${tag} Superseded`,
        pageStart: 1,
        pageEnd: 1,
        contentType: "procedure",
        text: staleChunkText,
        contentHash: createHash("sha256").update(staleChunkText).digest("hex"),
        tokenEstimate: 30,
        embedding: queryVec,
        embeddingModel: "text-embedding-3-small",
        embeddingDimensions: approvedEmbeddingDimensions,
      })
      .returning();

    const forbiddenChunkIds = new Set([
      ...pendingTrap.chunks.map((c) => c.id),
      ...failedTrap.chunks.map((c) => c.id),
      ...rejectedTrap.chunks.map((c) => c.id),
      ...deletedTrap.chunks.map((c) => c.id),
      staleChunk.id,
    ]);
    expect(forbiddenChunkIds.size).toBeGreaterThanOrEqual(5);

    // Branch 1: Semantic pgvector search with LIMIT 1 must select ACTIVE chunk, never any trap.
    const semanticTop1 = await searchSemanticActiveChunks(queryVec, { database, limit: 1 });
    expect(semanticTop1).toHaveLength(1);
    expect(semanticTop1[0].documentId).toBe(activeDoc.documentId);
    expect(semanticTop1[0].jobId).toBe(activeDoc.doc.activeJobId);
    expect(forbiddenChunkIds.has(semanticTop1[0].chunkId)).toBe(false);

    const semanticTop15 = await searchSemanticActiveChunks(queryVec, { database, limit: 15 });
    for (const candidate of semanticTop15) {
      expect(forbiddenChunkIds.has(candidate.chunkId)).toBe(false);
    }

    // Branch 2: Keyword full-text search with LIMIT 1 must select ACTIVE chunk, never any trap.
    const keywordTop1 = await searchKeywordActiveChunks(tag, { database, limit: 1 });
    expect(keywordTop1).toHaveLength(1);
    expect(keywordTop1[0].documentId).toBe(activeDoc.documentId);
    expect(keywordTop1[0].jobId).toBe(activeDoc.doc.activeJobId);
    expect(forbiddenChunkIds.has(keywordTop1[0].chunkId)).toBe(false);

    const keywordTop15 = await searchKeywordActiveChunks(tag, { database, limit: 15 });
    expect(keywordTop15.length).toBeGreaterThanOrEqual(1);
    for (const candidate of keywordTop15) {
      expect(forbiddenChunkIds.has(candidate.chunkId)).toBe(false);
    }

    // Malicious SQL/tsquery characters never error or bypass ACTIVE eligibility.
    const injectedKeyword = await searchKeywordActiveChunks(
      `${tag} '; DROP TABLE app.sop_chunks; -- | & ! () :*`,
      { database, limit: 5 },
    );
    expect(injectedKeyword.every((candidate) => !forbiddenChunkIds.has(candidate.chunkId))).toBe(true);
    expect(await searchKeywordActiveChunks("!!! &&& ||| ???", { database, limit: 5 })).toEqual([]);
  });

  it("executes full RRF + rerank + post-rerank original reload preserving exact digits, units and table headers", async () => {
    const tag = `s09fid${randomUUID().slice(0, 8)}`;
    const queryVec = makeBasisVector(120);
    const literalTableText = [
      `Section 4 > ${tag} Balance Tolerance Table`,
      "Table 4.2 Reference Weight Limits | Weight | Min | Max | Drift | Unit |",
      "| 10.000 mg | 9.950 | 10.050 | 0.050 | mg |",
      "| 50.0000 g | 49.9980 | 50.0020 | 0.0020 | g |",
    ].join("\n");

    const seeded = await seedIndexedDocument({
      title: `SOP-402 ${tag} Analytical Balance Calibration`,
      extractedText: literalTableText,
      stage: "ACTIVE",
      embeddingVector: queryVec,
    });

    const result = await retrieveActiveSopEvidenceForAccount(
      staffAccount,
      {
        question: `What are the ${tag} 10.000 mg and 50.0000 g calibration drift limits in SOP-402?`,
      },
      {
        database,
        env: workerEnv,
        embedTextsImpl: async () => ({
          model: "text-embedding-3-small",
          dimensions: approvedEmbeddingDimensions,
          vectors: [queryVec],
        }),
      },
    );

    expect(result.kind).toBe("evidence");
    if (result.kind !== "evidence") return;
    expect(result.passages.length).toBeGreaterThanOrEqual(1);
    expect(result.passages[0].documentId).toBe(seeded.documentId);
    expect(result.passages[0].text).toContain("10.000 mg");
    expect(result.passages[0].text).toContain("0.050");
    expect(result.passages[0].text).toContain("50.0000 g");
    expect(result.passages[0].text).toContain("0.0020");
    expect(result.passages[0].text).toContain("Table 4.2 Reference Weight Limits");
    expect(result.metadata.timings.semanticMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.timings.keywordMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.timings.fetchOriginalMs).toBeGreaterThanOrEqual(0);
  });

  it("excludes revoked snapshots on mid-flight Admin delete race and reprocess/snapshot mismatch race", async () => {
    const tag = `s09race${randomUUID().slice(0, 8)}`;
    const queryVec = makeBasisVector(250);
    const activeDoc = await seedIndexedDocument({
      title: `SOP-701 ${tag} Delete Race Procedure`,
      extractedText: `Section 1 ${tag} Line Clearance\n1. Remove all prior batch labels before starting ${tag}.`,
      stage: "ACTIVE",
      embeddingVector: queryVec,
    });

    // Mid-flight delete race: document is ACTIVE during search, deleted right before post-rerank original reload.
    let deletedMidFlight = false;
    const deleteRaceResult = await retrieveActiveSopEvidence(
      { question: tag, parameters: { finalTopK: 1 } },
      {
        database,
        env: workerEnv,
        embedTextsImpl: async () => ({
          model: "text-embedding-3-small",
          dimensions: approvedEmbeddingDimensions,
          vectors: [queryVec],
        }),
        loadOriginalPassagesImpl: async (expectedSnapshots, opts) => {
          if (!deletedMidFlight) {
            deletedMidFlight = true;
            await deleteDocument(adminAccount, activeDoc.documentId, database);
          }
          return loadOriginalActivePassagesByIds(expectedSnapshots, opts);
        },
      },
    );

    expect(deletedMidFlight).toBe(true);
    expect(deleteRaceResult).toMatchObject({
      kind: "no_evidence",
      reason: "ELIGIBILITY_REVOKED",
      fallbackMessage: noEvidenceFallbackMessage,
      passages: [],
    });

    // Reprocess / snapshot-change race: a PENDING_VERIFICATION document reprocessed or mismatched snapshot hash is excluded.
    const pendingForReprocess = await seedIndexedDocument({
      title: `SOP-702 ${tag} Reprocess Race Procedure`,
      extractedText: `Section 1 ${tag} Reprocess Draft\n1. Verify torque 12.5 Nm.`,
      stage: "PENDING_VERIFICATION",
      embeddingVector: makeBasisVector(251),
    });
    const staleChunk = pendingForReprocess.chunks[0];
    await reprocessDocument(
      adminAccount,
      pendingForReprocess.documentId,
      { expectedSha256: pendingForReprocess.doc.sha256 },
      database,
    );
    await database
      .update(schema.workflowJobs)
      .set({ dispatchNextAt: sql`clock_timestamp() + interval '60 seconds'` })
      .where(eq(schema.workflowJobs.documentId, pendingForReprocess.documentId));

    const reloadedAfterReprocess = await loadOriginalActivePassagesByIds(
      [
        {
          chunkId: staleChunk.id,
          documentId: staleChunk.documentId,
          jobId: staleChunk.jobId,
          pipelineVersion: staleChunk.pipelineVersion,
          sourceSha256: staleChunk.sourceSha256,
          contentHash: staleChunk.contentHash,
        },
      ],
      { database },
    );
    expect(reloadedAfterReprocess).toEqual([]);

    // Snapshot contentHash mismatch against an ACTIVE document is also rejected by post-rerank reload.
    const activeMismatchDoc = await seedIndexedDocument({
      title: `SOP-703 ${tag} Hash Mismatch Check`,
      extractedText: `Section 1 ${tag} Verification\n1. Hold pressure at 3.2 bar.`,
      stage: "ACTIVE",
      embeddingVector: makeBasisVector(252),
    });
    const realChunk = activeMismatchDoc.chunks[0];
    const mismatchedReload = await loadOriginalActivePassagesByIds(
      [
        {
          chunkId: realChunk.id,
          documentId: realChunk.documentId,
          jobId: realChunk.jobId,
          pipelineVersion: realChunk.pipelineVersion,
          sourceSha256: realChunk.sourceSha256,
          contentHash: createHash("sha256").update("tampered-hash").digest("hex"),
        },
      ],
      { database },
    );
    expect(mismatchedReload).toEqual([]);
  });

  it("denies deactivated users server-side before and after retrieval in retrieveActiveSopEvidenceForAccount", async () => {
    const embedSpy = vi.fn(async () => ({
      model: "text-embedding-3-small",
      dimensions: approvedEmbeddingDimensions,
      vectors: [makeBasisVector(300)],
    }));

    // Deactivate staff before request -> fails 401 UNAUTHENTICATED without invoking embed/search.
    await database
      .update(schema.authUsers)
      .set({ active: false })
      .where(eq(schema.authUsers.id, staffAccount.id));

    await expect(
      retrieveActiveSopEvidenceForAccount(
        staffAccount,
        { question: "What is SOP-101?" },
        { database, env: workerEnv, embedTextsImpl: embedSpy },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(embedSpy).not.toHaveBeenCalled();

    // Re-activate with fresh session, then deactivate mid-flight during embedding -> denied before release.
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
      retrieveActiveSopEvidenceForAccount(
        staffAccount,
        { question: "What is SOP-101?" },
        {
          database,
          env: workerEnv,
          embedTextsImpl: async () => {
            await database
              .update(schema.authUsers)
              .set({ active: false })
              .where(eq(schema.authUsers.id, staffAccount.id));
            return {
              model: "text-embedding-3-small",
              dimensions: approvedEmbeddingDimensions,
              vectors: [makeBasisVector(301)],
            };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
  });
});
