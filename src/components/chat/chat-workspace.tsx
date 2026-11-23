"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { accountSchema, buttonClassName, linkClassName, type Account } from "../auth/client";
import {
  authorizeCitationSource,
  chatNoEvidenceText,
  chatStageLabels,
  fetchConversationDetail,
  streamChatTurn,
  type ChatMessageItem,
  type ChatSourceItem,
  type ChatStage,
  type ParsedChatSseEvent,
} from "./client";
import { SafeMarkdown } from "./safe-markdown";

const sessionStorageKey = "sop-chat-current-conversation";
const uuidSchema = z.uuid();

type AuthState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "error" }
  | { kind: "signed-in"; user: Account };

type StreamFailureState = {
  question: string;
  errorCode: string;
  message: string;
  retryable: boolean;
};

type TurnMetrics = {
  firstProgressMs: number | null;
  firstAnswerMs: number | null;
  completedMs: number | null;
};

async function readCurrentAccount(signal: AbortSignal): Promise<AuthState | null> {
  try {
    const response = await fetch("/api/account", {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (response.status === 401) return { kind: "anonymous" };
    const parsed = z.object({ user: accountSchema }).safeParse(await response.json());
    if (!response.ok || !parsed.success) throw new Error("Account unavailable");
    return { kind: "signed-in", user: parsed.data.user };
  } catch {
    return signal.aborted ? null : { kind: "error" };
  }
}

function readStoredConversationId(): string | null {
  if (typeof window === "undefined") return null;
  const fromQuery = new URLSearchParams(window.location.search).get("c");
  if (fromQuery && uuidSchema.safeParse(fromQuery).success) return fromQuery;
  try {
    const fromSession = window.sessionStorage.getItem(sessionStorageKey);
    if (fromSession && uuidSchema.safeParse(fromSession).success) return fromSession;
  } catch {
    return null;
  }
  return null;
}

function persistCurrentConversationId(conversationId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (conversationId) {
      window.sessionStorage.setItem(sessionStorageKey, conversationId);
    } else {
      window.sessionStorage.removeItem(sessionStorageKey);
    }
  } catch {
    // Ignore restricted sessionStorage contexts.
  }
  const url = new URL(window.location.href);
  if (conversationId) {
    url.searchParams.set("c", conversationId);
  } else {
    url.searchParams.delete("c");
  }
  window.history.replaceState(null, "", url.pathname + url.search);
}

function formatPageLabel(source: ChatSourceItem): string | null {
  if (source.pageStart === undefined) return null;
  if (source.pageEnd !== undefined && source.pageEnd > source.pageStart) {
    return `Pages ${source.pageStart}–${source.pageEnd}`;
  }
  return `Page ${source.pageStart}`;
}

export function ChatWorkspace() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const [authRefresh, setAuthRefresh] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [questionInput, setQuestionInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [activeStage, setActiveStage] = useState<ChatStage | null>(null);
  const [streamFailure, setStreamFailure] = useState<StreamFailureState | null>(null);
  const [sourceFeedback, setSourceFeedback] = useState<{
    key: string;
    kind: "loading" | "error" | "opened";
    text: string;
  } | null>(null);
  const [metrics, setMetrics] = useState<TurnMetrics>({
    firstProgressMs: null,
    firstAnswerMs: null,
    completedMs: null,
  });

  const streamAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void readCurrentAccount(controller.signal).then((state) => {
      if (state && !controller.signal.aborted) setAuth(state);
    });
    return () => controller.abort();
  }, [authRefresh]);

  useEffect(() => {
    if (auth.kind !== "signed-in") return;
    const storedId = readStoredConversationId();
    if (!storedId) return;
    const controller = new AbortController();
    void fetchConversationDetail(storedId, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        if (!detail) {
          persistCurrentConversationId(null);
          setConversationId(null);
          setMessages([]);
          return;
        }
        persistCurrentConversationId(detail.conversation.id);
        setConversationId(detail.conversation.id);
        setMessages(detail.messages);
        setHistoryError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof Error && error.message === "UNAUTHENTICATED") {
          setAuth({ kind: "anonymous" });
          return;
        }
        setHistoryError("Could not load your current session messages. Start a new chat or retry.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingHistory(false);
      });
    return () => controller.abort();
  }, [auth.kind]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  function startNewChat() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    persistCurrentConversationId(null);
    setConversationId(null);
    setMessages([]);
    setSubmitting(false);
    setActiveStage(null);
    setStreamFailure(null);
    setHistoryError(null);
    setSourceFeedback(null);
    setMetrics({ firstProgressMs: null, firstAnswerMs: null, completedMs: null });
  }

  async function submitQuestion(rawQuestion: string) {
    const trimmed = rawQuestion.trim();
    if (!trimmed || submitting) return;

    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    const requestKey = crypto.randomUUID();
    const optimisticUserId = `pending-${requestKey}`;
    const startedAt = performance.now();
    let firstProgressMs: number | null = null;
    let firstAnswerMs: number | null = null;

    setSubmitting(true);
    setActiveStage("accepted");
    setStreamFailure(null);
    setHistoryError(null);
    setSourceFeedback(null);
    setQuestionInput("");
    setMetrics({ firstProgressMs: null, firstAnswerMs: null, completedMs: null });

    setMessages((previous) => [
      ...previous,
      {
        id: optimisticUserId,
        role: "user",
        content: trimmed,
        requestKey,
        jobId: null,
        validationStatus: "USER_INPUT",
        isProcedural: false,
        sources: [],
        timings: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    const handleSseEvent = (event: ParsedChatSseEvent) => {
      if (controller.signal.aborted) return;

      if (event.type === "progress") {
        if (firstProgressMs === null) {
          firstProgressMs = Math.max(0, Math.round(performance.now() - startedAt));
          setMetrics((current) => ({ ...current, firstProgressMs }));
        }
        setActiveStage(event.data.stage);
        setConversationId(event.data.conversationId);
        persistCurrentConversationId(event.data.conversationId);
        return;
      }

      if (event.type === "completed") {
        const nowElapsed = Math.max(0, Math.round(performance.now() - startedAt));
        if (firstAnswerMs === null) firstAnswerMs = nowElapsed;
        setMetrics({
          firstProgressMs: firstProgressMs ?? nowElapsed,
          firstAnswerMs,
          completedMs: nowElapsed,
        });
        setConversationId(event.data.conversationId);
        persistCurrentConversationId(event.data.conversationId);
        setMessages((previous) => {
          const filtered = previous.filter((item) => item.id !== event.data.messageId);
          return [
            ...filtered,
            {
              id: event.data.messageId,
              role: "assistant",
              content: event.data.answer,
              requestKey: event.data.requestId,
              jobId: event.data.jobId,
              validationStatus: "PASSED",
              isProcedural: event.data.isProcedural,
              sources: event.data.sources.map((source) => ({
                ...source,
                available: true,
              })),
              timings: event.data.timings,
              createdAt: new Date().toISOString(),
            },
          ];
        });
        setActiveStage(null);
        return;
      }

      if (event.type === "no_evidence") {
        const nowElapsed = Math.max(0, Math.round(performance.now() - startedAt));
        if (firstAnswerMs === null) firstAnswerMs = nowElapsed;
        setMetrics({
          firstProgressMs: firstProgressMs ?? nowElapsed,
          firstAnswerMs,
          completedMs: nowElapsed,
        });
        setConversationId(event.data.conversationId);
        persistCurrentConversationId(event.data.conversationId);
        const messageId = event.data.messageId ?? `no-evidence-${event.data.requestId}`;
        setMessages((previous) => {
          const filtered = previous.filter((item) => item.id !== messageId);
          return [
            ...filtered,
            {
              id: messageId,
              role: "assistant",
              content: chatNoEvidenceText,
              requestKey: event.data.requestId,
              jobId: event.data.jobId,
              validationStatus: "NO_EVIDENCE",
              isProcedural: false,
              sources: [],
              timings: event.data.timings,
              createdAt: new Date().toISOString(),
            },
          ];
        });
        setActiveStage(null);
        return;
      }

      if (event.type === "failed") {
        const nowElapsed = Math.max(0, Math.round(performance.now() - startedAt));
        setMetrics({
          firstProgressMs: firstProgressMs ?? nowElapsed,
          firstAnswerMs: null,
          completedMs: nowElapsed,
        });
        setConversationId(event.data.conversationId);
        persistCurrentConversationId(event.data.conversationId);
        setStreamFailure({
          question: trimmed,
          errorCode: event.data.errorCode,
          message: event.data.message,
          retryable: event.data.retryable,
        });
        setActiveStage(null);
      }
    };

    try {
      await streamChatTurn(
        {
          ...(conversationId ? { conversationId } : {}),
          requestKey,
          question: trimmed,
        },
        handleSseEvent,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof Error && error.message === "UNAUTHENTICATED") {
        setAuth({ kind: "anonymous" });
        return;
      }
      setStreamFailure({
        question: trimmed,
        errorCode: "CHAT_STREAM_INTERRUPTED",
        message:
          error instanceof Error
            ? error.message
            : "Unable to complete SOP verification right now. Please try again.",
        retryable: true,
      });
    } finally {
      if (!controller.signal.aborted) {
        setSubmitting(false);
        setActiveStage(null);
      }
    }
  }

  async function openSource(source: ChatSourceItem, messageId: string) {
    if (!source.available || !source.sourcePath) return;
    const key = `${messageId}:${source.chunkId}`;
    setSourceFeedback({ key, kind: "loading", text: `Authorizing ${source.sopTitle}...` });
    try {
      const authorized = await authorizeCitationSource(source.sourcePath);
      setSourceFeedback({
        key,
        kind: "opened",
        text: `Authorized source link for ${authorized.title}.`,
      });
      window.open(authorized.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setSourceFeedback({
        key,
        kind: "error",
        text: error instanceof Error ? error.message : "Source is unavailable.",
      });
    }
  }

  if (auth.kind === "loading") {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <p role="status" className="text-sm text-[#475569]">
          Checking sign-in...
        </p>
      </main>
    );
  }

  if (auth.kind === "anonymous") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-[#0f172a] sm:text-3xl">
          SOP Chat
        </h1>
        <p className="mt-4 text-sm text-[#475569]">
          Sign in with your invited company account to ask questions against verified SOPs.
        </p>
        <div className="mt-4">
          <Link href="/sign-in" className={linkClassName}>
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  if (auth.kind === "error") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-[#0f172a] sm:text-3xl">
          SOP Chat
        </h1>
        <p role="alert" className="mt-4 text-sm text-[#991b1b]">
          Sign-in status is temporarily unavailable.
        </p>
        <button
          type="button"
          onClick={() => {
            setAuth({ kind: "loading" });
            setAuthRefresh((value) => value + 1);
          }}
          className={`mt-4 ${buttonClassName}`}
        >
          Retry
        </button>
      </main>
    );
  }

  return (
    <main
      className="mx-auto flex min-h-screen max-w-4xl flex-col px-4 py-6 sm:px-6 sm:py-8"
      data-chat-workspace="ready"
      data-conversation-id={conversationId ?? ""}
      data-chat-stage={activeStage ?? "idle"}
      data-first-progress-ms={metrics.firstProgressMs ?? ""}
      data-first-answer-ms={metrics.firstAnswerMs ?? ""}
      data-completed-ms={metrics.completedMs ?? ""}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] pb-4">
        <nav aria-label="Primary" className="flex flex-wrap items-center gap-4">
          <Link
            href="/chat"
            aria-current="page"
            className="inline-flex min-h-11 items-center font-semibold text-[#1d4ed8] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
          >
            Chat
          </Link>
          <Link
            href="/documents"
            className="inline-flex min-h-11 items-center text-[#0f172a] underline-offset-4 hover:text-[#1d4ed8] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
          >
            List Document SOP
          </Link>
          {auth.user.role === "ADMIN" && (
            <Link
              href="/"
              className="inline-flex min-h-11 items-center text-[#0f172a] underline-offset-4 hover:text-[#1d4ed8] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
            >
              Account
            </Link>
          )}
        </nav>

        <button
          type="button"
          onClick={startNewChat}
          className="min-h-11 cursor-pointer rounded-md border border-[#cbd5e1] bg-white px-4 py-2 text-sm font-medium text-[#0f172a] hover:bg-[#f1f5f9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
        >
          New chat
        </button>
      </header>

      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-[#0f172a] sm:text-2xl">
            SOP Assistant
          </h1>
          <p className="mt-1 text-sm text-[#475569]">
            Current session answers are verified strictly against active SOP documents.
          </p>
        </div>
        <p className="text-xs text-[#64748b] break-words">
          Signed in as {auth.user.name} ({auth.user.role === "ADMIN" ? "Admin" : "Staff"})
        </p>
      </div>

      {historyError && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]"
        >
          {historyError}
        </div>
      )}

      <section
        aria-label="Current session messages"
        className="mt-6 flex-1 space-y-5"
        data-testid="chat-messages-list"
      >
        {loadingHistory && (
          <p role="status" className="text-sm text-[#475569]">
            Loading current session...
          </p>
        )}

        {!loadingHistory && messages.length === 0 && !submitting && !streamFailure && (
          <div
            data-testid="chat-empty-state"
            className="rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-5 text-sm text-[#475569]"
          >
            Ask a procedural or specification question from an active company SOP to begin.
          </div>
        )}

        {messages.map((message) => {
          if (message.role === "user") {
            return (
              <article
                key={message.id}
                data-message-role="user"
                className="ml-auto max-w-[68ch] rounded-xl border border-[#bfdbfe] bg-[#eff6ff] p-4 text-sm text-[#0f172a] sm:text-base"
              >
                <p className="text-xs font-medium text-[#1e40af]">You</p>
                <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">
                  {message.content}
                </p>
              </article>
            );
          }

          if (message.validationStatus === "NO_EVIDENCE") {
            return (
              <article
                key={message.id}
                data-message-role="assistant"
                data-outcome="no_evidence"
                className="max-w-[68ch] rounded-xl border border-[#e2e8f0] bg-[#f8fafc] p-4 text-[#0f172a]"
              >
                <p className="text-xs font-medium text-[#475569]">SOP Assistant</p>
                <p className="mt-2 text-sm font-medium text-[#0f172a] sm:text-base">
                  {chatNoEvidenceText}
                </p>
              </article>
            );
          }

          return (
            <article
              key={message.id}
              data-message-role="assistant"
              data-outcome="completed"
              className="max-w-[68ch] rounded-xl border border-[#e2e8f0] bg-white p-4 shadow-xs"
            >
              <p className="text-xs font-medium text-[#065f46]">Verified SOP answer</p>
              <div className="mt-2">
                <SafeMarkdown content={message.content} />
              </div>

              {message.sources.length > 0 && (
                <div className="mt-4 border-t border-[#e2e8f0] pt-3">
                  <p className="text-xs font-medium text-[#475569]">Sources</p>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {message.sources.map((source) => {
                      const pageLabel = formatPageLabel(source);
                      const feedbackKey = `${message.id}:${source.chunkId}`;
                      const isActiveFeedback = sourceFeedback?.key === feedbackKey;

                      return (
                        <li key={source.chunkId} className="max-w-full">
                          {source.available && source.sourcePath ? (
                            <button
                              type="button"
                              onClick={() => void openSource(source, message.id)}
                              data-testid={`citation-button-${source.chunkId}`}
                              data-document-id={source.documentId}
                              className="min-h-11 max-w-full cursor-pointer rounded-md border border-[#bfdbfe] bg-[#eff6ff] px-3 py-2 text-left text-xs font-medium text-[#1e40af] hover:bg-[#dbeafe] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
                            >
                              <span className="block break-words font-semibold">
                                {source.sopTitle}
                              </span>
                              <span className="block break-words text-[#475569] [font-variant-numeric:tabular-nums]">
                                {source.section}
                                {pageLabel ? ` · ${pageLabel}` : ""}
                              </span>
                            </button>
                          ) : (
                            <div
                              data-source-unavailable="true"
                              data-document-id={source.documentId}
                              className="min-h-11 max-w-full rounded-md border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-xs text-[#64748b]"
                            >
                              <span className="block break-words font-medium text-[#475569]">
                                {source.sopTitle}
                              </span>
                              <span className="block break-words">
                                {source.section}
                                {pageLabel ? ` · ${pageLabel}` : ""} · Source unavailable
                              </span>
                            </div>
                          )}
                          {isActiveFeedback && (
                            <p
                              role={sourceFeedback.kind === "error" ? "alert" : "status"}
                              data-source-status={sourceFeedback.kind}
                              className={`mt-1 text-xs ${
                                sourceFeedback.kind === "error"
                                  ? "text-[#991b1b]"
                                  : "text-[#475569]"
                              }`}
                            >
                              {sourceFeedback.text}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </article>
          );
        })}

        {submitting && activeStage && (
          <div
            role="status"
            aria-live="polite"
            data-testid="chat-progress-panel"
            data-chat-stage={activeStage}
            className="max-w-[68ch] rounded-xl border border-[#bfdbfe] bg-[#eff6ff] p-4 text-sm text-[#1e40af]"
          >
            <p className="font-medium">{chatStageLabels[activeStage]}</p>
            <p className="mt-1 text-xs text-[#475569]">
              Final answers appear only after evidence and citation checks pass.
            </p>
          </div>
        )}

        {streamFailure && (
          <div
            role="alert"
            data-testid="chat-error-panel"
            data-outcome="failed"
            data-error-code={streamFailure.errorCode}
            className="max-w-[68ch] rounded-xl border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]"
          >
            <p className="font-medium">{streamFailure.message}</p>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => void submitQuestion(streamFailure.question)}
                className="min-h-11 cursor-pointer rounded-md border border-[#991b1b] bg-white px-4 py-2 text-sm font-medium text-[#991b1b] hover:bg-[#fee2e2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
              >
                Retry question
              </button>
            </div>
          </div>
        )}
      </section>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submitQuestion(questionInput);
        }}
        className="mt-6 border-t border-[#e2e8f0] pt-4"
      >
        <label
          htmlFor="chat-question-input"
          className="block text-sm font-medium text-[#0f172a]"
        >
          Ask an SOP question
        </label>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end">
          <textarea
            id="chat-question-input"
            name="question"
            rows={2}
            maxLength={2000}
            value={questionInput}
            onChange={(event) => setQuestionInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submitQuestion(questionInput);
              }
            }}
            disabled={submitting}
            placeholder="Ask a question about an active SOP procedure or specification..."
            className="min-h-11 w-full min-w-0 flex-1 resize-y rounded-md border border-[#cbd5e1] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#64748b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8] disabled:cursor-not-allowed disabled:bg-[#f1f5f9]"
          />
          <button
            type="submit"
            disabled={submitting || questionInput.trim().length === 0}
            className="min-h-11 shrink-0 cursor-pointer rounded-md bg-[#1d4ed8] px-5 py-2 text-sm font-medium text-white hover:bg-[#1e40af] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Checking..." : "Send"}
          </button>
        </div>
      </form>
    </main>
  );
}
