import { and, eq, gt, sql } from "drizzle-orm";
import { AuthFailure } from "../auth/errors";
import type { AuthTransaction, CurrentAccount } from "../auth/authorization";
import type { AuthDatabase } from "../auth/rate-limit";
import { getDatabase } from "../db/client";
import { authSessions, authUsers } from "../db/schema";
import { approvedEmbeddingDimensions } from "../ingestion/config";
import { IngestionStageError } from "../ingestion/contracts";
import { embedTexts, validateEmbeddingVector } from "../ingestion/embeddings";
import { resolveRetrievalParameters, retrievalConfiguration } from "./config";
import {
  noEvidenceFallbackMessage,
  RetrievalError,
  retrievalRequestSchema,
  type ActiveChunkCandidate,
  type KeywordCandidate,
  type NoEvidenceReason,
  type RerankedPassage,
  type RetrievalMetadata,
  type RetrievalResult,
  type RetrievalStageTimings,
  type SemanticCandidate,
  type SnapshotIdentity,
} from "./contracts";
import { rerankCandidates } from "./rerank";
import { rewriteRetrievalQuery } from "./rewrite";
import { fuseHybridCandidates } from "./rrf";
import {
  loadOriginalActivePassagesByIds,
  searchKeywordActiveChunks,
  searchSemanticActiveChunks,
} from "./search";

type Environment = Readonly<Record<string, string | undefined>>;

export type RetrievalServiceOptions = {
  database?: AuthDatabase;
  env?: Environment;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  embedTextsImpl?: (
    texts: string[],
    options?: { env?: Environment; fetchImpl?: typeof fetch; signal?: AbortSignal },
  ) => Promise<{ model: string; dimensions: number; vectors: number[][] }>;
  searchSemanticImpl?: typeof searchSemanticActiveChunks;
  searchKeywordImpl?: typeof searchKeywordActiveChunks;
  loadOriginalPassagesImpl?: typeof loadOriginalActivePassagesByIds;
};

function elapsedMs(start: number): number {
  return Number(Math.max(0, performance.now() - start).toFixed(2));
}

async function lockCurrentUser(
  account: CurrentAccount,
  transaction: AuthTransaction,
): Promise<CurrentAccount> {
  const [user] = await transaction
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      role: authUsers.role,
      active: authUsers.active,
    })
    .from(authUsers)
    .where(eq(authUsers.id, account.id))
    .for("share");
  if (!user?.active) throw new AuthFailure("UNAUTHENTICATED", 401);

  const [session] = await transaction
    .select({ id: authSessions.id, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.id, account.sessionId),
        eq(authSessions.userId, account.id),
        gt(authSessions.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .for("share");
  if (!session) throw new AuthFailure("UNAUTHENTICATED", 401);

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sessionId: session.id,
    sessionExpiresAt: session.expiresAt,
  };
}

async function verifyActiveAccount(account: CurrentAccount, database: AuthDatabase): Promise<CurrentAccount> {
  return database.transaction((transaction) => lockCurrentUser(account, transaction));
}

function mapEmbeddingError(error: unknown): RetrievalError {
  if (error instanceof RetrievalError) return error;
  if (error instanceof IngestionStageError) {
    if (error.code === "EMBEDDING_PROVIDER_TRANSIENT") {
      return new RetrievalError("RETRIEVAL_PROVIDER_TRANSIENT", true, 503);
    }
    if (error.code === "EMBEDDING_PROVIDER_REJECTED") {
      return new RetrievalError("RETRIEVAL_PROVIDER_REJECTED", false, 502);
    }
    return new RetrievalError("RETRIEVAL_EMBEDDING_FAILED", false, 502);
  }
  return new RetrievalError("RETRIEVAL_CONFIG_MISSING", false, 503);
}

function matchesSnapshot(candidate: ActiveChunkCandidate, expected: SnapshotIdentity): boolean {
  return (
    candidate.chunkId === expected.chunkId &&
    candidate.documentId === expected.documentId &&
    candidate.jobId === expected.jobId &&
    candidate.pipelineVersion === expected.pipelineVersion &&
    candidate.sourceSha256 === expected.sourceSha256 &&
    candidate.contentHash === expected.contentHash
  );
}

function buildNoEvidenceResult(params: {
  reason: NoEvidenceReason;
  originalQuestion: string;
  standaloneQuery: string;
  metadata: RetrievalMetadata;
}): RetrievalResult {
  return {
    kind: "no_evidence",
    reason: params.reason,
    fallbackMessage: noEvidenceFallbackMessage,
    originalQuestion: params.originalQuestion,
    standaloneQuery: params.standaloneQuery,
    passages: [],
    metadata: params.metadata,
  };
}

export async function retrieveActiveSopEvidence(
  rawInput: unknown,
  options: RetrievalServiceOptions = {},
): Promise<RetrievalResult> {
  const totalStart = performance.now();
  const parsed = retrievalRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new RetrievalError("RETRIEVAL_INVALID_INPUT", false, 400);
  }

  const env = options.env ?? process.env;
  const parameters = resolveRetrievalParameters(parsed.data.parameters, env);
  const needsHistoryRewrite = parsed.data.history.length > 0 && parameters.historyMaxTurns > 0;
  const configuration = retrievalConfiguration(env, { requireRewriteModel: needsHistoryRewrite });

  const timings: RetrievalStageTimings = {
    rewriteMs: 0,
    embedMs: 0,
    semanticMs: 0,
    keywordMs: 0,
    rrfMs: 0,
    rerankMs: 0,
    fetchOriginalMs: 0,
    totalMs: 0,
  };

  const rewriteStart = performance.now();
  const rewritten = await rewriteRetrievalQuery(
    parsed.data.question,
    parsed.data.history,
    configuration,
    {
      historyMaxTurns: parameters.historyMaxTurns,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    },
  );
  timings.rewriteMs = elapsedMs(rewriteStart);

  const embedImpl = options.embedTextsImpl ?? embedTexts;
  const embedStart = performance.now();
  let embedded: { model: string; dimensions: number; vectors: number[][] };
  try {
    embedded = await embedImpl([rewritten.standaloneQuery], {
      env,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    });
  } catch (error) {
    throw mapEmbeddingError(error);
  }
  timings.embedMs = elapsedMs(embedStart);

  const queryVector = embedded.vectors[0];
  if (
    embedded.dimensions !== approvedEmbeddingDimensions ||
    embedded.vectors.length !== 1 ||
    !queryVector ||
    !validateEmbeddingVector(queryVector, approvedEmbeddingDimensions)
  ) {
    throw new RetrievalError("RETRIEVAL_VECTOR_INVALID", false, 500);
  }

  const searchSemantic = options.searchSemanticImpl ?? searchSemanticActiveChunks;
  const searchKeyword = options.searchKeywordImpl ?? searchKeywordActiveChunks;

  const [semanticCandidates, keywordCandidates] = await Promise.all([
    (async (): Promise<SemanticCandidate[]> => {
      const start = performance.now();
      const rows = await searchSemantic(queryVector, {
        database: options.database,
        limit: parameters.semanticTopK,
      });
      timings.semanticMs = elapsedMs(start);
      return rows;
    })(),
    (async (): Promise<KeywordCandidate[]> => {
      const start = performance.now();
      const rows = await searchKeyword(rewritten.standaloneQuery, {
        database: options.database,
        limit: parameters.keywordTopK,
      });
      timings.keywordMs = elapsedMs(start);
      return rows;
    })(),
  ]);

  const rrfStart = performance.now();
  const fusedCandidates = fuseHybridCandidates(semanticCandidates, keywordCandidates, {
    rrfK: parameters.rrfK,
    maxCandidates: parameters.maxRerankCandidates,
  });
  timings.rrfMs = elapsedMs(rrfStart);

  const buildMetadata = (
    rerankedCandidateCount: number,
    returnedPassageCount: number,
  ): RetrievalMetadata => ({
    mode: configuration.mode,
    embeddingModel: embedded.model,
    embeddingDimensions: embedded.dimensions,
    rerankerModel: configuration.rerankerModel,
    rewriteModel: rewritten.rewriteModel,
    rewrittenFromHistory: rewritten.rewrittenFromHistory,
    historyTurnsUsed: rewritten.historyTurnsUsed,
    semanticCandidateCount: semanticCandidates.length,
    keywordCandidateCount: keywordCandidates.length,
    fusedCandidateCount: fusedCandidates.length,
    rerankedCandidateCount,
    returnedPassageCount,
    parameters,
    timings: {
      ...timings,
      totalMs: elapsedMs(totalStart),
    },
  });

  if (fusedCandidates.length === 0) {
    return buildNoEvidenceResult({
      reason: "NO_CANDIDATES",
      originalQuestion: parsed.data.question,
      standaloneQuery: rewritten.standaloneQuery,
      metadata: buildMetadata(0, 0),
    });
  }

  const rerankStart = performance.now();
  const reranked = await rerankCandidates(
    rewritten.standaloneQuery,
    fusedCandidates,
    configuration,
    {
      finalTopK: parameters.finalTopK,
      minRerankScore: parameters.minRerankScore,
      rrfK: parameters.rrfK,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    },
  );
  timings.rerankMs = elapsedMs(rerankStart);

  if (reranked.length === 0) {
    return buildNoEvidenceResult({
      reason: "WEAK_EVIDENCE",
      originalQuestion: parsed.data.question,
      standaloneQuery: rewritten.standaloneQuery,
      metadata: buildMetadata(0, 0),
    });
  }

  const fusedById = new Map(fusedCandidates.map((candidate) => [candidate.chunkId, candidate]));
  const scoreById = new Map(reranked.map((entry) => [entry.chunkId, entry.score]));
  const expectedSnapshots: SnapshotIdentity[] = reranked.map((entry) => {
    const candidate = fusedById.get(entry.chunkId);
    if (!candidate) {
      throw new RetrievalError("RETRIEVAL_RERANKER_INVALID_OUTPUT", false, 502);
    }
    return {
      chunkId: candidate.chunkId,
      documentId: candidate.documentId,
      jobId: candidate.jobId,
      pipelineVersion: candidate.pipelineVersion,
      sourceSha256: candidate.sourceSha256,
      contentHash: candidate.contentHash,
    };
  });

  const loadOriginal = options.loadOriginalPassagesImpl ?? loadOriginalActivePassagesByIds;
  const fetchStart = performance.now();
  const reloadedOriginal = await loadOriginal(expectedSnapshots, { database: options.database });
  timings.fetchOriginalMs = elapsedMs(fetchStart);

  const expectedById = new Map(expectedSnapshots.map((snapshot) => [snapshot.chunkId, snapshot]));
  const passages: RerankedPassage[] = [];
  for (const row of reloadedOriginal) {
    const expected = expectedById.get(row.chunkId);
    const fused = fusedById.get(row.chunkId);
    const rerankScore = scoreById.get(row.chunkId);
    if (!expected || !fused || rerankScore === undefined || !matchesSnapshot(row, expected)) {
      continue;
    }
    passages.push({
      ...row,
      rerankScore,
      rrfScore: fused.rrfScore,
      semanticRank: fused.semanticRank,
      keywordRank: fused.keywordRank,
    });
  }

  if (passages.length === 0) {
    return buildNoEvidenceResult({
      reason: "ELIGIBILITY_REVOKED",
      originalQuestion: parsed.data.question,
      standaloneQuery: rewritten.standaloneQuery,
      metadata: buildMetadata(reranked.length, 0),
    });
  }

  return {
    kind: "evidence",
    originalQuestion: parsed.data.question,
    standaloneQuery: rewritten.standaloneQuery,
    passages,
    metadata: buildMetadata(reranked.length, passages.length),
  };
}

export async function retrieveActiveSopEvidenceForAccount(
  account: CurrentAccount,
  rawInput: unknown,
  options: RetrievalServiceOptions = {},
): Promise<RetrievalResult> {
  const database = options.database ?? getDatabase();
  await verifyActiveAccount(account, database);
  const result = await retrieveActiveSopEvidence(rawInput, { ...options, database });
  await verifyActiveAccount(account, database);
  return result;
}
