import { and, eq, gt, sql } from "drizzle-orm";
import type { AuthTransaction, CurrentAccount } from "../auth/authorization";
import { AuthFailure } from "../auth/errors";
import type { AuthDatabase } from "../auth/rate-limit";
import { getDatabase } from "../db/client";
import { authSessions, authUsers } from "../db/schema";
import {
  noEvidenceFallbackMessage,
  RetrievalError,
  type RetrievalMetadata,
} from "../retrieval/contracts";
import { loadOriginalActivePassagesByIds } from "../retrieval/search";
import {
  retrieveActiveSopEvidence,
  type RetrievalServiceOptions,
} from "../retrieval/service";
import { resolveVerifiedCitations } from "./citations";
import { answerConfiguration, type AnswerConfiguration } from "./config";
import {
  answerDefaults,
  answerRequestSchema,
  AnswerStageError,
  safeAnswerErrorMessages,
  validatedSopAnswerSchema,
  type AnswerFailureCode,
  type AnswerMetadata,
  type AnswerNoEvidenceReason,
  type AnswerStageTimings,
  type ChatServiceFailure,
  type GeneratorClaim,
  type NoEvidenceAnswer,
  type ValidatedClaim,
  type ValidatedSopAnswer,
} from "./contracts";
import { validateCandidateDeterministically } from "./deterministic";
import { generateAnswerCandidate } from "./generator";
import { judgeAnswerCandidate } from "./judge";
import {
  logEvent,
  recordProviderOutcome,
  recordStageTiming,
  type ProviderOutcome,
} from "../observability";

type Environment = Readonly<Record<string, string | undefined>>;

export type AnswerServiceOptions = {
  database?: AuthDatabase;
  env?: Environment;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  retrievalOptions?: Omit<RetrievalServiceOptions, "database" | "env" | "fetchImpl" | "signal">;
  retrieveEvidenceImpl?: typeof retrieveActiveSopEvidence;
  generateCandidateImpl?: typeof generateAnswerCandidate;
  judgeCandidateImpl?: typeof judgeAnswerCandidate;
  loadOriginalPassagesImpl?: typeof loadOriginalActivePassagesByIds;
  resolveCitationPassagesImpl?: typeof loadOriginalActivePassagesByIds;
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

async function verifyActiveAccount(
  account: CurrentAccount,
  database: AuthDatabase,
): Promise<CurrentAccount> {
  return database.transaction((transaction) => lockCurrentUser(account, transaction));
}

function formatValidatedAnswerText(isProcedural: boolean, claims: ValidatedClaim[]): string {
  if (isProcedural) {
    return claims.map((claim, index) => `${claim.stepNumber ?? index + 1}. ${claim.text}`).join("\n");
  }
  return claims.map((claim) => claim.text).join("\n");
}

function toValidatedClaims(isProcedural: boolean, claims: GeneratorClaim[]): ValidatedClaim[] {
  return claims.map((claim, index) => ({
    text: claim.text,
    ...(isProcedural ? { stepNumber: claim.stepNumber ?? index + 1 } : {}),
    chunkIds: [...claim.chunkIds],
  }));
}

function classifyAnswerProviderOutcome(
  code: AnswerFailureCode,
  retryable: boolean,
): ProviderOutcome {
  if (retryable) return "transient_error";
  if (code.includes("INVALID_OUTPUT")) return "invalid_output";
  return "rejected";
}

function buildServiceFailure(params: {
  code: AnswerFailureCode;
  retryable: boolean;
  metadata: AnswerMetadata;
}): ChatServiceFailure {
  recordStageTiming("answer", "total", params.metadata.timings.totalMs);
  logEvent("warn", "answer.failed", {
    errorCode: params.code,
    retryable: params.retryable,
    deterministicCheckPassed: params.metadata.deterministicCheckPassed,
    judgeVerdict: params.metadata.judgeVerdict,
    durationMs: params.metadata.timings.totalMs,
  });
  return validatedSopAnswerSchema.parse({
    kind: "service_error",
    code: params.code,
    message: safeAnswerErrorMessages[params.code],
    retryable: params.retryable,
    metadata: params.metadata,
  }) as ChatServiceFailure;
}

function buildNoEvidence(params: {
  reason: AnswerNoEvidenceReason;
  metadata: AnswerMetadata;
}): NoEvidenceAnswer {
  recordStageTiming("answer", "total", params.metadata.timings.totalMs);
  logEvent("info", "answer.completed", {
    outcome: "no_evidence",
    reason: params.reason,
    durationMs: params.metadata.timings.totalMs,
  });
  return validatedSopAnswerSchema.parse({
    kind: "no_evidence",
    answer: noEvidenceFallbackMessage,
    sources: [],
    reason: params.reason,
    metadata: params.metadata,
  }) as NoEvidenceAnswer;
}

export async function generateValidatedSopAnswer(
  rawInput: unknown,
  options: AnswerServiceOptions = {},
): Promise<ValidatedSopAnswer> {
  const totalStart = performance.now();
  const timings: AnswerStageTimings = {
    retrievalMs: 0,
    generateMs: 0,
    deterministicCheckMs: 0,
    judgeMs: 0,
    citationResolveMs: 0,
    totalMs: 0,
  };

  const fallbackMeta = (overrides?: Partial<AnswerMetadata>): AnswerMetadata => ({
    mode: overrides?.mode ?? "openai",
    answerModel: overrides?.answerModel ?? "unconfigured",
    judgeModel: overrides?.judgeModel ?? "unconfigured",
    retrieval: overrides?.retrieval ?? null,
    deterministicCheckPassed: overrides?.deterministicCheckPassed ?? null,
    judgeVerdict: overrides?.judgeVerdict ?? null,
    timings: {
      ...timings,
      totalMs: elapsedMs(totalStart),
    },
  });

  const parsedInput = answerRequestSchema.safeParse(rawInput);
  if (!parsedInput.success) {
    return buildServiceFailure({
      code: "ANSWER_INVALID_INPUT",
      retryable: false,
      metadata: fallbackMeta(),
    });
  }

  const env = options.env ?? process.env;
  let configuration: AnswerConfiguration;
  try {
    configuration = answerConfiguration(env);
  } catch (error) {
    const code: AnswerFailureCode =
      error instanceof AnswerStageError ? error.code : "ANSWER_CONFIG_MISSING";
    return buildServiceFailure({
      code,
      retryable: false,
      metadata: fallbackMeta(),
    });
  }

  let retrievalMetadata: RetrievalMetadata | null = null;
  let deterministicCheckPassed: boolean | null = null;
  let judgeVerdict: "PASS" | "FAIL" | "UNCERTAIN" | null = null;

  const currentMetadata = (): AnswerMetadata => ({
    mode: configuration.mode,
    answerModel: configuration.answerModel,
    judgeModel: configuration.judgeModel,
    retrieval: retrievalMetadata,
    deterministicCheckPassed,
    judgeVerdict,
    timings: {
      ...timings,
      totalMs: elapsedMs(totalStart),
    },
  });

  const retrieveEvidence = options.retrieveEvidenceImpl ?? retrieveActiveSopEvidence;
  const retrievalStart = performance.now();
  let retrievalResult;
  try {
    retrievalResult = await retrieveEvidence(parsedInput.data, {
      database: options.database,
      env,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      loadOriginalPassagesImpl: options.loadOriginalPassagesImpl,
      ...options.retrievalOptions,
    });
  } catch (error) {
    timings.retrievalMs = elapsedMs(retrievalStart);
    recordStageTiming("answer", "retrieval", timings.retrievalMs);
    const retryable = error instanceof RetrievalError ? error.transient : true;
    return buildServiceFailure({
      code: "RETRIEVAL_FAILED",
      retryable,
      metadata: currentMetadata(),
    });
  }
  timings.retrievalMs = elapsedMs(retrievalStart);
  recordStageTiming("answer", "retrieval", timings.retrievalMs);
  retrievalMetadata = retrievalResult.metadata;

  if (retrievalResult.kind === "no_evidence") {
    const reason: AnswerNoEvidenceReason =
      retrievalResult.reason === "ELIGIBILITY_REVOKED"
        ? "SOURCE_ELIGIBILITY_REVOKED"
        : "RETRIEVAL_NO_EVIDENCE";
    return buildNoEvidence({
      reason,
      metadata: currentMetadata(),
    });
  }

  // Pass ONLY standalone question and verified original passages (never history or prior answers).
  const generateCandidate = options.generateCandidateImpl ?? generateAnswerCandidate;
  const generateStart = performance.now();
  let privateCandidate;
  try {
    privateCandidate = await generateCandidate(
      {
        question: retrievalResult.standaloneQuery,
        passages: retrievalResult.passages,
      },
      configuration,
      {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      },
    );
  } catch (error) {
    timings.generateMs = elapsedMs(generateStart);
    recordStageTiming("answer", "generate", timings.generateMs);
    const code: AnswerFailureCode =
      error instanceof AnswerStageError ? error.code : "ANSWER_PROVIDER_TRANSIENT";
    const retryable = error instanceof AnswerStageError ? error.retryable : true;
    recordProviderOutcome("openai_answer", classifyAnswerProviderOutcome(code, retryable));
    return buildServiceFailure({
      code,
      retryable,
      metadata: currentMetadata(),
    });
  }
  timings.generateMs = elapsedMs(generateStart);
  recordStageTiming("answer", "generate", timings.generateMs);
  recordProviderOutcome("openai_answer", "ok");

  if (privateCandidate.status === "no_evidence") {
    return buildNoEvidence({
      reason: "GENERATOR_NO_EVIDENCE",
      metadata: currentMetadata(),
    });
  }

  const deterministicStart = performance.now();
  const deterministicResult = validateCandidateDeterministically(
    privateCandidate,
    retrievalResult.passages,
  );
  timings.deterministicCheckMs = elapsedMs(deterministicStart);
  recordStageTiming("answer", "deterministic_check", timings.deterministicCheckMs);
  deterministicCheckPassed = deterministicResult.ok;

  if (!deterministicResult.ok) {
    return buildServiceFailure({
      code: "ANSWER_VALIDATION_FAILED",
      retryable: false,
      metadata: currentMetadata(),
    });
  }

  const citedChunkIdSet = new Set(privateCandidate.claims.flatMap((claim) => claim.chunkIds));
  const citedPassages = retrievalResult.passages.filter((passage) =>
    citedChunkIdSet.has(passage.chunkId),
  );

  const judgeCandidate = options.judgeCandidateImpl ?? judgeAnswerCandidate;
  const judgeStart = performance.now();
  let judgeDecision;
  try {
    judgeDecision = await judgeCandidate(
      {
        question: retrievalResult.standaloneQuery,
        claims: privateCandidate.claims,
        citedPassages,
      },
      configuration,
      {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      },
    );
  } catch (error) {
    timings.judgeMs = elapsedMs(judgeStart);
    recordStageTiming("answer", "judge", timings.judgeMs);
    const code: AnswerFailureCode =
      error instanceof AnswerStageError ? error.code : "JUDGE_PROVIDER_TRANSIENT";
    const retryable = error instanceof AnswerStageError ? error.retryable : true;
    recordProviderOutcome("openai_judge", classifyAnswerProviderOutcome(code, retryable));
    return buildServiceFailure({
      code,
      retryable,
      metadata: currentMetadata(),
    });
  }
  timings.judgeMs = elapsedMs(judgeStart);
  recordStageTiming("answer", "judge", timings.judgeMs);
  recordProviderOutcome("openai_judge", "ok");
  judgeVerdict = judgeDecision.overallVerdict;

  if (!judgeDecision.passed) {
    return buildServiceFailure({
      code: "ANSWER_JUDGE_REJECTED",
      retryable: false,
      metadata: currentMetadata(),
    });
  }

  const citationLoader =
    options.resolveCitationPassagesImpl ??
    options.loadOriginalPassagesImpl ??
    options.retrievalOptions?.loadOriginalPassagesImpl ??
    loadOriginalActivePassagesByIds;

  const citationStart = performance.now();
  let citationResolution;
  try {
    citationResolution = await resolveVerifiedCitations(
      privateCandidate.claims,
      retrievalResult.passages,
      {
        database: options.database,
        loadOriginalPassagesImpl: citationLoader,
      },
    );
  } catch {
    timings.citationResolveMs = elapsedMs(citationStart);
    recordStageTiming("answer", "citation_resolve", timings.citationResolveMs);
    return buildServiceFailure({
      code: "RETRIEVAL_FAILED",
      retryable: true,
      metadata: currentMetadata(),
    });
  }
  timings.citationResolveMs = elapsedMs(citationStart);
  recordStageTiming("answer", "citation_resolve", timings.citationResolveMs);

  if (!citationResolution.ok) {
    return buildNoEvidence({
      reason: citationResolution.reason,
      metadata: currentMetadata(),
    });
  }

  const validatedClaims = toValidatedClaims(privateCandidate.isProcedural, privateCandidate.claims);
  const formattedAnswer = formatValidatedAnswerText(privateCandidate.isProcedural, validatedClaims);
  if (formattedAnswer.length === 0 || formattedAnswer.length > answerDefaults.maxAnswerChars) {
    return buildServiceFailure({
      code: "ANSWER_VALIDATION_FAILED",
      retryable: false,
      metadata: currentMetadata(),
    });
  }

  const metadata = currentMetadata();
  recordStageTiming("answer", "total", metadata.timings.totalMs);
  logEvent("info", "answer.completed", {
    outcome: "supported",
    isProcedural: privateCandidate.isProcedural,
    sourceCount: citationResolution.sources.length,
    judgeVerdict,
    durationMs: metadata.timings.totalMs,
  });

  return validatedSopAnswerSchema.parse({
    kind: "supported",
    answer: formattedAnswer,
    isProcedural: privateCandidate.isProcedural,
    claims: validatedClaims,
    sources: citationResolution.sources,
    metadata,
  });
}

export async function generateValidatedSopAnswerForAccount(
  account: CurrentAccount,
  rawInput: unknown,
  options: AnswerServiceOptions = {},
): Promise<ValidatedSopAnswer> {
  const database = options.database ?? getDatabase();
  await verifyActiveAccount(account, database);
  const result = await generateValidatedSopAnswer(rawInput, { ...options, database });
  // Recheck live account/session right before releasing any validated answer or source citations.
  await verifyActiveAccount(account, database);
  return result;
}
