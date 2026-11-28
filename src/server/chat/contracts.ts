import { z } from "zod";
import {
  answerFailureCodes,
  answerStageTimingsSchema,
  noEvidenceFallbackMessage,
  safeAnswerErrorMessages,
  supportedAnswerSourceSchema,
  type AnswerFailureCode,
} from "../answers/contracts";
import { retrievalDefaults } from "../retrieval/contracts";

export { noEvidenceFallbackMessage };

export const chatWireVersion = 1 as const;

export const chatApiBounds = {
  maximumBodyBytes: 16_384,
  maximumConversationTitleChars: 120,
  maximumConversationSearchChars: 100,
  maximumConversationCursorChars: 256,
  defaultConversationListLimit: 20,
  maximumConversationListLimit: 50,
  historyWindowTurns: retrievalDefaults.historyMaxTurns,
} as const;

export const chatRateLimits = {
  send: { maximum: 30, windowSeconds: 60 },
  stream: { maximum: 60, windowSeconds: 60 },
  read: { maximum: 120, windowSeconds: 60 },
  mutate: { maximum: 60, windowSeconds: 60 },
} as const;

export const sendChatMessageInput = z
  .object({
    conversationId: z.uuid().optional(),
    requestKey: z.uuid(),
    question: z.string().trim().min(1).max(retrievalDefaults.maxQuestionChars),
  })
  .strict();

export type SendChatMessageInput = z.infer<typeof sendChatMessageInput>;

export const renameChatConversationInput = z
  .object({
    title: z.string().trim().min(1).max(chatApiBounds.maximumConversationTitleChars),
  })
  .strict();

export type RenameChatConversationInput = z.infer<typeof renameChatConversationInput>;

const conversationCursorSchema = z
  .object({
    updatedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/)
      .refine((value) => {
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) return false;
        const date = new Date(parsed);
        return date.getUTCFullYear() >= 1 && date.toISOString().slice(0, 19) === value.slice(0, 19);
      }, "Invalid calendar timestamp"),
    id: z.uuid(),
  })
  .strict();

export type ConversationListCursor = z.infer<typeof conversationCursorSchema>;

export function encodeConversationCursor(cursor: ConversationListCursor): string {
  const validated = conversationCursorSchema.parse(cursor);
  return Buffer.from(JSON.stringify(validated), "utf8").toString("base64url");
}

export function decodeConversationCursor(raw: string): ConversationListCursor | null {
  if (!raw || raw.length > chatApiBounds.maximumConversationCursorChars) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsedJson: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    const parsed = conversationCursorSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const chatEmptyStageBody = z.object({}).strict();
export const chatIdInput = z.uuid();

export const chatSafeErrorCodes = [
  ...answerFailureCodes,
  "CHAT_TIMEOUT",
  "CHAT_WORKFLOW_FAILED",
  "CHAT_ACCOUNT_REVOKED",
] as const;

export type ChatSafeErrorCode = (typeof chatSafeErrorCodes)[number];

const chatSafeErrorMessages: Readonly<Record<ChatSafeErrorCode, string>> = {
  ...safeAnswerErrorMessages,
  CHAT_TIMEOUT: "This request timed out before verification completed. Please try again.",
  CHAT_WORKFLOW_FAILED: "Unable to complete SOP verification right now. Please try again shortly.",
  CHAT_ACCOUNT_REVOKED: "Your session is no longer active. Sign in again to continue.",
};

const defaultRetryableByCode: Readonly<Record<ChatSafeErrorCode, boolean>> = {
  ANSWER_INVALID_INPUT: false,
  ANSWER_CONFIG_MISSING: false,
  RETRIEVAL_FAILED: true,
  ANSWER_PROVIDER_TRANSIENT: true,
  ANSWER_PROVIDER_REJECTED: false,
  ANSWER_GENERATOR_INVALID_OUTPUT: false,
  ANSWER_VALIDATION_FAILED: false,
  JUDGE_PROVIDER_TRANSIENT: true,
  JUDGE_PROVIDER_REJECTED: false,
  JUDGE_INVALID_OUTPUT: false,
  ANSWER_JUDGE_REJECTED: false,
  CHAT_TIMEOUT: true,
  CHAT_WORKFLOW_FAILED: true,
  CHAT_ACCOUNT_REVOKED: false,
};

export function resolveSafeChatError(
  rawCode: string | null | undefined,
  rawRetryable?: boolean | null,
): { errorCode: ChatSafeErrorCode; message: string; retryable: boolean } {
  const matchedCode = (chatSafeErrorCodes as readonly string[]).includes(rawCode ?? "")
    ? (rawCode as ChatSafeErrorCode)
    : "CHAT_WORKFLOW_FAILED";
  return {
    errorCode: matchedCode,
    message: chatSafeErrorMessages[matchedCode],
    retryable:
      typeof rawRetryable === "boolean" ? rawRetryable : defaultRetryableByCode[matchedCode],
  };
}

export function isAnswerFailureCode(code: string): code is AnswerFailureCode {
  return (answerFailureCodes as readonly string[]).includes(code);
}

export const chatProgressStageSchema = z.enum([
  "accepted",
  "retrieving",
  "reranking",
  "generating",
  "validating",
]);

export type ChatProgressStage = z.infer<typeof chatProgressStageSchema>;

export const chatProgressEventSchema = z
  .object({
    v: z.literal(chatWireVersion),
    requestId: z.uuid(),
    conversationId: z.uuid(),
    jobId: z.uuid(),
    stage: chatProgressStageSchema,
  })
  .strict();

export type ChatProgressEvent = z.infer<typeof chatProgressEventSchema>;

export const chatCompletedEventSchema = z
  .object({
    v: z.literal(chatWireVersion),
    requestId: z.uuid(),
    conversationId: z.uuid(),
    jobId: z.uuid(),
    messageId: z.uuid(),
    answer: z.string().min(1),
    isProcedural: z.boolean(),
    sources: z.array(supportedAnswerSourceSchema).min(1),
    timings: answerStageTimingsSchema.nullable(),
  })
  .strict();

export type ChatCompletedEvent = z.infer<typeof chatCompletedEventSchema>;

export const chatNoEvidenceEventSchema = z
  .object({
    v: z.literal(chatWireVersion),
    requestId: z.uuid(),
    conversationId: z.uuid(),
    jobId: z.uuid(),
    messageId: z.uuid().nullable(),
    message: z.literal(noEvidenceFallbackMessage),
    sources: z.tuple([]),
    timings: answerStageTimingsSchema.nullable(),
  })
  .strict();

export type ChatNoEvidenceEvent = z.infer<typeof chatNoEvidenceEventSchema>;

export const chatFailedEventSchema = z
  .object({
    v: z.literal(chatWireVersion),
    requestId: z.uuid(),
    conversationId: z.uuid(),
    jobId: z.uuid(),
    errorCode: z.enum(chatSafeErrorCodes),
    message: z.string().min(1).max(300),
    retryable: z.boolean(),
  })
  .strict();

export type ChatFailedEvent = z.infer<typeof chatFailedEventSchema>;

export const chatStreamTimeoutEventSchema = z
  .object({
    v: z.literal(chatWireVersion),
    code: z.literal("STREAM_TIMEOUT"),
    retryable: z.literal(true),
  })
  .strict();

export type ChatStreamTimeoutEvent = z.infer<typeof chatStreamTimeoutEventSchema>;

export const chatHistoricalSourceSchema = z
  .object({
    documentId: z.uuid(),
    chunkId: z.uuid(),
    sopTitle: z.string().min(1),
    section: z.string().min(1),
    pageStart: z.number().int().min(1).optional(),
    pageEnd: z.number().int().min(1).optional(),
    available: z.boolean(),
    reason: z.enum(["UNAVAILABLE", "DELETED"]).optional(),
    sourcePath: z.string().regex(/^\/api\/documents\/[^/?#\s]+\/source(?:\?[^\s#]*)?$/).optional(),
  })
  .strict();

export type ChatHistoricalSourceDto = z.infer<typeof chatHistoricalSourceSchema>;

export type ChatConversationSummaryDto = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ChatConversationListDto = {
  conversations: ChatConversationSummaryDto[];
  nextCursor: string | null;
};

export type ChatConversationRenameResult = {
  conversation: ChatConversationSummaryDto;
};

export type ChatConversationArchiveResult = {
  archived: true;
  conversationId: string;
  archivedAt: string;
};

export type ChatMessageDto = {
  id: string;
  role: "user" | "assistant";
  content: string;
  requestKey: string;
  jobId: string | null;
  validationStatus: "USER_INPUT" | "PASSED" | "NO_EVIDENCE";
  isProcedural: boolean;
  sources: ChatHistoricalSourceDto[];
  timings: z.infer<typeof answerStageTimingsSchema> | null;
  createdAt: string;
};

export type ChatConversationDetailDto = {
  conversation: ChatConversationSummaryDto;
  messages: ChatMessageDto[];
  activeJobId: string | null;
};

export type ChatTurnCreationResult = {
  conversationId: string;
  jobId: string;
  requestId: string;
  messageId: string;
  streamUrl: string;
  created: boolean;
};

export type ChatStageCallbackResponse = {
  ok: true;
  terminal: boolean;
};
