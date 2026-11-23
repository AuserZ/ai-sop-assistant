import { and, asc, desc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { sopChunks, sopDocuments } from "../db/schema";
import type { AuthDatabase } from "../auth/rate-limit";
import { approvedEmbeddingDimensions } from "../ingestion/config";
import { validateEmbeddingVector } from "../ingestion/embeddings";
import {
  retrievalDefaults,
  RetrievalError,
  type ActiveChunkCandidate,
  type KeywordCandidate,
  type SemanticCandidate,
  type SnapshotIdentity,
} from "./contracts";

const keywordStopwords = new Set([
  "a",
  "about",
  "after",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "being",
  "but",
  "by",
  "can",
  "could",
  "describe",
  "did",
  "do",
  "does",
  "during",
  "explain",
  "for",
  "from",
  "here",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "me",
  "might",
  "must",
  "of",
  "on",
  "or",
  "our",
  "please",
  "shall",
  "should",
  "tell",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const alphanumericTokenPattern = /^[a-z0-9]+$/i;

export function activeChunkEligibilityPredicate(): SQL {
  return and(
    eq(sopDocuments.status, "ACTIVE"),
    isNotNull(sopDocuments.activeJobId),
    isNotNull(sopDocuments.activePipelineVersion),
    isNotNull(sopDocuments.activeAttemptId),
    isNotNull(sopDocuments.verifiedBy),
    isNotNull(sopDocuments.verifiedAt),
    eq(sopChunks.jobId, sopDocuments.activeJobId),
    eq(sopChunks.pipelineVersion, sopDocuments.activePipelineVersion),
    eq(sopChunks.sourceSha256, sopDocuments.sha256),
  )!;
}

export function extractKeywordTokens(query: string, maxTokens: number = retrievalDefaults.maxKeywordTokens): string[] {
  const rawMatches = query.match(/[A-Za-z0-9]+/g) ?? [];
  const allTokens: string[] = [];
  const seen = new Set<string>();

  for (const match of rawMatches) {
    const token = match.toLowerCase();
    if (!alphanumericTokenPattern.test(token) || seen.has(token)) continue;
    seen.add(token);
    allTokens.push(token);
  }

  if (allTokens.length === 0) return [];

  const substantive = allTokens.filter((token) => !keywordStopwords.has(token));
  const selected = substantive.length > 0 ? substantive : allTokens;
  return selected.slice(0, Math.max(1, maxTokens));
}

export function buildSafeKeywordTsQuery(query: string, maxTokens: number = retrievalDefaults.maxKeywordTokens): string | null {
  const tokens = extractKeywordTokens(query, maxTokens);
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    if (!alphanumericTokenPattern.test(token)) {
      return null;
    }
  }
  return tokens.join(" | ");
}

const activeChunkColumns = {
  chunkId: sopChunks.id,
  documentId: sopDocuments.id,
  documentTitle: sopDocuments.title,
  fileName: sopDocuments.fileName,
  jobId: sopChunks.jobId,
  pipelineVersion: sopChunks.pipelineVersion,
  sourceSha256: sopChunks.sourceSha256,
  sequence: sopChunks.sequence,
  sectionPath: sopChunks.sectionPath,
  pageStart: sopChunks.pageStart,
  pageEnd: sopChunks.pageEnd,
  contentType: sopChunks.contentType,
  text: sopChunks.text,
  contentHash: sopChunks.contentHash,
  tokenEstimate: sopChunks.tokenEstimate,
};

function normalizeTopK(limit: number | undefined, fallback: number): number {
  const resolved = limit ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 20) {
    throw new RetrievalError("RETRIEVAL_INVALID_INPUT", false, 400);
  }
  return resolved;
}

export async function searchSemanticActiveChunks(
  embedding: number[],
  options: {
    database?: AuthDatabase;
    limit?: number;
  } = {},
): Promise<SemanticCandidate[]> {
  if (!validateEmbeddingVector(embedding, approvedEmbeddingDimensions)) {
    throw new RetrievalError("RETRIEVAL_VECTOR_INVALID", false, 500);
  }

  const limit = normalizeTopK(options.limit, retrievalDefaults.semanticTopK);
  const database = options.database ?? getDatabase();
  const vectorLiteral = `[${embedding.join(",")}]`;
  // Schema-qualified operator works even when sop_runtime search_path excludes public.
  const cosineDistanceExpr = sql<number>`(${sopChunks.embedding} OPERATOR(public.<=>) ${vectorLiteral}::public.vector)::double precision`;

  const rows = await database
    .select({
      ...activeChunkColumns,
      cosineDistance: cosineDistanceExpr,
    })
    .from(sopChunks)
    .innerJoin(sopDocuments, eq(sopChunks.documentId, sopDocuments.id))
    .where(
      and(
        activeChunkEligibilityPredicate(),
        isNotNull(sopChunks.embedding),
        eq(sopChunks.embeddingDimensions, approvedEmbeddingDimensions),
      ),
    )
    .orderBy(asc(cosineDistanceExpr), asc(sopChunks.id))
    .limit(limit);

  return rows.map((row, index) => {
    const cosineDistance = Number(row.cosineDistance);
    const semanticScore = Number(Math.max(-1, Math.min(1, 1 - cosineDistance)).toFixed(6));
    return {
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentTitle: row.documentTitle,
      fileName: row.fileName,
      jobId: row.jobId,
      pipelineVersion: row.pipelineVersion,
      sourceSha256: row.sourceSha256,
      sequence: row.sequence,
      sectionPath: row.sectionPath,
      pageStart: row.pageStart,
      pageEnd: row.pageEnd,
      contentType: row.contentType,
      text: row.text,
      contentHash: row.contentHash,
      tokenEstimate: row.tokenEstimate,
      semanticRank: index + 1,
      cosineDistance,
      semanticScore,
    };
  });
}

export async function searchKeywordActiveChunks(
  query: string,
  options: {
    database?: AuthDatabase;
    limit?: number;
  } = {},
): Promise<KeywordCandidate[]> {
  const limit = normalizeTopK(options.limit, retrievalDefaults.keywordTopK);
  const tsQueryText = buildSafeKeywordTsQuery(query);
  if (!tsQueryText) return [];

  const database = options.database ?? getDatabase();
  const tsQueryExpr = sql`to_tsquery('simple', ${tsQueryText})`;
  const rankExpr = sql<number>`ts_rank_cd(${sopChunks.searchVector}, ${tsQueryExpr}, 32)::double precision`;

  const rows = await database
    .select({
      ...activeChunkColumns,
      keywordScore: rankExpr,
    })
    .from(sopChunks)
    .innerJoin(sopDocuments, eq(sopChunks.documentId, sopDocuments.id))
    .where(
      and(
        activeChunkEligibilityPredicate(),
        sql`${sopChunks.searchVector} @@ ${tsQueryExpr}`,
      ),
    )
    .orderBy(desc(rankExpr), asc(sopChunks.id))
    .limit(limit);

  return rows.map((row, index) => ({
    chunkId: row.chunkId,
    documentId: row.documentId,
    documentTitle: row.documentTitle,
    fileName: row.fileName,
    jobId: row.jobId,
    pipelineVersion: row.pipelineVersion,
    sourceSha256: row.sourceSha256,
    sequence: row.sequence,
    sectionPath: row.sectionPath,
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
    contentType: row.contentType,
    text: row.text,
    contentHash: row.contentHash,
    tokenEstimate: row.tokenEstimate,
    keywordRank: index + 1,
    keywordScore: Number(row.keywordScore),
  }));
}

export async function loadOriginalActivePassagesByIds(
  expectedSnapshots: SnapshotIdentity[],
  options: { database?: AuthDatabase } = {},
): Promise<ActiveChunkCandidate[]> {
  if (expectedSnapshots.length === 0) return [];

  const uniqueIds = Array.from(new Set(expectedSnapshots.map((snapshot) => snapshot.chunkId)));
  const database = options.database ?? getDatabase();

  const rows = await database
    .select(activeChunkColumns)
    .from(sopChunks)
    .innerJoin(sopDocuments, eq(sopChunks.documentId, sopDocuments.id))
    .where(and(activeChunkEligibilityPredicate(), inArray(sopChunks.id, uniqueIds)));

  const rowById = new Map(rows.map((row) => [row.chunkId, row]));
  const ordered: ActiveChunkCandidate[] = [];
  const emitted = new Set<string>();

  for (const expected of expectedSnapshots) {
    if (emitted.has(expected.chunkId)) continue;
    const current = rowById.get(expected.chunkId);
    if (!current) continue;
    if (
      current.documentId !== expected.documentId ||
      current.jobId !== expected.jobId ||
      current.pipelineVersion !== expected.pipelineVersion ||
      current.sourceSha256 !== expected.sourceSha256 ||
      current.contentHash !== expected.contentHash
    ) {
      continue;
    }
    emitted.add(expected.chunkId);
    ordered.push(current);
  }

  return ordered;
}
