import { z } from "zod";
import {
  conversationTurnSchema,
  noEvidenceFallbackMessage,
  retrievalDefaults,
  retrievalParametersSchema,
  type RetrievalMetadata,
} from "../retrieval/contracts";

export { noEvidenceFallbackMessage };

export const answerDefaults = {
  maxClaims: 20,
  maxClaimChars: 1_200,
  maxAnswerChars: 12_000,
  generatorTimeoutMilliseconds: 25_000,
  judgeTimeoutMilliseconds: 20_000,
} as const;

export const answerFailureCodes = [
  "ANSWER_INVALID_INPUT",
  "ANSWER_CONFIG_MISSING",
  "RETRIEVAL_FAILED",
  "ANSWER_PROVIDER_TRANSIENT",
  "ANSWER_PROVIDER_REJECTED",
  "ANSWER_GENERATOR_INVALID_OUTPUT",
  "ANSWER_VALIDATION_FAILED",
  "JUDGE_PROVIDER_TRANSIENT",
  "JUDGE_PROVIDER_REJECTED",
  "JUDGE_INVALID_OUTPUT",
  "ANSWER_JUDGE_REJECTED",
] as const;

export type AnswerFailureCode = (typeof answerFailureCodes)[number];

export const safeAnswerErrorMessages: Readonly<Record<AnswerFailureCode, string>> = {
  ANSWER_INVALID_INPUT: "The question could not be processed. Check your input and try again.",
  ANSWER_CONFIG_MISSING: "The SOP answer service is not currently configured. Contact an administrator.",
  RETRIEVAL_FAILED: "Unable to search verified SOP documents right now. Please try again shortly.",
  ANSWER_PROVIDER_TRANSIENT: "The SOP answer service is temporarily unavailable. Please try again shortly.",
  ANSWER_PROVIDER_REJECTED: "The SOP answer service could not complete this request.",
  ANSWER_GENERATOR_INVALID_OUTPUT: "The SOP answer could not be verified and was withheld.",
  ANSWER_VALIDATION_FAILED: "The generated SOP answer failed evidence verification and was withheld.",
  JUDGE_PROVIDER_TRANSIENT: "Evidence verification is temporarily unavailable. Please try again shortly.",
  JUDGE_PROVIDER_REJECTED: "Evidence verification could not complete this request.",
  JUDGE_INVALID_OUTPUT: "Evidence verification returned an invalid decision and the answer was withheld.",
  ANSWER_JUDGE_REJECTED: "The generated SOP answer did not pass independent evidence verification and was withheld.",
};

export class AnswerStageError extends Error {
  constructor(
    public readonly code: AnswerFailureCode,
    public readonly retryable: boolean,
    public readonly status: number = retryable ? 503 : 502,
  ) {
    super(code);
    this.name = "AnswerStageError";
  }
}

export const answerRequestSchema = z
  .object({
    question: z.string().trim().min(1).max(retrievalDefaults.maxQuestionChars),
    history: z.array(conversationTurnSchema).max(50).optional().default([]),
    parameters: retrievalParametersSchema.partial().optional(),
  })
  .strict();

export type AnswerRequestInput = z.input<typeof answerRequestSchema>;

export const generatorClaimSchema = z
  .object({
    text: z.string().trim().min(1).max(answerDefaults.maxClaimChars),
    stepNumber: z.number().int().min(1).max(answerDefaults.maxClaims).nullable().optional(),
    chunkIds: z.array(z.string().trim().min(1)).min(1).max(10),
  })
  .strict();

export type GeneratorClaim = z.infer<typeof generatorClaimSchema>;

export const generatorCandidateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("no_evidence"),
    })
    .strict(),
  z
    .object({
      status: z.literal("supported"),
      isProcedural: z.boolean(),
      claims: z.array(generatorClaimSchema).min(1).max(answerDefaults.maxClaims),
    })
    .strict(),
]);

export type GeneratorCandidate = z.infer<typeof generatorCandidateSchema>;
export type SupportedGeneratorCandidate = Extract<GeneratorCandidate, { status: "supported" }>;

export const judgeClaimVerdictSchema = z
  .object({
    claimIndex: z.number().int().min(0),
    verdict: z.enum(["SUPPORTED", "UNSUPPORTED", "UNCERTAIN"]),
    reasonCode: z.string().trim().min(1).max(400),
  })
  .strict();

export type JudgeClaimVerdict = z.infer<typeof judgeClaimVerdictSchema>;

export const judgeOutputSchema = z
  .object({
    overallVerdict: z.enum(["PASS", "FAIL", "UNCERTAIN"]),
    claimVerdicts: z.array(judgeClaimVerdictSchema),
  })
  .strict();

export type JudgeOutput = z.infer<typeof judgeOutputSchema>;

export const answerStageTimingsSchema = z
  .object({
    retrievalMs: z.number().finite().min(0),
    generateMs: z.number().finite().min(0),
    deterministicCheckMs: z.number().finite().min(0),
    judgeMs: z.number().finite().min(0),
    citationResolveMs: z.number().finite().min(0),
    totalMs: z.number().finite().min(0),
  })
  .strict();

export type AnswerStageTimings = z.infer<typeof answerStageTimingsSchema>;

export const validatedClaimSchema = z
  .object({
    text: z.string().trim().min(1).max(answerDefaults.maxClaimChars),
    stepNumber: z.number().int().min(1).max(answerDefaults.maxClaims).optional(),
    chunkIds: z.array(z.string().trim().min(1)).min(1).max(10),
  })
  .strict();

export type ValidatedClaim = z.infer<typeof validatedClaimSchema>;

const backendSourcePathPattern = /^\/api\/documents\/[^/?#\s]+\/source(?:\?[^\s#]*)?$/;

export const supportedAnswerSourceSchema = z
  .object({
    documentId: z.string().min(1),
    chunkId: z.string().min(1),
    sopTitle: z.string().min(1),
    section: z.string().min(1),
    pageStart: z.number().int().min(1).optional(),
    pageEnd: z.number().int().min(1).optional(),
    sourcePath: z.string().regex(backendSourcePathPattern),
  })
  .strict();

export type SupportedAnswerSource = z.infer<typeof supportedAnswerSourceSchema>;

export type AnswerMetadata = {
  mode: "openai" | "synthetic_fixture";
  answerModel: string;
  judgeModel: string;
  retrieval: RetrievalMetadata | null;
  deterministicCheckPassed: boolean | null;
  judgeVerdict: "PASS" | "FAIL" | "UNCERTAIN" | null;
  timings: AnswerStageTimings;
};

const answerMetadataSchema: z.ZodType<AnswerMetadata> = z
  .object({
    mode: z.enum(["openai", "synthetic_fixture"]),
    answerModel: z.string().min(1),
    judgeModel: z.string().min(1),
    retrieval: z.custom<RetrievalMetadata | null>(
      (value) => value === null || (typeof value === "object" && value !== null),
    ),
    deterministicCheckPassed: z.boolean().nullable(),
    judgeVerdict: z.enum(["PASS", "FAIL", "UNCERTAIN"]).nullable(),
    timings: answerStageTimingsSchema,
  })
  .strict();

export const answerNoEvidenceReasonSchema = z.enum([
  "RETRIEVAL_NO_EVIDENCE",
  "GENERATOR_NO_EVIDENCE",
  "SOURCE_ELIGIBILITY_REVOKED",
]);

export type AnswerNoEvidenceReason = z.infer<typeof answerNoEvidenceReasonSchema>;

export const supportedAnswerSchema = z
  .object({
    kind: z.literal("supported"),
    answer: z.string().trim().min(1).max(answerDefaults.maxAnswerChars),
    isProcedural: z.boolean(),
    claims: z.array(validatedClaimSchema).min(1).max(answerDefaults.maxClaims),
    sources: z.array(supportedAnswerSourceSchema).min(1),
    metadata: answerMetadataSchema,
  })
  .strict();

export type SupportedAnswer = z.infer<typeof supportedAnswerSchema>;

export const noEvidenceAnswerSchema = z
  .object({
    kind: z.literal("no_evidence"),
    answer: z.literal(noEvidenceFallbackMessage),
    sources: z.tuple([]),
    reason: answerNoEvidenceReasonSchema,
    metadata: answerMetadataSchema,
  })
  .strict();

export type NoEvidenceAnswer = z.infer<typeof noEvidenceAnswerSchema>;

export const chatServiceFailureSchema = z
  .object({
    kind: z.literal("service_error"),
    code: z.enum(answerFailureCodes),
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
    metadata: answerMetadataSchema,
  })
  .strict();

export type ChatServiceFailure = z.infer<typeof chatServiceFailureSchema>;

export const validatedSopAnswerSchema = z.discriminatedUnion("kind", [
  supportedAnswerSchema,
  noEvidenceAnswerSchema,
  chatServiceFailureSchema,
]);

export type ValidatedSopAnswer = z.infer<typeof validatedSopAnswerSchema>;
