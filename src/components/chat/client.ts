import { z } from "zod";

export const chatNoEvidenceText = "No SOP found for this question" as const;

const backendSourcePathPattern = /^\/api\/documents\/[^/?#\s]+\/source(?:\?[^\s#]*)?$/;

export const chatSourceSchema = z.object({
  documentId: z.string().min(1),
  chunkId: z.string().min(1),
  sopTitle: z.string().min(1),
  section: z.string().min(1),
  pageStart: z.number().int().min(1).optional(),
  pageEnd: z.number().int().min(1).optional(),
  available: z.boolean().default(true),
  reason: z.enum(["UNAVAILABLE", "DELETED"]).optional(),
  sourcePath: z.string().regex(backendSourcePathPattern).optional(),
});

export type ChatSourceItem = z.infer<typeof chatSourceSchema>;

export const chatTimingsSchema = z.object({
  retrievalMs: z.number(),
  generateMs: z.number(),
  deterministicCheckMs: z.number(),
  judgeMs: z.number(),
  citationResolveMs: z.number(),
  totalMs: z.number(),
});

export type ChatTimings = z.infer<typeof chatTimingsSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  requestKey: z.string(),
  jobId: z.string().nullable(),
  validationStatus: z.enum(["USER_INPUT", "PASSED", "NO_EVIDENCE"]),
  isProcedural: z.boolean(),
  sources: z.array(chatSourceSchema),
  timings: chatTimingsSchema.nullable(),
  createdAt: z.string(),
});

export type ChatMessageItem = z.infer<typeof chatMessageSchema>;

export const conversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationListSchema = z.object({
  conversations: z.array(conversationSummarySchema),
  nextCursor: z.string().nullable(),
});

export type ConversationListResult = z.infer<typeof conversationListSchema>;

export const conversationRenameSchema = z.object({
  conversation: conversationSummarySchema,
});

export const conversationArchiveSchema = z.object({
  archived: z.literal(true),
  conversationId: z.string(),
  archivedAt: z.string(),
});

export const conversationDetailSchema = z.object({
  conversation: conversationSummarySchema,
  messages: z.array(chatMessageSchema),
  activeJobId: z.string().nullable().optional(),
});

export type ConversationDetail = z.infer<typeof conversationDetailSchema>;

const progressStageSchema = z.enum([
  "accepted",
  "retrieving",
  "reranking",
  "generating",
  "validating",
]);

export type ChatStage = z.infer<typeof progressStageSchema>;

const progressDataSchema = z.object({
  v: z.literal(1),
  requestId: z.string(),
  conversationId: z.string(),
  jobId: z.string(),
  stage: progressStageSchema,
});

const completedDataSchema = z.object({
  v: z.literal(1),
  requestId: z.string(),
  conversationId: z.string(),
  jobId: z.string(),
  messageId: z.string(),
  answer: z.string(),
  isProcedural: z.boolean(),
  sources: z.array(
    z.object({
      documentId: z.string(),
      chunkId: z.string(),
      sopTitle: z.string(),
      section: z.string(),
      pageStart: z.number().int().min(1).optional(),
      pageEnd: z.number().int().min(1).optional(),
      sourcePath: z.string().regex(backendSourcePathPattern),
    }),
  ),
  timings: chatTimingsSchema.nullable(),
});

const noEvidenceDataSchema = z.object({
  v: z.literal(1),
  requestId: z.string(),
  conversationId: z.string(),
  jobId: z.string(),
  messageId: z.string().nullable(),
  message: z.literal(chatNoEvidenceText),
  sources: z.tuple([]),
  timings: chatTimingsSchema.nullable(),
});

const failedDataSchema = z.object({
  v: z.literal(1),
  requestId: z.string(),
  conversationId: z.string(),
  jobId: z.string(),
  errorCode: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

const streamTimeoutDataSchema = z.object({
  v: z.literal(1),
  code: z.literal("STREAM_TIMEOUT"),
  retryable: z.literal(true),
});

export type ParsedChatSseEvent =
  | { type: "progress"; id: string | null; data: z.infer<typeof progressDataSchema> }
  | { type: "completed"; id: string | null; data: z.infer<typeof completedDataSchema> }
  | { type: "no_evidence"; id: string | null; data: z.infer<typeof noEvidenceDataSchema> }
  | { type: "failed"; id: string | null; data: z.infer<typeof failedDataSchema> }
  | { type: "stream_timeout"; id: string | null; data: z.infer<typeof streamTimeoutDataSchema> };

export const chatStageLabels: Readonly<Record<ChatStage, string>> = {
  accepted: "Request accepted",
  retrieving: "Searching verified ACTIVE SOPs",
  reranking: "Ranking relevant SOP passages",
  generating: "Drafting evidence-grounded response",
  validating: "Verifying steps, numbers, and citations",
};

export function parseRawSseFrame(rawFrame: string): ParsedChatSseEvent | null {
  const lines = rawFrame.replace(/\r\n?/g, "\n").split("\n");
  let id: string | null = null;
  let eventName = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!eventName || dataLines.length === 0) return null;

  let json: unknown;
  try {
    json = JSON.parse(dataLines.join("\n"));
  } catch {
    return null;
  }

  if (progressStageSchema.safeParse(eventName).success) {
    const parsed = progressDataSchema.safeParse(json);
    return parsed.success ? { type: "progress", id, data: parsed.data } : null;
  }
  if (eventName === "completed") {
    const parsed = completedDataSchema.safeParse(json);
    return parsed.success ? { type: "completed", id, data: parsed.data } : null;
  }
  if (eventName === "no_evidence") {
    const parsed = noEvidenceDataSchema.safeParse(json);
    return parsed.success ? { type: "no_evidence", id, data: parsed.data } : null;
  }
  if (eventName === "failed") {
    const parsed = failedDataSchema.safeParse(json);
    return parsed.success ? { type: "failed", id, data: parsed.data } : null;
  }
  if (eventName === "stream_timeout") {
    const parsed = streamTimeoutDataSchema.safeParse(json);
    return parsed.success ? { type: "stream_timeout", id, data: parsed.data } : null;
  }

  return null;
}

const sourceAuthorizationSchema = z.object({
  source: z.object({
    documentId: z.string(),
    title: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    disposition: z.enum(["inline", "attachment"]),
    url: z.string().regex(/^\/api\/documents\/[^/?#\s]+\/source\/content\?/),
    expiresAt: z.string(),
    ttlSeconds: z.number().int().positive(),
  }),
});

export async function fetchConversations(
  options: { limit?: number; cursor?: string | null; query?: string } = {},
  signal?: AbortSignal,
): Promise<ConversationListResult> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const trimmedQuery = options.query?.trim() ?? "";
  if (trimmedQuery) params.set("q", trimmedQuery);
  const queryString = params.toString();
  const url = queryString ? `/api/chat/conversations?${queryString}` : "/api/chat/conversations";

  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.status === 401) throw new Error("UNAUTHENTICATED");
  const payload: unknown = await response.json().catch(() => null);
  const parsed = conversationListSchema.safeParse(payload);
  if (!response.ok || !parsed.success) {
    throw new Error("Could not load saved conversations.");
  }
  return parsed.data;
}

export async function renameConversation(
  conversationId: string,
  title: string,
  signal?: AbortSignal,
): Promise<ConversationSummary> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
    signal,
  });
  if (response.status === 401) throw new Error("UNAUTHENTICATED");
  if (response.status === 404) throw new Error("Conversation not found.");
  const payload: unknown = await response.json().catch(() => null);
  const parsed = conversationRenameSchema.safeParse(payload);
  if (!response.ok || !parsed.success) {
    throw new Error("Could not rename this conversation.");
  }
  return parsed.data.conversation;
}

export async function archiveConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<{ conversationId: string; archivedAt: string }> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.status === 401) throw new Error("UNAUTHENTICATED");
  if (response.status === 404) throw new Error("Conversation not found.");
  const payload: unknown = await response.json().catch(() => null);
  const parsed = conversationArchiveSchema.safeParse(payload);
  if (!response.ok || !parsed.success) {
    throw new Error("Could not archive this conversation.");
  }
  return {
    conversationId: parsed.data.conversationId,
    archivedAt: parsed.data.archivedAt,
  };
}

export async function fetchConversationDetail(
  conversationId: string,
  signal: AbortSignal,
): Promise<ConversationDetail | null> {
  const response = await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.status === 404) return null;
  if (response.status === 401) throw new Error("UNAUTHENTICATED");
  const payload: unknown = await response.json().catch(() => null);
  const parsed = conversationDetailSchema.safeParse(payload);
  if (!response.ok || !parsed.success) {
    throw new Error("Could not load conversation history.");
  }
  return parsed.data;
}

export async function authorizeCitationSource(
  sourcePath: string,
  signal?: AbortSignal,
): Promise<{ url: string; title: string; fileName: string }> {
  if (!backendSourcePathPattern.test(sourcePath)) {
    throw new Error("Source access path is invalid.");
  }
  const response = await fetch(sourcePath, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (response.status === 401) {
    throw new Error("Your session has expired. Sign in again to open this SOP.");
  }
  if (response.status === 404) {
    throw new Error("This SOP source is no longer available.");
  }
  const payload: unknown = await response.json().catch(() => null);
  const parsed = sourceAuthorizationSchema.safeParse(payload);
  if (!response.ok || !parsed.success) {
    throw new Error("Could not authorize access to this SOP right now.");
  }
  return {
    url: parsed.data.source.url,
    title: parsed.data.source.title,
    fileName: parsed.data.source.fileName,
  };
}

async function readEventStreamResponse(
  response: Response,
  onEvent: (event: ParsedChatSseEvent) => void,
): Promise<{ terminal: boolean; timedOut: boolean; lastEventId: string | null }> {
  if (!response.body) {
    throw new Error("Chat stream was unavailable.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  let timedOut = false;
  let lastEventId: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseRawSseFrame(frame);
        if (parsed) {
          if (parsed.id) lastEventId = parsed.id;
          if (parsed.type === "stream_timeout") {
            timedOut = true;
          } else if (
            parsed.type === "completed" ||
            parsed.type === "no_evidence" ||
            parsed.type === "failed"
          ) {
            terminal = true;
          }
          onEvent(parsed);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { terminal, timedOut, lastEventId };
}

export async function streamChatTurn(
  params: {
    conversationId?: string;
    requestKey: string;
    question: string;
  },
  onEvent: (event: ParsedChatSseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat/messages", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(params),
    signal,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
    if (response.status === 401) throw new Error("UNAUTHENTICATED");
    if (code.success && code.data.error.code === "RATE_LIMITED") {
      throw new Error("Too many chat requests. Wait a moment and try again.");
    }
    throw new Error("Unable to submit your question right now. Please try again.");
  }

  let jobId = response.headers.get("x-chat-job-id");
  let lastEventId: string | null = null;

  const firstPass = await readEventStreamResponse(response, (event) => {
    if ("jobId" in event.data && event.data.jobId) {
      jobId = event.data.jobId;
    }
    onEvent(event);
  });

  if (firstPass.terminal || signal.aborted) return;
  lastEventId = firstPass.lastEventId;

  const maxReconnects = 3;
  for (let attempt = 0; attempt < maxReconnects; attempt++) {
    if (!jobId || signal.aborted) break;
    const reconnectHeaders = new Headers({ Accept: "text/event-stream" });
    if (lastEventId) reconnectHeaders.set("Last-Event-ID", lastEventId);

    const reconnectResponse = await fetch(`/api/chat/jobs/${encodeURIComponent(jobId)}/events`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: reconnectHeaders,
      signal,
    });

    if (reconnectResponse.status === 401) throw new Error("UNAUTHENTICATED");
    if (!reconnectResponse.ok) {
      throw new Error("Connection interrupted while checking SOP verification. Please try again.");
    }

    const nextPass = await readEventStreamResponse(reconnectResponse, onEvent);
    if (nextPass.lastEventId) lastEventId = nextPass.lastEventId;
    if (nextPass.terminal || signal.aborted) return;
    if (!nextPass.timedOut) break;
  }

  if (!signal.aborted) {
    throw new Error("Verification is still running or timed out. Please retry.");
  }
}

export async function resumeChatJobStream(
  jobId: string,
  onEvent: (event: ParsedChatSseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let lastEventId: string | null = null;
  const maxReconnects = 4;

  for (let attempt = 0; attempt < maxReconnects; attempt++) {
    if (signal.aborted) return;
    const headers = new Headers({ Accept: "text/event-stream" });
    if (lastEventId) headers.set("Last-Event-ID", lastEventId);

    const response = await fetch(`/api/chat/jobs/${encodeURIComponent(jobId)}/events`, {
      credentials: "same-origin",
      cache: "no-store",
      headers,
      signal,
    });

    if (response.status === 401) throw new Error("UNAUTHENTICATED");
    if (response.status === 404) return;
    if (!response.ok) {
      throw new Error("Connection interrupted while checking SOP verification. Please try again.");
    }

    const pass = await readEventStreamResponse(response, onEvent);
    if (pass.lastEventId) lastEventId = pass.lastEventId;
    if (pass.terminal || signal.aborted) return;
    if (!pass.timedOut) break;
  }
}
