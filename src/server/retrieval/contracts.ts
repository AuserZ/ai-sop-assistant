import { z } from "zod";
import { approvedEmbeddingDimensions } from "../ingestion/config";

export const noEvidenceFallbackMessage = "No SOP found for this question" as const;

export const retrievalDefaults = {
  semanticTopK: 15,
  keywordTopK: 15,
  finalTopK: 5,
  rrfK: 60,
  historyMaxTurns: 8,
  minRerankScore: 0.15,
  maxRerankCandidates: 30,
  maxQuestionChars: 2_000,
  maxHistoryTurnChars: 1_000,
  maxRewriteOutputChars: 500,
  maxKeywordTokens: 24,
  rerankTimeoutMilliseconds: 15_000,
  rewriteTimeoutMilliseconds: 10_000,
  embeddingDimensions: approvedEmbeddingDimensions,
} as const;

export type RetrievalErrorCode =
  | "RETRIEVAL_INVALID_INPUT"
  | "RETRIEVAL_CONFIG_MISSING"
  | "RETRIEVAL_PROVIDER_TRANSIENT"
  | "RETRIEVAL_PROVIDER_REJECTED"
  | "RETRIEVAL_EMBEDDING_FAILED"
  | "RETRIEVAL_RERANKER_INVALID_OUTPUT"
  | "RETRIEVAL_REWRITE_INVALID_OUTPUT"
  | "RETRIEVAL_IDENTITY_CONFLICT"
  | "RETRIEVAL_VECTOR_INVALID";

export class RetrievalError extends Error {
  constructor(
    public readonly code: RetrievalErrorCode,
    public readonly transient: boolean,
    public readonly status: number = transient ? 503 : 500,
  ) {
    super(code);
    this.name = "RetrievalError";
  }
}

export const retrievalParametersSchema = z
  .object({
    semanticTopK: z.number().int().min(1).max(20).default(retrievalDefaults.semanticTopK),
    keywordTopK: z.number().int().min(1).max(20).default(retrievalDefaults.keywordTopK),
    finalTopK: z.number().int().min(1).max(10).default(retrievalDefaults.finalTopK),
    rrfK: z.number().int().min(1).max(200).default(retrievalDefaults.rrfK),
    historyMaxTurns: z.number().int().min(0).max(10).default(retrievalDefaults.historyMaxTurns),
    minRerankScore: z.number().finite().min(0).max(1).default(retrievalDefaults.minRerankScore),
    maxRerankCandidates: z
      .number()
      .int()
      .min(1)
      .max(40)
      .default(retrievalDefaults.maxRerankCandidates),
  })
  .strict();

export type RetrievalParameters = z.infer<typeof retrievalParametersSchema>;

export const conversationTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(20_000),
  })
  .strict();

export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

export const retrievalRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(retrievalDefaults.maxQuestionChars),
    history: z.array(conversationTurnSchema).max(50).optional().default([]),
    parameters: retrievalParametersSchema.partial().optional(),
  })
  .strict();

export type RetrievalRequestInput = z.input<typeof retrievalRequestSchema>;

export const rerankerOutputSchema = z
  .object({
    ranked: z.array(
      z
        .object({
          chunkId: z.string().min(1),
          score: z.number().finite().min(0).max(1),
        })
        .strict(),
    ),
  })
  .strict();

export type RerankerOutput = z.infer<typeof rerankerOutputSchema>;

export const rewriteOutputSchema = z
  .object({
    standaloneQuery: z.string().trim().min(1).max(retrievalDefaults.maxRewriteOutputChars),
  })
  .strict();

export type RewriteOutput = z.infer<typeof rewriteOutputSchema>;

export type SnapshotIdentity = {
  chunkId: string;
  documentId: string;
  jobId: string;
  pipelineVersion: string;
  sourceSha256: string;
  contentHash: string;
};

export type ActiveChunkCandidate = SnapshotIdentity & {
  documentTitle: string;
  fileName: string;
  sequence: number;
  sectionPath: string;
  pageStart: number | null;
  pageEnd: number | null;
  contentType: "procedure" | "table" | "narrative" | "mixed";
  text: string;
  tokenEstimate: number;
};

export type SemanticCandidate = ActiveChunkCandidate & {
  semanticRank: number;
  cosineDistance: number;
  semanticScore: number;
};

export type KeywordCandidate = ActiveChunkCandidate & {
  keywordRank: number;
  keywordScore: number;
};

export type FusedCandidate = ActiveChunkCandidate & {
  rrfScore: number;
  semanticRank: number | null;
  keywordRank: number | null;
  bestBranchRank: number;
  cosineDistance: number | null;
  keywordScore: number | null;
};

export type RerankedCandidate = {
  chunkId: string;
  score: number;
};

export type RerankedPassage = ActiveChunkCandidate & {
  rerankScore: number;
  rrfScore: number;
  semanticRank: number | null;
  keywordRank: number | null;
};

export type RetrievalStageTimings = {
  rewriteMs: number;
  embedMs: number;
  semanticMs: number;
  keywordMs: number;
  rrfMs: number;
  rerankMs: number;
  fetchOriginalMs: number;
  totalMs: number;
};

export type NoEvidenceReason = "NO_CANDIDATES" | "WEAK_EVIDENCE" | "ELIGIBILITY_REVOKED";

export type RetrievalMetadata = {
  mode: "openai" | "synthetic_fixture";
  embeddingModel: string;
  embeddingDimensions: number;
  rerankerModel: string;
  rewriteModel: string | null;
  rewrittenFromHistory: boolean;
  historyTurnsUsed: number;
  semanticCandidateCount: number;
  keywordCandidateCount: number;
  fusedCandidateCount: number;
  rerankedCandidateCount: number;
  returnedPassageCount: number;
  parameters: RetrievalParameters;
  timings: RetrievalStageTimings;
};

export type RetrievalResult =
  | {
      kind: "evidence";
      originalQuestion: string;
      standaloneQuery: string;
      passages: RerankedPassage[];
      metadata: RetrievalMetadata;
    }
  | {
      kind: "no_evidence";
      reason: NoEvidenceReason;
      fallbackMessage: typeof noEvidenceFallbackMessage;
      originalQuestion: string;
      standaloneQuery: string;
      passages: [];
      metadata: RetrievalMetadata;
    };
