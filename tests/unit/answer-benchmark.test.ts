import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  generateValidatedSopAnswer,
  noEvidenceFallbackMessage,
  validateCandidateDeterministically,
} from "../../src/server/answers";
import { approvedEmbeddingDimensions } from "../../src/server/ingestion/config";
import {
  extractKeywordTokens,
  type ActiveChunkCandidate,
  type KeywordCandidate,
  type RerankedPassage,
  type SemanticCandidate,
} from "../../src/server/retrieval";

const benchmarkSchema = z.object({
  version: z.literal("1.0.0"),
  documents: z.array(
    z.object({
      documentId: z.string(),
      code: z.string(),
      title: z.string(),
      fileName: z.string(),
      status: z.string(),
      sourceFormat: z.enum(["native_pdf", "scanned_pdf_ocr", "docx"]),
    }),
  ),
  chunks: z.array(
    z.object({
      chunkId: z.string(),
      documentId: z.string(),
      documentStatus: z.string(),
      isActiveSnapshot: z.boolean(),
      sequence: z.number().int().min(0),
      sectionPath: z.string(),
      pageStart: z.number().int().nullable(),
      pageEnd: z.number().int().nullable(),
      contentType: z.enum(["procedure", "table", "narrative", "mixed"]),
      sourceFormat: z.enum(["native_pdf", "scanned_pdf_ocr", "docx"]),
      text: z.string(),
    }),
  ),
  cases: z.array(
    z.object({
      id: z.string(),
      category: z.string(),
      question: z.string(),
      history: z
        .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
        .optional(),
      expectedOutcome: z.enum(["supported", "no_evidence", "revoked_source"]),
      expectedFallbackMessage: z.literal(noEvidenceFallbackMessage).nullable(),
      expectedDocumentIds: z.array(z.string()),
      expectedChunkIds: z.array(z.string()),
      forbiddenChunkIds: z.array(z.string()),
      mustPreserveTokens: z.array(z.string()),
    }),
  ),
});

const datasetPath = join(process.cwd(), "tests", "fixtures", "benchmark-50.json");
const dataset = benchmarkSchema.parse(JSON.parse(readFileSync(datasetPath, "utf8")));

const fixtureEnv = {
  SOP_LOCAL_ANSWER_FIXTURE_ENABLED: "1",
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

describe("S10/C2-C5/PRD-14 50-question synthetic end-to-end answer validation benchmark", () => {
  it("meets >=43/50 correct, 100% valid supporting citations, 0 invented procedural steps, and exact no-evidence fallback", async () => {
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

    let correctCount = 0;
    let supportedAnsweredCount = 0;
    let validCitationAnswerCount = 0;
    let inventedStepCount = 0;
    const failedCaseIds: string[] = [];

    const stageTotals = {
      retrievalMs: 0,
      generateMs: 0,
      deterministicCheckMs: 0,
      judgeMs: 0,
      citationResolveMs: 0,
      totalMs: 0,
    };

    for (let index = 0; index < dataset.cases.length; index++) {
      const benchmarkCase = dataset.cases[index];

      const result = await generateValidatedSopAnswer(
        {
          question: benchmarkCase.question,
          history: benchmarkCase.history ?? [],
        },
        {
          env: fixtureEnv,
          retrievalOptions: {
            embedTextsImpl: async () => ({
              model: "text-embedding-3-small",
              dimensions: approvedEmbeddingDimensions,
              vectors: [fakeVector(index + 1)],
            }),
            searchSemanticImpl: async () =>
              activeCandidates.slice(0, 15).map(
                (candidate, rank): SemanticCandidate => ({
                  ...candidate,
                  semanticRank: rank + 1,
                  cosineDistance: 0.92,
                  semanticScore: 0.08,
                }),
              ),
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
                .sort(
                  (left, right) =>
                    right.score - left.score || left.candidate.chunkId.localeCompare(right.candidate.chunkId),
                )
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
          resolveCitationPassagesImpl: async (snapshots) => {
            if (benchmarkCase.expectedOutcome === "revoked_source") {
              return [];
            }
            return snapshots
              .map((snap) => activeById.get(snap.chunkId))
              .filter((row): row is ActiveChunkCandidate => Boolean(row));
          },
        },
      );

      stageTotals.retrievalMs += result.metadata.timings.retrievalMs;
      stageTotals.generateMs += result.metadata.timings.generateMs;
      stageTotals.deterministicCheckMs += result.metadata.timings.deterministicCheckMs;
      stageTotals.judgeMs += result.metadata.timings.judgeMs;
      stageTotals.citationResolveMs += result.metadata.timings.citationResolveMs;
      stageTotals.totalMs += result.metadata.timings.totalMs;

      if (result.kind === "supported") {
        supportedAnsweredCount++;
        const citedIds = new Set(result.sources.map((source) => source.chunkId));
        const allSourcesActiveAndReal = result.sources.every((source) => {
          const active = activeById.get(source.chunkId);
          if (!active) return false;
          const doc = docById.get(source.documentId);
          const pageValid =
            doc?.sourceFormat === "docx"
              ? source.pageStart === undefined && source.pageEnd === undefined
              : source.pageStart === active.pageStart && source.pageEnd === active.pageEnd;
          return (
            active.documentId === source.documentId &&
            active.documentTitle === source.sopTitle &&
            active.sectionPath === source.section &&
            source.sourcePath.startsWith(`/api/documents/${encodeURIComponent(source.documentId)}/source`) &&
            pageValid
          );
        });

        const citedPassages: RerankedPassage[] = Array.from(citedIds)
          .map((id) => activeById.get(id))
          .filter((row): row is ActiveChunkCandidate => Boolean(row))
          .map((row) => ({
            ...row,
            rerankScore: 0.9,
            rrfScore: 0.03,
            semanticRank: 1,
            keywordRank: 1,
          }));
        const groundCheck = validateCandidateDeterministically(
          {
            status: "supported",
            isProcedural: result.isProcedural,
            claims: result.claims,
          },
          citedPassages,
        );
        if (!groundCheck.ok) {
          inventedStepCount++;
        }

        const expectedDocsOk =
          benchmarkCase.expectedOutcome === "supported" &&
          benchmarkCase.expectedDocumentIds.every((docId) =>
            result.sources.some((source) => source.documentId === docId),
          );
        if (allSourcesActiveAndReal && expectedDocsOk) {
          validCitationAnswerCount++;
        }
      }

      if (benchmarkCase.expectedOutcome === "supported") {
        if (result.kind !== "supported") {
          failedCaseIds.push(benchmarkCase.id);
          continue;
        }
        const sourceChunkIds = new Set(result.sources.map((source) => source.chunkId));
        const allExpectedChunksCited = benchmarkCase.expectedChunkIds.every((id) =>
          sourceChunkIds.has(id),
        );
        const noForbiddenCited = !benchmarkCase.forbiddenChunkIds.some((id) =>
          sourceChunkIds.has(id),
        );
        const lowerAnswer = result.answer.toLowerCase();
        const allTokensPreserved = benchmarkCase.mustPreserveTokens.every((token) =>
          lowerAnswer.includes(token.toLowerCase()),
        );
        const noSecretOrInjection =
          !lowerAnswer.includes("500 °c") && !lowerAnswer.includes("openai_api_key");

        if (allExpectedChunksCited && noForbiddenCited && allTokensPreserved && noSecretOrInjection) {
          correctCount++;
        } else {
          failedCaseIds.push(benchmarkCase.id);
        }
      } else if (benchmarkCase.expectedOutcome === "revoked_source") {
        if (
          result.kind === "no_evidence" &&
          result.answer === noEvidenceFallbackMessage &&
          result.sources.length === 0 &&
          result.reason === "SOURCE_ELIGIBILITY_REVOKED"
        ) {
          correctCount++;
        } else {
          failedCaseIds.push(benchmarkCase.id);
        }
      } else {
        if (
          result.kind === "no_evidence" &&
          result.answer === noEvidenceFallbackMessage &&
          result.sources.length === 0
        ) {
          correctCount++;
        } else {
          failedCaseIds.push(benchmarkCase.id);
        }
      }
    }

    expect(inventedStepCount).toBe(0);
    expect(supportedAnsweredCount).toBeGreaterThan(0);
    expect(validCitationAnswerCount).toBe(supportedAnsweredCount);
    expect(correctCount, `Failed benchmark cases: ${failedCaseIds.join(", ")}`).toBeGreaterThanOrEqual(43);
    expect(stageTotals.totalMs).toBeGreaterThanOrEqual(0);
  });
});
