import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { approvedEmbeddingDimensions } from "../../src/server/ingestion/config";
import {
  extractKeywordTokens,
  noEvidenceFallbackMessage,
  retrieveActiveSopEvidence,
  type ActiveChunkCandidate,
  type KeywordCandidate,
  type SemanticCandidate,
} from "../../src/server/retrieval";

const requiredPrdCategories = [
  "exact_sop_code_title",
  "paraphrase",
  "multi_section_procedure",
  "follow_up_question",
  "unsupported_question",
  "inactive_lifecycle_trap",
  "near_duplicate_conflicting",
  "scanned_numeric_table_trap",
  "forged_invalid_citation_trap",
  "prompt_injection_trap",
  "revoked_source_case",
] as const;

const benchmarkDatasetSchema = z.object({
  version: z.literal("1.0.0"),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  syntheticOnly: z.literal(true),
  description: z.string().min(10),
  categories: z.array(
    z.object({
      id: z.enum(requiredPrdCategories),
      description: z.string().min(10),
    }),
  ),
  documents: z.array(
    z.object({
      documentId: z.string().min(1),
      code: z.string().min(1),
      title: z.string().min(1),
      fileName: z.string().min(1),
      status: z.enum([
        "UPLOADED",
        "PROCESSING",
        "PENDING_VERIFICATION",
        "ACTIVE",
        "REJECTED",
        "FAILED",
        "DELETED",
      ]),
      sourceFormat: z.enum(["native_pdf", "scanned_pdf_ocr", "docx"]),
    }),
  ),
  chunks: z.array(
    z.object({
      chunkId: z.string().min(1),
      documentId: z.string().min(1),
      documentStatus: z.enum([
        "UPLOADED",
        "PROCESSING",
        "PENDING_VERIFICATION",
        "ACTIVE",
        "REJECTED",
        "FAILED",
        "DELETED",
      ]),
      isActiveSnapshot: z.boolean(),
      sequence: z.number().int().min(0),
      sectionPath: z.string().min(1),
      pageStart: z.number().int().min(1).nullable(),
      pageEnd: z.number().int().min(1).nullable(),
      contentType: z.enum(["procedure", "table", "narrative", "mixed"]),
      sourceFormat: z.enum(["native_pdf", "scanned_pdf_ocr", "docx"]),
      text: z.string().min(1),
    }),
  ),
  cases: z.array(
    z.object({
      id: z.string().regex(/^BM-\d{2}$/),
      category: z.enum(requiredPrdCategories),
      question: z.string().min(5),
      history: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1),
          }),
        )
        .optional(),
      expectedOutcome: z.enum(["supported", "no_evidence", "revoked_source"]),
      expectedFallbackMessage: z.literal(noEvidenceFallbackMessage).nullable(),
      expectedDocumentIds: z.array(z.string().min(1)),
      expectedChunkIds: z.array(z.string().min(1)),
      forbiddenChunkIds: z.array(z.string().min(1)),
      mustPreserveTokens: z.array(z.string().min(1)),
      notes: z.string().min(5),
    }),
  ),
});

const datasetPath = join(process.cwd(), "tests", "fixtures", "benchmark-50.json");
const rawDataset = JSON.parse(readFileSync(datasetPath, "utf8")) as unknown;
const fixtureEnv = {
  SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED: "1",
  SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
  AUTH_BASE_URL: "http://127.0.0.1:3000",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeVector(seed: number): number[] {
  const vector = Array.from({ length: approvedEmbeddingDimensions }, (_, index) =>
    index === seed % approvedEmbeddingDimensions ? 1 : 0.001,
  );
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

describe("S09/PRD-14 versioned 50-question synthetic RAG benchmark dataset", () => {
  it("contains exactly 50 unique valid cases covering all 11 PRD Section 14 categories and valid chunk/document references", () => {
    const parsed = benchmarkDatasetSchema.parse(rawDataset);
    expect(parsed.cases).toHaveLength(50);

    const caseIds = new Set(parsed.cases.map((entry) => entry.id));
    expect(caseIds.size).toBe(50);

    const categoryCounts = new Map<string, number>();
    for (const entry of parsed.cases) {
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
    }
    for (const requiredCategory of requiredPrdCategories) {
      expect(categoryCounts.get(requiredCategory) ?? 0).toBeGreaterThanOrEqual(2);
    }

    const docById = new Map(parsed.documents.map((doc) => [doc.documentId, doc]));
    const chunkById = new Map(parsed.chunks.map((chunk) => [chunk.chunkId, chunk]));
    expect(docById.size).toBe(parsed.documents.length);
    expect(chunkById.size).toBe(parsed.chunks.length);

    for (const chunk of parsed.chunks) {
      const parentDoc = docById.get(chunk.documentId);
      expect(parentDoc).toBeDefined();
      expect(chunk.documentStatus).toBe(parentDoc?.status);
      if (chunk.documentStatus !== "ACTIVE") {
        expect(chunk.isActiveSnapshot).toBe(false);
      }
    }

    for (const entry of parsed.cases) {
      for (const docId of entry.expectedDocumentIds) {
        const doc = docById.get(docId);
        expect(doc?.status).toBe("ACTIVE");
      }
      for (const chunkId of entry.expectedChunkIds) {
        const chunk = chunkById.get(chunkId);
        expect(chunk?.documentStatus).toBe("ACTIVE");
        expect(chunk?.isActiveSnapshot).toBe(true);
      }
      for (const forbiddenId of entry.forbiddenChunkIds) {
        expect(chunkById.has(forbiddenId)).toBe(true);
      }
      if (entry.expectedOutcome === "supported") {
        expect(entry.expectedChunkIds.length).toBeGreaterThan(0);
        expect(entry.expectedFallbackMessage).toBeNull();
      } else {
        expect(entry.expectedChunkIds).toEqual([]);
        expect(entry.expectedFallbackMessage).toBe(noEvidenceFallbackMessage);
      }
      if (entry.category === "follow_up_question") {
        expect(entry.history && entry.history.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("achieves high synthetic-fixture retrieval recall across all 50 cases while rejecting inactive traps, unsupported queries and revoked sources", async () => {
    const dataset = benchmarkDatasetSchema.parse(rawDataset);
    const docById = new Map(dataset.documents.map((doc) => [doc.documentId, doc]));

    const activeCandidates: ActiveChunkCandidate[] = dataset.chunks
      .filter((chunk) => chunk.documentStatus === "ACTIVE" && chunk.isActiveSnapshot)
      .map((chunk) => {
        const doc = docById.get(chunk.documentId)!;
        return {
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          documentTitle: doc.title,
          fileName: doc.fileName,
          jobId: `job-${chunk.documentId}`,
          pipelineVersion: "s05-ingestion-v1",
          sourceSha256: sha256(chunk.documentId),
          sequence: chunk.sequence,
          sectionPath: chunk.sectionPath,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          contentType: chunk.contentType,
          text: chunk.text,
          contentHash: sha256(chunk.text),
          tokenEstimate: Math.max(10, Math.ceil(chunk.text.length / 4)),
        };
      });

    const activeById = new Map(activeCandidates.map((candidate) => [candidate.chunkId, candidate]));
    let passed = 0;

    for (let index = 0; index < dataset.cases.length; index++) {
      const benchmarkCase = dataset.cases[index];

      const result = await retrieveActiveSopEvidence(
        {
          question: benchmarkCase.question,
          history: benchmarkCase.history ?? [],
        },
        {
          env: fixtureEnv,
          embedTextsImpl: async () => ({
            model: "text-embedding-3-small",
            dimensions: approvedEmbeddingDimensions,
            vectors: [fakeVector(index + 1)],
          }),
          searchSemanticImpl: async () => {
            // Simulate random-baseline semantic neighbors so fixture recall exercises keyword + rerank + ACTIVE filter.
            return activeCandidates.slice(0, 15).map(
              (candidate, rank): SemanticCandidate => ({
                ...candidate,
                semanticRank: rank + 1,
                cosineDistance: 0.92,
                semanticScore: 0.08,
              }),
            );
          },
          searchKeywordImpl: async (standaloneQuery, options) => {
            const queryTokens = extractKeywordTokens(standaloneQuery, 24);
            if (queryTokens.length === 0) return [];
            const scored = activeCandidates
              .map((candidate) => {
                const haystack = new Set(
                  extractKeywordTokens(
                    `${candidate.documentTitle} ${candidate.sectionPath} ${candidate.text}`,
                    256,
                  ),
                );
                const matches = queryTokens.filter((token) => haystack.has(token)).length;
                return { candidate, score: matches / queryTokens.length };
              })
              .filter((entry) => entry.score > 0)
              .sort((left, right) => right.score - left.score || left.candidate.chunkId.localeCompare(right.candidate.chunkId))
              .slice(0, options?.limit ?? 15);

            return scored.map(
              (entry, rank): KeywordCandidate => ({
                ...entry.candidate,
                keywordRank: rank + 1,
                keywordScore: entry.score,
              }),
            );
          },
          loadOriginalPassagesImpl: async (snapshots) => {
            if (benchmarkCase.expectedOutcome === "revoked_source") {
              return [];
            }
            return snapshots
              .map((snap) => activeById.get(snap.chunkId))
              .filter((row): row is ActiveChunkCandidate => Boolean(row));
          },
        },
      );

      if (benchmarkCase.expectedOutcome === "supported") {
        if (result.kind !== "evidence") continue;
        const returnedIds = new Set(result.passages.map((passage) => passage.chunkId));
        const allExpectedFound = benchmarkCase.expectedChunkIds.every((id) => returnedIds.has(id));
        const noForbiddenTop1 = !benchmarkCase.forbiddenChunkIds.includes(result.passages[0].chunkId);
        const noNonActiveLeaked = result.passages.every((passage) => activeById.has(passage.chunkId));
        if (allExpectedFound && noForbiddenTop1 && noNonActiveLeaked) {
          passed++;
        }
      } else if (benchmarkCase.expectedOutcome === "revoked_source") {
        expect(result.kind).toBe("no_evidence");
        if (result.kind === "no_evidence" && result.reason === "ELIGIBILITY_REVOKED") {
          passed++;
        }
      } else {
        // Unsupported / inactive-trap / forged-citation / direct-injection cases must never leak forbidden chunks.
        if (result.kind === "no_evidence" && result.fallbackMessage === noEvidenceFallbackMessage) {
          passed++;
        } else if (result.kind === "evidence") {
          const leakedForbidden = result.passages.some((passage) =>
            benchmarkCase.forbiddenChunkIds.includes(passage.chunkId),
          );
          expect(leakedForbidden).toBe(false);
        }
      }
    }

    // Synthetic fixture baseline verification (separate from live-model V01 acceptance >= 43/50).
    expect(passed).toBeGreaterThanOrEqual(45);
  });
});
