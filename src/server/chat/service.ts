import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { answerConfiguration } from "../answers/config";
import { buildBackendSourcePath, resolveVerifiedCitations } from "../answers/citations";
import {
  answerDefaults,
  AnswerStageError,
  type AnswerFailureCode,
  type GeneratorClaim,
} from "../answers/contracts";
import { validateCandidateDeterministically } from "../answers/deterministic";
import { generateAnswerCandidate } from "../answers/generator";
import { judgeAnswerCandidate } from "../answers/judge";
import type { CurrentAccount } from "../auth/authorization";
import { AuthFailure } from "../auth/errors";
import type { AuthDatabase } from "../auth/rate-limit";
import { getDatabase } from "../db/client";
import {
  auditEvents,
  chatConversations,
  chatMessages,
  chatMessageSources,
  chatTurnArtifacts,
  sopDocuments,
  workflowEvents,
  workflowJobs,
  workflowNonceReceipts,
  type ChatTurnCandidateArtifact,
  type ChatTurnRetrievalArtifact,
  type ChatTurnTimings,
} from "../db/schema";
import { chatBounds, type ChatCallbackClaims } from "../jobs/contracts";
import {
  appendEvent,
  lockActiveOwner,
  lockCurrentAccount,
  type JobDatabase,
  type JobTransaction,
  type WorkflowEvent,
  type WorkflowJob,
} from "../jobs/service";
import {
  RetrievalError,
  type ConversationTurn,
  type RerankedPassage,
} from "../retrieval/contracts";
import type { loadOriginalActivePassagesByIds } from "../retrieval/search";
import {
  retrieveActiveSopEvidence,
  type RetrievalServiceOptions,
} from "../retrieval/service";
import {
  chatApiBounds,
  chatIdInput,
  noEvidenceFallbackMessage,
  sendChatMessageInput,
  type ChatConversationDetailDto,
  type ChatConversationSummaryDto,
  type ChatHistoricalSourceDto,
  type ChatMessageDto,
  type ChatSafeErrorCode,
  type ChatStageCallbackResponse,
  type ChatTurnCreationResult,
} from "./contracts";
import {
  logEvent,
  recordProviderOutcome,
  recordStageTiming,
  type ProviderOutcome,
} from "../observability";

function classifyChatProviderOutcome(
  code: AnswerFailureCode,
  retryable: boolean,
): ProviderOutcome {
  if (retryable) return "transient_error";
  if (code.includes("INVALID_OUTPUT")) return "invalid_output";
  return "rejected";
}

type Environment = Readonly<Record<string, string | undefined>>;

export type ChatStageOptions = {
  database?: JobDatabase;
  env?: Environment;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  retrievalOptions?: Omit<RetrievalServiceOptions, "database" | "env" | "fetchImpl" | "signal">;
  retrieveEvidenceImpl?: typeof retrieveActiveSopEvidence;
  generateCandidateImpl?: typeof generateAnswerCandidate;
  judgeCandidateImpl?: typeof judgeAnswerCandidate;
  resolveCitationPassagesImpl?: typeof loadOriginalActivePassagesByIds;
};

function elapsedMs(start: number): number {
  return Number(Math.max(0, performance.now() - start).toFixed(2));
}

function deriveConversationTitle(question: string): string {
  const singleLine = question.replace(/\s+/g, " ").trim();
  const limit = chatApiBounds.maximumConversationTitleChars;
  if (singleLine.length <= limit) return singleLine;
  return `${singleLine.slice(0, limit - 1).trimEnd()}…`;
}

function formatValidatedAnswerText(isProcedural: boolean, claims: GeneratorClaim[]): string {
  if (isProcedural) {
    return claims
      .map((claim, index) => `${claim.stepNumber ?? index + 1}. ${claim.text}`)
      .join("\n");
  }
  return claims.map((claim) => claim.text).join("\n");
}

async function appendChatEventOnce(
  transaction: JobTransaction,
  job: WorkflowJob,
  kind: WorkflowEvent["kind"],
  step: number,
) {
  const [existing] = await transaction
    .select({ id: workflowEvents.id })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.jobId, job.id),
        eq(workflowEvents.attemptId, job.attemptId),
        eq(workflowEvents.step, step),
      ),
    );
  if (existing) return;
  await appendEvent(transaction, job, kind, step);
}

async function commitAssistantMessage(
  transaction: JobTransaction,
  params: {
    job: WorkflowJob;
    content: string;
    validationStatus: "PASSED" | "NO_EVIDENCE";
    isProcedural: boolean;
    timings: ChatTurnTimings;
  },
) {
  const [inserted] = await transaction
    .insert(chatMessages)
    .values({
      conversationId: params.job.conversationId!,
      ownerId: params.job.ownerId,
      role: "assistant",
      content: params.content,
      requestKey: params.job.requestKey,
      jobId: params.job.id,
      validationStatus: params.validationStatus,
      isProcedural: params.isProcedural,
      timings: params.timings,
    })
    .onConflictDoNothing({
      target: [chatMessages.ownerId, chatMessages.requestKey, chatMessages.role],
    })
    .returning();

  if (inserted) return inserted;

  const [existing] = await transaction
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.ownerId, params.job.ownerId),
        eq(chatMessages.requestKey, params.job.requestKey),
        eq(chatMessages.role, "assistant"),
      ),
    );
  if (!existing) throw new Error("Expected persisted assistant message after conflict.");
  return existing;
}

async function commitChatJobFailure(
  transaction: JobTransaction,
  job: WorkflowJob,
  errorCode: ChatSafeErrorCode,
  retryable: boolean,
): Promise<ChatStageCallbackResponse> {
  await transaction.delete(chatTurnArtifacts).where(eq(chatTurnArtifacts.jobId, job.id));
  if (job.state === "COMPLETED" || job.state === "FAILED") {
    return { ok: true, terminal: true };
  }
  await transaction
    .update(workflowJobs)
    .set({
      state: "FAILED",
      stage: "failed",
      step: 6,
      errorCode,
      errorRetryable: retryable,
      runLeaseUntil: null,
      dispatchLeaseToken: null,
      dispatchLeaseUntil: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workflowJobs.id, job.id));
  await appendChatEventOnce(transaction, job, "failed", 6);
  logEvent("warn", "chat.turn_failed", {
    jobId: job.id,
    conversationId: job.conversationId,
    errorCode,
    retryable,
  });
  return { ok: true, terminal: true };
}

async function commitNoEvidenceTurn(
  transaction: JobTransaction,
  job: WorkflowJob,
  timings: ChatTurnTimings,
): Promise<ChatStageCallbackResponse> {
  const message = await commitAssistantMessage(transaction, {
    job,
    content: noEvidenceFallbackMessage,
    validationStatus: "NO_EVIDENCE",
    isProcedural: false,
    timings,
  });
  await transaction.delete(chatTurnArtifacts).where(eq(chatTurnArtifacts.jobId, job.id));
  await transaction
    .update(workflowJobs)
    .set({
      state: "COMPLETED",
      stage: "no_evidence",
      step: 6,
      assistantMessageId: message.id,
      errorCode: null,
      errorRetryable: null,
      runLeaseUntil: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workflowJobs.id, job.id));
  await transaction
    .update(chatConversations)
    .set({ updatedAt: sql`clock_timestamp()` })
    .where(eq(chatConversations.id, job.conversationId!));
  await appendChatEventOnce(transaction, job, "no_evidence", 6);
  recordStageTiming("chat", "total", timings.totalMs);
  logEvent("info", "chat.turn_completed", {
    jobId: job.id,
    conversationId: job.conversationId,
    outcome: "no_evidence",
    durationMs: timings.totalMs,
  });
  return { ok: true, terminal: true };
}

async function verifyAndConsumeChatCallback(
  transaction: JobTransaction,
  claims: ChatCallbackClaims,
): Promise<{ job: WorkflowJob; ownerRevoked: boolean }> {
  const [job] = await transaction
    .select()
    .from(workflowJobs)
    .where(eq(workflowJobs.id, claims.jobId))
    .for("update");

  if (
    !job ||
    job.kind !== "chat_turn" ||
    job.conversationId !== claims.conversationId ||
    job.requestKey !== claims.requestKey ||
    job.attemptId !== claims.attemptId ||
    job.attemptNumber !== claims.attemptNumber ||
    job.dispatchNonce !== claims.dispatchNonce ||
    job.dispatchCount === 0
  ) {
    throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
  }

  const [fresh] = await transaction
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(and(eq(workflowJobs.id, job.id), gt(workflowJobs.attemptDeadline, sql`clock_timestamp()`)));
  if (!fresh) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);

  const [receipt] = await transaction
    .insert(workflowNonceReceipts)
    .values({
      id: claims.jti,
      jobId: job.id,
      attemptId: job.attemptId,
      expiresAt: new Date((claims.exp + chatBounds.clockToleranceSeconds) * 1000),
    })
    .onConflictDoNothing()
    .returning({ id: workflowNonceReceipts.id });
  if (!receipt) throw new AuthFailure("WORKFLOW_REPLAY", 409);

  try {
    await lockActiveOwner(transaction, job.ownerId);
    return { job, ownerRevoked: false };
  } catch (error) {
    if (error instanceof AuthFailure && error.code === "UNAUTHENTICATED") {
      return { job, ownerRevoked: true };
    }
    throw error;
  }
}

async function requireLiveChatRunLease(
  transaction: JobTransaction,
  job: WorkflowJob,
  executionId: string,
) {
  if (job.executionId !== executionId) throw new AuthFailure("INVALID_WORKFLOW_EXECUTION", 409);
  const [live] = await transaction
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(and(eq(workflowJobs.id, job.id), gt(workflowJobs.runLeaseUntil, sql`clock_timestamp()`)));
  if (!live) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
}

export async function createChatTurn(
  account: CurrentAccount,
  rawInput: unknown,
  options: { database?: JobDatabase; dispatchDelaySeconds?: number } = {},
): Promise<ChatTurnCreationResult> {
  const parsed = sendChatMessageInput.safeParse(rawInput);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);

  const database = options.database ?? getDatabase();
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        conversationId: parsed.data.conversationId ?? null,
        question: parsed.data.question,
      }),
    )
    .digest("hex");

  return database.transaction(async (transaction) => {
    await lockCurrentAccount(transaction, account);

    const [existingJob] = await transaction
      .select()
      .from(workflowJobs)
      .where(
        and(
          eq(workflowJobs.ownerId, account.id),
          eq(workflowJobs.kind, "chat_turn"),
          eq(workflowJobs.requestKey, parsed.data.requestKey),
        ),
      )
      .for("share");

    if (existingJob) {
      if (existingJob.inputHash !== inputHash || !existingJob.conversationId) {
        throw new AuthFailure("IDEMPOTENCY_CONFLICT", 409);
      }
      const [existingMessage] = await transaction
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.ownerId, account.id),
            eq(chatMessages.requestKey, parsed.data.requestKey),
            eq(chatMessages.role, "user"),
          ),
        );
      if (!existingMessage) throw new AuthFailure("SERVICE_UNAVAILABLE", 503);
      return {
        conversationId: existingJob.conversationId,
        jobId: existingJob.id,
        requestId: existingJob.requestKey,
        messageId: existingMessage.id,
        streamUrl: `/api/chat/jobs/${existingJob.id}/events`,
        created: false,
      };
    }

    let conversationId: string;
    if (parsed.data.conversationId) {
      const [ownedConversation] = await transaction
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.id, parsed.data.conversationId),
            eq(chatConversations.ownerId, account.id),
          ),
        )
        .for("update");
      if (!ownedConversation) throw new AuthFailure("NOT_FOUND", 404);
      conversationId = ownedConversation.id;
      await transaction
        .update(chatConversations)
        .set({ updatedAt: sql`clock_timestamp()` })
        .where(eq(chatConversations.id, conversationId));
    } else {
      const [createdConversation] = await transaction
        .insert(chatConversations)
        .values({
          ownerId: account.id,
          title: deriveConversationTitle(parsed.data.question),
        })
        .returning({ id: chatConversations.id });
      conversationId = createdConversation.id;
    }

    const attemptId = randomUUID();
    const dispatchNonce = randomUUID();
    const delaySeconds = Math.max(0, options.dispatchDelaySeconds ?? 0);

    const [createdJob] = await transaction
      .insert(workflowJobs)
      .values({
        ownerId: account.id,
        requestKey: parsed.data.requestKey,
        inputHash,
        kind: "chat_turn",
        conversationId,
        state: "QUEUED",
        stage: "accepted",
        attemptId,
        dispatchNonce,
        dispatchNextAt:
          delaySeconds > 0
            ? sql`clock_timestamp() + ${delaySeconds} * interval '1 second'`
            : sql`clock_timestamp()`,
        attemptDeadline: sql`clock_timestamp() + ${chatBounds.attemptMilliseconds} * interval '1 millisecond'`,
      })
      .onConflictDoNothing({
        target: [workflowJobs.ownerId, workflowJobs.kind, workflowJobs.requestKey],
      })
      .returning();

    if (!createdJob) {
      const [raced] = await transaction
        .select()
        .from(workflowJobs)
        .where(
          and(
            eq(workflowJobs.ownerId, account.id),
            eq(workflowJobs.kind, "chat_turn"),
            eq(workflowJobs.requestKey, parsed.data.requestKey),
          ),
        );
      if (!raced || raced.inputHash !== inputHash || !raced.conversationId) {
        throw new AuthFailure("IDEMPOTENCY_CONFLICT", 409);
      }
      const [racedMessage] = await transaction
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.ownerId, account.id),
            eq(chatMessages.requestKey, parsed.data.requestKey),
            eq(chatMessages.role, "user"),
          ),
        );
      if (!racedMessage) throw new AuthFailure("SERVICE_UNAVAILABLE", 503);
      return {
        conversationId: raced.conversationId,
        jobId: raced.id,
        requestId: raced.requestKey,
        messageId: racedMessage.id,
        streamUrl: `/api/chat/jobs/${raced.id}/events`,
        created: false,
      };
    }

    const [userMessage] = await transaction
      .insert(chatMessages)
      .values({
        conversationId,
        ownerId: account.id,
        role: "user",
        content: parsed.data.question,
        requestKey: parsed.data.requestKey,
        jobId: createdJob.id,
        validationStatus: "USER_INPUT",
        isProcedural: false,
      })
      .returning({ id: chatMessages.id });

    await transaction.insert(chatTurnArtifacts).values({
      jobId: createdJob.id,
      attemptId,
      questionText: parsed.data.question,
    });

    await appendEvent(transaction, createdJob, "accepted", 0);

    const createdResult = {
      conversationId,
      jobId: createdJob.id,
      requestId: createdJob.requestKey,
      messageId: userMessage.id,
      streamUrl: `/api/chat/jobs/${createdJob.id}/events`,
      created: true,
    };
    logEvent("info", "chat.turn_created", {
      jobId: createdResult.jobId,
      conversationId: createdResult.conversationId,
      requestId: createdResult.requestId,
      created: true,
    });
    return createdResult;
  });
}

export async function listOwnedConversations(
  account: CurrentAccount,
  options: { database?: JobDatabase; limit?: number } = {},
): Promise<{ conversations: ChatConversationSummaryDto[] }> {
  const database = options.database ?? getDatabase();
  const limit = Math.max(
    1,
    Math.min(
      options.limit ?? chatApiBounds.defaultConversationListLimit,
      chatApiBounds.maximumConversationListLimit,
    ),
  );

  return database.transaction(async (transaction) => {
    await lockCurrentAccount(transaction, account);
    const rows = await transaction
      .select({
        id: chatConversations.id,
        title: chatConversations.title,
        createdAt: chatConversations.createdAt,
        updatedAt: chatConversations.updatedAt,
      })
      .from(chatConversations)
      .where(eq(chatConversations.ownerId, account.id))
      .orderBy(desc(chatConversations.updatedAt), desc(chatConversations.id))
      .limit(limit);

    return {
      conversations: rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  });
}

export async function getOwnedConversation(
  account: CurrentAccount,
  conversationId: string,
  database: JobDatabase = getDatabase(),
): Promise<ChatConversationDetailDto> {
  if (!chatIdInput.safeParse(conversationId).success) {
    throw new AuthFailure("NOT_FOUND", 404);
  }

  return database.transaction(async (transaction) => {
    await lockCurrentAccount(transaction, account);
    const [conversation] = await transaction
      .select()
      .from(chatConversations)
      .where(
        and(eq(chatConversations.id, conversationId), eq(chatConversations.ownerId, account.id)),
      )
      .for("share");
    if (!conversation) throw new AuthFailure("NOT_FOUND", 404);

    const rows = await transaction
      .select()
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, conversation.id),
          eq(chatMessages.ownerId, account.id),
        ),
      )
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

    const assistantMessageIds = rows
      .filter((row) => row.role === "assistant" && row.validationStatus === "PASSED")
      .map((row) => row.id);

    const sourcesByMessageId = new Map<string, ChatHistoricalSourceDto[]>();

    if (assistantMessageIds.length > 0) {
      const sourceRows = await transaction
        .select()
        .from(chatMessageSources)
        .where(inArray(chatMessageSources.messageId, assistantMessageIds))
        .orderBy(asc(chatMessageSources.citationOrder));

      const uniqueDocumentIds = Array.from(new Set(sourceRows.map((row) => row.documentId)));
      const documentStatusById = new Map<string, string>();
      if (uniqueDocumentIds.length > 0) {
        const docs = await transaction
          .select({ id: sopDocuments.id, status: sopDocuments.status })
          .from(sopDocuments)
          .where(inArray(sopDocuments.id, uniqueDocumentIds));
        for (const doc of docs) {
          documentStatusById.set(doc.id, doc.status);
        }
      }

      for (const source of sourceRows) {
        const status = documentStatusById.get(source.documentId);
        const available = status === "ACTIVE";
        const dto: ChatHistoricalSourceDto = available
          ? {
              documentId: source.documentId,
              chunkId: source.chunkId,
              sopTitle: source.sopTitle,
              section: source.sectionPath,
              ...(source.pageStart !== null ? { pageStart: source.pageStart } : {}),
              ...(source.pageEnd !== null ? { pageEnd: source.pageEnd } : {}),
              available: true,
              sourcePath: buildBackendSourcePath(
                source.documentId,
                source.sectionPath,
                source.pageStart,
              ),
            }
          : {
              documentId: source.documentId,
              chunkId: source.chunkId,
              sopTitle: source.sopTitle,
              section: source.sectionPath,
              ...(source.pageStart !== null ? { pageStart: source.pageStart } : {}),
              ...(source.pageEnd !== null ? { pageEnd: source.pageEnd } : {}),
              available: false,
              reason: account.role === "ADMIN" && status === "DELETED" ? "DELETED" : "UNAVAILABLE",
            };
        const existing = sourcesByMessageId.get(source.messageId) ?? [];
        existing.push(dto);
        sourcesByMessageId.set(source.messageId, existing);
      }
    }

    const messages: ChatMessageDto[] = rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      requestKey: row.requestKey,
      jobId: row.jobId,
      validationStatus: row.validationStatus,
      isProcedural: row.isProcedural,
      sources: sourcesByMessageId.get(row.id) ?? [],
      timings: row.timings ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt.toISOString(),
        updatedAt: conversation.updatedAt.toISOString(),
      },
      messages,
    };
  });
}

export async function claimChatStage(
  claims: ChatCallbackClaims,
  options: ChatStageOptions = {},
): Promise<ChatStageCallbackResponse> {
  const start = performance.now();
  const database = options.database ?? getDatabase();
  const result: ChatStageCallbackResponse = await database.transaction(async (transaction): Promise<ChatStageCallbackResponse> => {
    const { job, ownerRevoked } = await verifyAndConsumeChatCallback(transaction, claims);
    if (ownerRevoked) {
      return commitChatJobFailure(transaction, job, "CHAT_ACCOUNT_REVOKED", false);
    }

    if (job.state === "COMPLETED" || job.state === "FAILED") {
      return { ok: true, terminal: true };
    }
    if (job.executionId) {
      if (job.executionId !== claims.executionId) {
        throw new AuthFailure("WORKFLOW_ALREADY_CLAIMED", 409);
      }
      return { ok: true, terminal: false };
    }
    if (job.state !== "QUEUED") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);

    await transaction
      .update(workflowJobs)
      .set({
        state: "RUNNING",
        stage: "retrieving",
        executionId: claims.executionId,
        step: 1,
        runLeaseUntil: sql`clock_timestamp() + ${chatBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    await appendChatEventOnce(transaction, job, "retrieving", 1);
    return { ok: true, terminal: false };
  });

  const durationMs = elapsedMs(start);
  recordStageTiming("chat", "claim", durationMs);
  logEvent("info", "chat.stage_completed", {
    jobId: claims.jobId,
    conversationId: claims.conversationId,
    stage: "claim",
    outcome: result.terminal ? "terminal" : "ok",
    durationMs,
  });
  return result;
}

export async function retrieveChatStage(
  claims: ChatCallbackClaims,
  options: ChatStageOptions = {},
): Promise<ChatStageCallbackResponse> {
  const database = options.database ?? getDatabase();
  const env = options.env ?? process.env;

  const prep = await database.transaction(async (transaction) => {
    const { job, ownerRevoked } = await verifyAndConsumeChatCallback(transaction, claims);
    if (ownerRevoked) {
      await commitChatJobFailure(transaction, job, "CHAT_ACCOUNT_REVOKED", false);
      return { kind: "done" as const, terminal: true };
    }
    if (job.state === "COMPLETED" || job.state === "FAILED") {
      return { kind: "done" as const, terminal: true };
    }
    await requireLiveChatRunLease(transaction, job, claims.executionId);
    if (job.step >= 3) {
      return { kind: "done" as const, terminal: false };
    }
    if (job.state !== "RUNNING" || job.step !== 1) {
      throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);
    }

    const [userMessage] = await transaction
      .select({
        id: chatMessages.id,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.jobId, job.id),
          eq(chatMessages.ownerId, job.ownerId),
          eq(chatMessages.role, "user"),
        ),
      );
    if (!userMessage) {
      await commitChatJobFailure(transaction, job, "CHAT_WORKFLOW_FAILED", false);
      return { kind: "done" as const, terminal: true };
    }

    // Bounded persisted history acts strictly as query-rewrite context, never as evidence.
    const priorRows = await transaction
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, job.conversationId!),
          eq(chatMessages.ownerId, job.ownerId),
          ne(chatMessages.id, userMessage.id),
          lte(chatMessages.createdAt, userMessage.createdAt),
        ),
      )
      .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
      .limit(chatApiBounds.historyWindowTurns);

    const history: ConversationTurn[] = priorRows.reverse().map((row) => ({
      role: row.role,
      content: row.content,
    }));

    return {
      kind: "run" as const,
      jobId: job.id,
      attemptId: job.attemptId,
      question: userMessage.content,
      history,
    };
  });

  if (prep.kind === "done") {
    return { ok: true, terminal: prep.terminal };
  }

  const retrieveEvidence = options.retrieveEvidenceImpl ?? retrieveActiveSopEvidence;
  const retrievalStart = performance.now();
  let retrievalResult;
  try {
    retrievalResult = await retrieveEvidence(
      { question: prep.question, history: prep.history },
      {
        database,
        env,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        ...options.retrievalOptions,
      },
    );
  } catch (error) {
    recordStageTiming("chat", "retrieve", elapsedMs(retrievalStart));
    const retryable = error instanceof RetrievalError ? error.transient : true;
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, "RETRIEVAL_FAILED", retryable);
    });
  }
  const retrievalMs = elapsedMs(retrievalStart);
  recordStageTiming("chat", "retrieve", retrievalMs);

  return database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.id, prep.jobId))
      .for("update");
    if (
      !job ||
      job.kind !== "chat_turn" ||
      job.attemptId !== prep.attemptId ||
      job.executionId !== claims.executionId ||
      job.state !== "RUNNING" ||
      job.step !== 1
    ) {
      throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    }

    try {
      await lockActiveOwner(transaction, job.ownerId);
    } catch (error) {
      if (error instanceof AuthFailure && error.code === "UNAUTHENTICATED") {
        return commitChatJobFailure(transaction, job, "CHAT_ACCOUNT_REVOKED", false);
      }
      throw error;
    }

    await appendChatEventOnce(transaction, job, "reranking", 2);

    if (retrievalResult.kind === "no_evidence") {
      return commitNoEvidenceTurn(transaction, job, {
        retrievalMs,
        generateMs: 0,
        deterministicCheckMs: 0,
        judgeMs: 0,
        citationResolveMs: 0,
        totalMs: retrievalMs,
      });
    }

    const retrievalPayload: ChatTurnRetrievalArtifact = {
      originalQuestion: retrievalResult.originalQuestion,
      standaloneQuery: retrievalResult.standaloneQuery,
      passages: retrievalResult.passages,
      retrievalMs,
      mode: retrievalResult.metadata.mode,
      embeddingModel: retrievalResult.metadata.embeddingModel,
      rerankerModel: retrievalResult.metadata.rerankerModel,
      rewriteModel: retrievalResult.metadata.rewriteModel,
    };

    await transaction
      .insert(chatTurnArtifacts)
      .values({
        jobId: job.id,
        attemptId: job.attemptId,
        questionText: prep.question,
        retrievalPayload,
        candidatePayload: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .onConflictDoUpdate({
        target: chatTurnArtifacts.jobId,
        set: {
          attemptId: job.attemptId,
          questionText: prep.question,
          retrievalPayload,
          candidatePayload: null,
          updatedAt: sql`clock_timestamp()`,
        },
      });

    await transaction
      .update(workflowJobs)
      .set({
        stage: "generating",
        step: 3,
        runLeaseUntil: sql`clock_timestamp() + ${chatBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    await appendChatEventOnce(transaction, job, "generating", 3);
    return { ok: true, terminal: false };
  });
}

export async function generateChatStage(
  claims: ChatCallbackClaims,
  options: ChatStageOptions = {},
): Promise<ChatStageCallbackResponse> {
  const database = options.database ?? getDatabase();
  const env = options.env ?? process.env;

  const prep = await database.transaction(async (transaction) => {
    const { job, ownerRevoked } = await verifyAndConsumeChatCallback(transaction, claims);
    if (ownerRevoked) {
      await commitChatJobFailure(transaction, job, "CHAT_ACCOUNT_REVOKED", false);
      return { kind: "done" as const, terminal: true };
    }
    if (job.state === "COMPLETED" || job.state === "FAILED") {
      return { kind: "done" as const, terminal: true };
    }
    await requireLiveChatRunLease(transaction, job, claims.executionId);
    if (job.step >= 4) {
      return { kind: "done" as const, terminal: false };
    }
    if (job.state !== "RUNNING" || job.step !== 3) {
      throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);
    }

    const [artifact] = await transaction
      .select()
      .from(chatTurnArtifacts)
      .where(and(eq(chatTurnArtifacts.jobId, job.id), eq(chatTurnArtifacts.attemptId, job.attemptId)));

    if (!artifact?.retrievalPayload) {
      await commitChatJobFailure(transaction, job, "CHAT_WORKFLOW_FAILED", true);
      return { kind: "done" as const, terminal: true };
    }

    return {
      kind: "run" as const,
      jobId: job.id,
      attemptId: job.attemptId,
      retrievalPayload: artifact.retrievalPayload,
    };
  });

  if (prep.kind === "done") {
    return { ok: true, terminal: prep.terminal };
  }

  let configuration;
  try {
    configuration = answerConfiguration(env);
  } catch (error) {
    const code: AnswerFailureCode =
      error instanceof AnswerStageError ? error.code : "ANSWER_CONFIG_MISSING";
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, code, false);
    });
  }

  const generateCandidate = options.generateCandidateImpl ?? generateAnswerCandidate;
  const generateStart = performance.now();
  let candidate;
  try {
    candidate = await generateCandidate(
      {
        question: prep.retrievalPayload.standaloneQuery,
        passages: prep.retrievalPayload.passages as RerankedPassage[],
      },
      configuration,
      {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      },
    );
  } catch (error) {
    recordStageTiming("chat", "generate", elapsedMs(generateStart));
    const code: AnswerFailureCode =
      error instanceof AnswerStageError ? error.code : "ANSWER_PROVIDER_TRANSIENT";
    const retryable = error instanceof AnswerStageError ? error.retryable : true;
    recordProviderOutcome("openai_answer", classifyChatProviderOutcome(code, retryable));
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, code, retryable);
    });
  }
  const generateMs = elapsedMs(generateStart);
  recordStageTiming("chat", "generate", generateMs);
  recordProviderOutcome("openai_answer", "ok");

  return database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.id, prep.jobId))
      .for("update");
    if (
      !job ||
      job.kind !== "chat_turn" ||
      job.attemptId !== prep.attemptId ||
      job.executionId !== claims.executionId ||
      job.state !== "RUNNING" ||
      job.step !== 3
    ) {
      throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    }

    try {
      await lockActiveOwner(transaction, job.ownerId);
    } catch (error) {
      if (error instanceof AuthFailure && error.code === "UNAUTHENTICATED") {
        return commitChatJobFailure(transaction, job, "CHAT_ACCOUNT_REVOKED", false);
      }
      throw error;
    }

    if (candidate.status === "no_evidence") {
      return commitNoEvidenceTurn(transaction, job, {
        retrievalMs: prep.retrievalPayload.retrievalMs,
        generateMs,
        deterministicCheckMs: 0,
        judgeMs: 0,
        citationResolveMs: 0,
        totalMs: Number((prep.retrievalPayload.retrievalMs + generateMs).toFixed(2)),
      });
    }

    const candidatePayload: ChatTurnCandidateArtifact = {
      isProcedural: candidate.isProcedural,
      claims: candidate.claims,
      generateMs,
      answerModel: configuration.answerModel,
    };

    await transaction
      .update(chatTurnArtifacts)
      .set({
        candidatePayload,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(chatTurnArtifacts.jobId, job.id), eq(chatTurnArtifacts.attemptId, job.attemptId)));

    await transaction
      .update(workflowJobs)
      .set({
        stage: "validating",
        step: 4,
        runLeaseUntil: sql`clock_timestamp() + ${chatBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    await appendChatEventOnce(transaction, job, "validating", 4);
    return { ok: true, terminal: false };
  });
}

export async function validateChatStage(
  claims: ChatCallbackClaims,
  options: ChatStageOptions = {},
): Promise<ChatStageCallbackResponse> {
  const database = options.database ?? getDatabase();
  const env = options.env ?? process.env;

  const prep = await database.transaction(async (transaction) => {
    const { job, ownerRevoked } = await verifyAndConsumeChatCallback(transaction, claims);
    if (ownerRevoked) {
      await commitChatJobFailure(transaction, job, "CHAT_ACCOUNT_REVOKED", false);
      return { kind: "done" as const, terminal: true };
    }
    if (job.state === "COMPLETED" || job.state === "FAILED") {
      return { kind: "done" as const, terminal: true };
    }
    await requireLiveChatRunLease(transaction, job, claims.executionId);
    if (job.state !== "RUNNING" || job.step !== 4) {
      throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);
    }

    const [artifact] = await transaction
      .select()
      .from(chatTurnArtifacts)
      .where(and(eq(chatTurnArtifacts.jobId, job.id), eq(chatTurnArtifacts.attemptId, job.attemptId)));

    if (!artifact?.retrievalPayload || !artifact.candidatePayload) {
      await commitChatJobFailure(transaction, job, "CHAT_WORKFLOW_FAILED", true);
      return { kind: "done" as const, terminal: true };
    }

    return {
      kind: "run" as const,
      jobId: job.id,
      attemptId: job.attemptId,
      retrievalPayload: artifact.retrievalPayload,
      candidatePayload: artifact.candidatePayload,
    };
  });

  if (prep.kind === "done") {
    return { ok: true, terminal: prep.terminal };
  }

  const passages = prep.retrievalPayload.passages as RerankedPassage[];
  const deterministicStart = performance.now();
  const deterministicResult = validateCandidateDeterministically(
    {
      status: "supported",
      isProcedural: prep.candidatePayload.isProcedural,
      claims: prep.candidatePayload.claims,
    },
    passages,
  );
  const deterministicCheckMs = elapsedMs(deterministicStart);

  if (!deterministicResult.ok) {
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, "ANSWER_VALIDATION_FAILED", false);
    });
  }

  let configuration;
  try {
    configuration = answerConfiguration(env);
  } catch (error) {
    const code: AnswerFailureCode =
      error instanceof AnswerStageError ? error.code : "ANSWER_CONFIG_MISSING";
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, code, false);
    });
  }

  const citedChunkIds = new Set(prep.candidatePayload.claims.flatMap((claim) => claim.chunkIds));
  const citedPassages = passages.filter((passage) => citedChunkIds.has(passage.chunkId));
  const judgeCandidate = options.judgeCandidateImpl ?? judgeAnswerCandidate;
  const judgeStart = performance.now();
  let judgeDecision;
  try {
    judgeDecision = await judgeCandidate(
      {
        question: prep.retrievalPayload.standaloneQuery,
        claims: prep.candidatePayload.claims,
        citedPassages,
      },
      configuration,
      {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      },
    );
  } catch (error) {
    recordStageTiming("chat", "validate", elapsedMs(judgeStart));
    const code: AnswerFailureCode =
      error instanceof AnswerStageError ? error.code : "JUDGE_PROVIDER_TRANSIENT";
    const retryable = error instanceof AnswerStageError ? error.retryable : true;
    recordProviderOutcome("openai_judge", classifyChatProviderOutcome(code, retryable));
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, code, retryable);
    });
  }
  const judgeMs = elapsedMs(judgeStart);
  recordStageTiming("chat", "validate", Number((deterministicCheckMs + judgeMs).toFixed(2)));
  recordProviderOutcome("openai_judge", "ok");

  if (!judgeDecision.passed) {
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, "ANSWER_JUDGE_REJECTED", false);
    });
  }

  const formattedAnswer = formatValidatedAnswerText(
    prep.candidatePayload.isProcedural,
    prep.candidatePayload.claims,
  );
  if (formattedAnswer.length === 0 || formattedAnswer.length > answerDefaults.maxAnswerChars) {
    return database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(workflowJobs)
        .where(eq(workflowJobs.id, prep.jobId))
        .for("update");
      if (!job || job.attemptId !== prep.attemptId || job.executionId !== claims.executionId) {
        throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
      }
      return commitChatJobFailure(transaction, job, "ANSWER_VALIDATION_FAILED", false);
    });
  }

  return database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.id, prep.jobId))
      .for("update");
    if (
      !job ||
      job.kind !== "chat_turn" ||
      job.attemptId !== prep.attemptId ||
      job.executionId !== claims.executionId ||
      job.state !== "RUNNING" ||
      job.step !== 4
    ) {
      throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    }

    await transaction.delete(chatTurnArtifacts).where(eq(chatTurnArtifacts.jobId, job.id));

    try {
      await lockActiveOwner(transaction, job.ownerId);
    } catch (error) {
      if (error instanceof AuthFailure && error.code === "UNAUTHENTICATED") {
        return commitChatJobFailure(transaction, job, "CHAT_ACCOUNT_REVOKED", false);
      }
      throw error;
    }

    const citationStart = performance.now();
    let citationResolution;
    try {
      citationResolution = await resolveVerifiedCitations(prep.candidatePayload.claims, passages, {
        database: transaction as unknown as AuthDatabase,
        loadOriginalPassagesImpl: options.resolveCitationPassagesImpl,
      });
    } catch {
      return commitChatJobFailure(transaction, job, "RETRIEVAL_FAILED", true);
    }
    const citationResolveMs = elapsedMs(citationStart);

    const timings: ChatTurnTimings = {
      retrievalMs: prep.retrievalPayload.retrievalMs,
      generateMs: prep.candidatePayload.generateMs,
      deterministicCheckMs,
      judgeMs,
      citationResolveMs,
      totalMs: Number(
        (
          prep.retrievalPayload.retrievalMs +
          prep.candidatePayload.generateMs +
          deterministicCheckMs +
          judgeMs +
          citationResolveMs
        ).toFixed(2),
      ),
    };

    if (!citationResolution.ok) {
      return commitNoEvidenceTurn(transaction, job, timings);
    }

    const assistantMessage = await commitAssistantMessage(transaction, {
      job,
      content: formattedAnswer,
      validationStatus: "PASSED",
      isProcedural: prep.candidatePayload.isProcedural,
      timings,
    });

    for (let index = 0; index < citationResolution.sources.length; index++) {
      const source = citationResolution.sources[index];
      await transaction
        .insert(chatMessageSources)
        .values({
          messageId: assistantMessage.id,
          documentId: source.documentId,
          chunkId: source.chunkId,
          sopTitle: source.sopTitle,
          sectionPath: source.section,
          pageStart: source.pageStart ?? null,
          pageEnd: source.pageEnd ?? null,
          citationOrder: index,
        })
        .onConflictDoNothing({
          target: [chatMessageSources.messageId, chatMessageSources.chunkId],
        });
    }

    await transaction
      .update(workflowJobs)
      .set({
        state: "COMPLETED",
        stage: "completed",
        step: 6,
        assistantMessageId: assistantMessage.id,
        errorCode: null,
        errorRetryable: null,
        runLeaseUntil: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    await transaction
      .update(chatConversations)
      .set({ updatedAt: sql`clock_timestamp()` })
      .where(eq(chatConversations.id, job.conversationId!));

    await appendChatEventOnce(transaction, job, "completed", 6);

    await transaction.insert(auditEvents).values({
      actorId: job.ownerId,
      action: "chat.turn_completed",
      targetId: job.conversationId!,
      outcome: "passed",
      metadata: {
        jobId: job.id,
        sourceCount: citationResolution.sources.length,
        isProcedural: prep.candidatePayload.isProcedural,
      },
    });

    recordStageTiming("chat", "total", timings.totalMs);
    logEvent("info", "chat.turn_completed", {
      jobId: job.id,
      conversationId: job.conversationId,
      outcome: "supported",
      sourceCount: citationResolution.sources.length,
      isProcedural: prep.candidatePayload.isProcedural,
      durationMs: timings.totalMs,
    });

    return { ok: true, terminal: true };
  });
}

export async function failChatStage(
  claims: ChatCallbackClaims,
  options: ChatStageOptions = {},
): Promise<ChatStageCallbackResponse> {
  const database = options.database ?? getDatabase();
  return database.transaction(async (transaction) => {
    const { job } = await verifyAndConsumeChatCallback(transaction, claims);
    return commitChatJobFailure(transaction, job, "CHAT_WORKFLOW_FAILED", true);
  });
}
