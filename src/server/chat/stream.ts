import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { buildBackendSourcePath } from "../answers/citations";
import { supportedAnswerSourceSchema, type SupportedAnswerSource } from "../answers/contracts";
import { requireCurrentAccount, type CurrentAccount } from "../auth/authorization";
import { AuthFailure } from "../auth/errors";
import { getDatabase } from "../db/client";
import {
  chatMessages,
  chatMessageSources,
  sopDocuments,
  workflowEvents,
  workflowJobs,
  type ChatTurnTimings,
} from "../db/schema";
import { chatBounds, parseEventCursor } from "../jobs/contracts";
import {
  lockCurrentAccount,
  type JobDatabase,
  type WorkflowEvent,
} from "../jobs/service";
import {
  chatCompletedEventSchema,
  chatFailedEventSchema,
  chatIdInput,
  chatNoEvidenceEventSchema,
  chatProgressEventSchema,
  chatStreamTimeoutEventSchema,
  chatWireVersion,
  noEvidenceFallbackMessage,
  resolveSafeChatError,
  type ChatProgressStage,
} from "./contracts";

export type ChatStreamEventContext = {
  jobId: string;
  conversationId: string;
  requestId: string;
  errorCode: string | null;
  errorRetryable: boolean | null;
  completedMessage: {
    id: string;
    validationStatus: "PASSED" | "NO_EVIDENCE";
    content: string;
    isProcedural: boolean;
    timings: ChatTurnTimings | null;
    sources: SupportedAnswerSource[];
    allSourcesActive: boolean;
  } | null;
};

export type ChatStreamBatch = {
  conversationId: string;
  events: WorkflowEvent[];
  context: ChatStreamEventContext;
  terminal: boolean;
};

export type ChatStreamBatchLoader = (
  account: CurrentAccount,
  jobId: string,
  after: number,
  release: (batch: ChatStreamBatch) => void,
) => Promise<void>;

const progressStages = new Set<string>([
  "accepted",
  "retrieving",
  "reranking",
  "generating",
  "validating",
]);

const textEncoder = new TextEncoder();

export function serializeChatEvent(
  event: Pick<WorkflowEvent, "jobId" | "sequence" | "kind">,
  context: ChatStreamEventContext,
): { bytes: Uint8Array; terminal: boolean; eventName: string } {
  const frameId = `${event.jobId}:${event.sequence}`;

  if (progressStages.has(event.kind) || event.kind === "retrying") {
    const stage: ChatProgressStage =
      event.kind === "retrying" ? "accepted" : (event.kind as ChatProgressStage);
    const payload = chatProgressEventSchema.parse({
      v: chatWireVersion,
      requestId: context.requestId,
      conversationId: context.conversationId,
      jobId: context.jobId,
      stage,
    });
    return {
      bytes: textEncoder.encode(
        `id: ${frameId}\nevent: ${stage}\ndata: ${JSON.stringify(payload)}\n\n`,
      ),
      terminal: false,
      eventName: stage,
    };
  }

  if (event.kind === "completed") {
    const message = context.completedMessage;
    // Withhold any answer if its committed PASSED record or any cited ACTIVE SOP was revoked before emit.
    if (
      message &&
      message.validationStatus === "PASSED" &&
      message.allSourcesActive &&
      message.sources.length > 0
    ) {
      const payload = chatCompletedEventSchema.parse({
        v: chatWireVersion,
        requestId: context.requestId,
        conversationId: context.conversationId,
        jobId: context.jobId,
        messageId: message.id,
        answer: message.content,
        isProcedural: message.isProcedural,
        sources: message.sources,
        timings: message.timings,
      });
      return {
        bytes: textEncoder.encode(
          `id: ${frameId}\nevent: completed\ndata: ${JSON.stringify(payload)}\n\n`,
        ),
        terminal: true,
        eventName: "completed",
      };
    }

    const fallback = chatNoEvidenceEventSchema.parse({
      v: chatWireVersion,
      requestId: context.requestId,
      conversationId: context.conversationId,
      jobId: context.jobId,
      messageId: null,
      message: noEvidenceFallbackMessage,
      sources: [],
      timings: message?.timings ?? null,
    });
    return {
      bytes: textEncoder.encode(
        `id: ${frameId}\nevent: no_evidence\ndata: ${JSON.stringify(fallback)}\n\n`,
      ),
      terminal: true,
      eventName: "no_evidence",
    };
  }

  if (event.kind === "no_evidence") {
    const message = context.completedMessage;
    const payload = chatNoEvidenceEventSchema.parse({
      v: chatWireVersion,
      requestId: context.requestId,
      conversationId: context.conversationId,
      jobId: context.jobId,
      messageId: message?.validationStatus === "NO_EVIDENCE" ? message.id : null,
      message: noEvidenceFallbackMessage,
      sources: [],
      timings: message?.timings ?? null,
    });
    return {
      bytes: textEncoder.encode(
        `id: ${frameId}\nevent: no_evidence\ndata: ${JSON.stringify(payload)}\n\n`,
      ),
      terminal: true,
      eventName: "no_evidence",
    };
  }

  const safeError = resolveSafeChatError(context.errorCode, context.errorRetryable);
  const payload = chatFailedEventSchema.parse({
    v: chatWireVersion,
    requestId: context.requestId,
    conversationId: context.conversationId,
    jobId: context.jobId,
    errorCode: safeError.errorCode,
    message: safeError.message,
    retryable: safeError.retryable,
  });
  return {
    bytes: textEncoder.encode(`id: ${frameId}\nevent: failed\ndata: ${JSON.stringify(payload)}\n\n`),
    terminal: true,
    eventName: "failed",
  };
}

export async function withOwnedChatEvents<T>(
  account: CurrentAccount,
  jobId: string,
  after: number,
  release: (batch: ChatStreamBatch) => T,
  database: JobDatabase = getDatabase(),
): Promise<T> {
  if (!chatIdInput.safeParse(jobId).success) {
    throw new AuthFailure("NOT_FOUND", 404);
  }

  return database.transaction(async (transaction) => {
    await lockCurrentAccount(transaction, account);
    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(
        and(
          eq(workflowJobs.id, jobId),
          eq(workflowJobs.ownerId, account.id),
          eq(workflowJobs.kind, "chat_turn"),
        ),
      )
      .for("share");

    if (!job || !job.conversationId) {
      throw new AuthFailure("NOT_FOUND", 404);
    }
    if (after > job.eventSequence) {
      throw new AuthFailure("INVALID_EVENT_CURSOR", 400);
    }

    const events = await transaction
      .select()
      .from(workflowEvents)
      .where(and(eq(workflowEvents.jobId, job.id), gt(workflowEvents.sequence, after)))
      .orderBy(asc(workflowEvents.sequence))
      .limit(16);

    const needsTerminalMessage = events.some(
      (event) => event.kind === "completed" || event.kind === "no_evidence",
    );

    let completedMessage: ChatStreamEventContext["completedMessage"] = null;
    if (needsTerminalMessage && job.assistantMessageId) {
      const [message] = await transaction
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.id, job.assistantMessageId),
            eq(chatMessages.ownerId, account.id),
            eq(chatMessages.role, "assistant"),
          ),
        );

      if (message && (message.validationStatus === "PASSED" || message.validationStatus === "NO_EVIDENCE")) {
        let verifiedSources: SupportedAnswerSource[] = [];
        let allSourcesActive = false;

        if (message.validationStatus === "PASSED") {
          const sourceRows = await transaction
            .select()
            .from(chatMessageSources)
            .where(eq(chatMessageSources.messageId, message.id))
            .orderBy(asc(chatMessageSources.citationOrder));

          if (sourceRows.length > 0) {
            const uniqueDocIds = Array.from(new Set(sourceRows.map((row) => row.documentId)));
            const liveDocs = await transaction
              .select({ id: sopDocuments.id, status: sopDocuments.status })
              .from(sopDocuments)
              .where(inArray(sopDocuments.id, uniqueDocIds));
            const activeDocIds = new Set(
              liveDocs.filter((doc) => doc.status === "ACTIVE").map((doc) => doc.id),
            );

            allSourcesActive = sourceRows.every((row) => activeDocIds.has(row.documentId));
            if (allSourcesActive) {
              verifiedSources = sourceRows.map((row) =>
                supportedAnswerSourceSchema.parse({
                  documentId: row.documentId,
                  chunkId: row.chunkId,
                  sopTitle: row.sopTitle,
                  section: row.sectionPath,
                  ...(row.pageStart !== null ? { pageStart: row.pageStart } : {}),
                  ...(row.pageEnd !== null ? { pageEnd: row.pageEnd } : {}),
                  sourcePath: buildBackendSourcePath(row.documentId, row.sectionPath, row.pageStart),
                }),
              );
            }
          }
        }

        completedMessage = {
          id: message.id,
          validationStatus: message.validationStatus,
          content: message.content,
          isProcedural: message.isProcedural,
          timings: message.timings ?? null,
          sources: verifiedSources,
          allSourcesActive,
        };
      }
    }

    return release({
      conversationId: job.conversationId,
      events,
      context: {
        jobId: job.id,
        conversationId: job.conversationId,
        requestId: job.requestKey,
        errorCode: job.errorCode,
        errorRetryable: job.errorRetryable,
        completedMessage,
      },
      terminal: job.state === "COMPLETED" || job.state === "FAILED",
    });
  });
}

function waitForPoll(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export type CreateChatStreamOptions = {
  account?: CurrentAccount;
  database?: JobDatabase;
  queueBudgetBytes?: number;
  streamMilliseconds?: number;
  pollMilliseconds?: number;
  heartbeatMilliseconds?: number;
  loadBatchImpl?: ChatStreamBatchLoader;
};

export async function createChatEventStream(
  request: Request,
  jobId: string,
  options: CreateChatStreamOptions = {},
): Promise<Response> {
  const currentAccount = options.account ?? (await requireCurrentAccount(request.headers));
  if (!chatIdInput.safeParse(jobId).success) {
    throw new AuthFailure("NOT_FOUND", 404);
  }

  let cursor: number;
  try {
    cursor = parseEventCursor(request.headers.get("last-event-id"), jobId);
  } catch {
    throw new AuthFailure("INVALID_EVENT_CURSOR", 400);
  }

  const loadBatch: ChatStreamBatchLoader =
    options.loadBatchImpl ??
    (async (account, id, after, release) => {
      await withOwnedChatEvents(account, id, after, release, options.database ?? getDatabase());
    });

  const queueBudgetBytes = options.queueBudgetBytes ?? chatBounds.streamQueueBytes;
  if (
    !Number.isSafeInteger(queueBudgetBytes) ||
    queueBudgetBytes < 1 ||
    queueBudgetBytes > chatBounds.streamQueueBytes
  ) {
    throw new RangeError("Invalid internal chat stream queue budget.");
  }

  const streamMilliseconds = options.streamMilliseconds ?? chatBounds.streamMilliseconds;
  const pollMilliseconds = options.pollMilliseconds ?? chatBounds.pollMilliseconds;
  const heartbeatMilliseconds = options.heartbeatMilliseconds ?? chatBounds.heartbeatMilliseconds;

  let conversationId = "";
  await loadBatch(currentAccount, jobId, cursor, (batch) => {
    conversationId = batch.conversationId;
  });

  const cancellation = new AbortController();
  const signal = AbortSignal.any([request.signal, cancellation.signal]);
  const openedAt = Date.now();
  const heartbeat = textEncoder.encode(": heartbeat\n\n");
  const timeoutPayload = chatStreamTimeoutEventSchema.parse({
    v: chatWireVersion,
    code: "STREAM_TIMEOUT",
    retryable: true,
  });
  const timeoutFrame = textEncoder.encode(
    `event: stream_timeout\ndata: ${JSON.stringify(timeoutPayload)}\n\n`,
  );

  let lastFrameAt = openedAt;
  let finished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let deadlineTimer: ReturnType<typeof setTimeout>;

  const abort = () => stop();
  function stop(close = true) {
    if (finished) return;
    finished = true;
    clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", abort);
    cancellation.abort();
    if (close) streamController.close();
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        streamController = controller;
        deadlineTimer = setTimeout(() => stop(), streamMilliseconds);
        deadlineTimer.unref();
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) stop();
      },
      async pull(controller) {
        if (finished) return;
        try {
          while (!signal.aborted && !finished) {
            if ((controller.desiredSize ?? 0) < heartbeat.byteLength) return;
            let emitted = false;
            let backpressured = false;

            await loadBatch(currentAccount, jobId, cursor, (batch) => {
              if (finished || signal.aborted) return;
              if (Date.now() - openedAt >= streamMilliseconds - pollMilliseconds) {
                if ((controller.desiredSize ?? 0) >= timeoutFrame.byteLength) {
                  controller.enqueue(timeoutFrame);
                }
                stop();
                return;
              }

              for (const event of batch.events) {
                const frame = serializeChatEvent(event, batch.context);
                if ((controller.desiredSize ?? 0) < frame.bytes.byteLength) {
                  backpressured = true;
                  break;
                }
                controller.enqueue(frame.bytes);
                cursor = event.sequence;
                emitted = true;
                lastFrameAt = Date.now();
                if (frame.terminal) {
                  stop();
                  break;
                }
              }

              if (batch.terminal && !batch.events.length) {
                stop();
              }

              if (
                !emitted &&
                !backpressured &&
                !finished &&
                Date.now() - lastFrameAt >= heartbeatMilliseconds
              ) {
                if ((controller.desiredSize ?? 0) >= heartbeat.byteLength) {
                  controller.enqueue(heartbeat);
                  lastFrameAt = Date.now();
                  emitted = true;
                } else {
                  backpressured = true;
                }
              }
            });

            if (finished || backpressured || emitted || (controller.desiredSize ?? 0) <= 0) {
              return;
            }
            await waitForPoll(pollMilliseconds, signal);
          }
          stop();
        } catch {
          // A revoked owner or unavailable database must never receive another frame.
          stop();
        }
      },
      cancel() {
        stop(false);
      },
    },
    { highWaterMark: queueBudgetBytes, size: (chunk) => chunk.byteLength },
  );

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Request-Id": randomUUID(),
      "X-Chat-Conversation-Id": conversationId,
      "X-Chat-Job-Id": jobId,
    },
  });
}
