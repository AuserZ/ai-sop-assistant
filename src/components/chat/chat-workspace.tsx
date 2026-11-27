"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  BookOpen,
  ExternalLink,
  FileText,
  Loader2,
  RotateCcw,
  SendHorizontal,
  ShieldCheck,
  X,
} from "lucide-react";
import { z } from "zod";
import { accountSchema, buttonClassName, type Account } from "@/components/auth/client";
import { AppShell } from "@/components/layout/app-shell";
import { BrandMark, buttonClass, StatusBadge } from "@/components/ui/primitives";
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

type InspectedCitation = {
  key: string;
  messageId: string;
  source: ChatSourceItem;
  status: "loading" | "ready" | "error";
  authorizedUrl: string | null;
  fileName: string | null;
  statusText: string;
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
  const [inspectedCitation, setInspectedCitation] = useState<InspectedCitation | null>(null);
  const [openingSource, setOpeningSource] = useState(false);
  const [metrics, setMetrics] = useState<TurnMetrics>({
    firstProgressMs: null,
    firstAnswerMs: null,
    completedMs: null,
  });

  const streamAbortRef = useRef<AbortController | null>(null);
  const sourceAbortRef = useRef<AbortController | null>(null);

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
    void (async () => {
      setLoadingHistory(true);
      try {
        const detail = await fetchConversationDetail(storedId, controller.signal);
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
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        if (error instanceof Error && error.message === "UNAUTHENTICATED") {
          setAuth({ kind: "anonymous" });
          return;
        }
        setHistoryError("Could not load your current session messages. Start a new chat or retry.");
      } finally {
        if (!controller.signal.aborted) setLoadingHistory(false);
      }
    })();
    return () => controller.abort();
  }, [auth.kind]);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      sourceAbortRef.current?.abort();
    };
  }, []);

  function startNewChat() {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    sourceAbortRef.current?.abort();
    sourceAbortRef.current = null;
    persistCurrentConversationId(null);
    setConversationId(null);
    setMessages([]);
    setSubmitting(false);
    setActiveStage(null);
    setStreamFailure(null);
    setHistoryError(null);
    setInspectedCitation(null);
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

  async function inspectCitation(source: ChatSourceItem, messageId: string) {
    if (!source.available || !source.sourcePath) return;
    sourceAbortRef.current?.abort();
    const controller = new AbortController();
    sourceAbortRef.current = controller;
    const key = `${messageId}:${source.chunkId}`;

    setInspectedCitation({
      key,
      messageId,
      source,
      status: "loading",
      authorizedUrl: null,
      fileName: null,
      statusText: `Authorizing ${source.sopTitle}...`,
    });

    try {
      const authorized = await authorizeCitationSource(source.sourcePath, controller.signal);
      if (controller.signal.aborted) return;
      setInspectedCitation({
        key,
        messageId,
        source,
        status: "ready",
        authorizedUrl: authorized.url,
        fileName: authorized.fileName,
        statusText: `Authorized source link for ${authorized.title}.`,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setInspectedCitation({
        key,
        messageId,
        source,
        status: "error",
        authorizedUrl: null,
        fileName: null,
        statusText: error instanceof Error ? error.message : "Source is unavailable.",
      });
    }
  }

  async function openInspectedSource() {
    if (!inspectedCitation || !inspectedCitation.source.sourcePath || openingSource) return;
    setOpeningSource(true);
    try {
      const authorized = await authorizeCitationSource(inspectedCitation.source.sourcePath);
      setInspectedCitation((current) =>
        current && current.key === inspectedCitation.key
          ? {
              ...current,
              status: "ready",
              authorizedUrl: authorized.url,
              fileName: authorized.fileName,
              statusText: `Authorized source link for ${authorized.title}.`,
            }
          : current,
      );
      window.open(authorized.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setInspectedCitation((current) =>
        current && current.key === inspectedCitation.key
          ? {
              ...current,
              status: "error",
              authorizedUrl: null,
              statusText: error instanceof Error ? error.message : "Source is unavailable.",
            }
          : current,
      );
    } finally {
      setOpeningSource(false);
    }
  }

  if (auth.kind !== "signed-in") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6">
        <div className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-6">
          <BrandMark />
          <h1 className="mt-5 text-2xl font-semibold text-[#0f172a]">SOP Chat</h1>
          {auth.kind === "loading" && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-[#475569]">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              <span>Checking sign-in...</span>
            </p>
          )}
          {auth.kind === "anonymous" && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-[#475569]">
                Sign in with your invited company account to ask questions against verified SOPs.
              </p>
              <Link href="/sign-in" className={buttonClass("primary", "default", "w-full")}>
                Sign in
              </Link>
            </div>
          )}
          {auth.kind === "error" && (
            <div className="mt-4 space-y-4">
              <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                Sign-in status is temporarily unavailable.
              </p>
              <button
                type="button"
                onClick={() => {
                  setAuth({ kind: "loading" });
                  setAuthRefresh((value) => value + 1);
                }}
                className={buttonClassName}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  const inspectedPageLabel = inspectedCitation ? formatPageLabel(inspectedCitation.source) : null;

  return (
    <AppShell
      user={auth.user}
      activeMenu="chat"
      onSignedOut={() => setAuth({ kind: "anonymous" })}
      mainDataAttributes={{
        "data-chat-workspace": "ready",
        "data-conversation-id": conversationId ?? "",
        "data-chat-stage": activeStage ?? "idle",
        "data-first-progress-ms": metrics.firstProgressMs ?? "",
        "data-first-answer-ms": metrics.firstAnswerMs ?? "",
        "data-completed-ms": metrics.completedMs ?? "",
      }}
      mainClassName="mx-auto flex w-full min-w-0 max-w-6xl flex-1 flex-col px-4 py-6 outline-none sm:px-6 sm:py-8"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e2e8f0] pb-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-[#0f172a]">SOP Assistant</h1>
          <p className="mt-1 text-sm text-[#475569]">
            Current session answers are verified strictly against active SOP documents.
          </p>
        </div>

        <button
          type="button"
          onClick={startNewChat}
          className={buttonClass("secondary")}
        >
          <RotateCcw className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span>New chat</span>
        </button>
      </header>

      {historyError && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span>{historyError}</span>
        </div>
      )}

      <div className="mt-6 flex min-w-0 flex-1 flex-col gap-6 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col">
          <section
            aria-label="Current session messages"
            className="mx-auto w-full max-w-[68ch] flex-1 space-y-5"
            data-testid="chat-messages-list"
          >
            {loadingHistory && (
              <p role="status" className="flex items-center gap-2 text-sm text-[#475569]">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                <span>Loading current session...</span>
              </p>
            )}

            {!loadingHistory && messages.length === 0 && !submitting && !streamFailure && (
              <div
                data-testid="chat-empty-state"
                className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-5 text-sm text-[#475569]"
              >
                <div className="flex items-start gap-3">
                  <BookOpen className="mt-0.5 h-5 w-5 shrink-0 text-[#1d4ed8]" strokeWidth={1.5} aria-hidden="true" />
                  <p className="min-w-0 leading-relaxed">
                    Ask a procedural or specification question from an active company SOP to begin.
                  </p>
                </div>
              </div>
            )}

            {messages.map((message) => {
              if (message.role === "user") {
                return (
                  <article
                    key={message.id}
                    data-message-role="user"
                    className="ml-auto max-w-[68ch] rounded-[var(--radius-lg)] border border-[#bfdbfe] bg-[#eff6ff] p-4 text-sm text-[#0f172a] sm:text-base"
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
                    className="max-w-[68ch] rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 text-[#0f172a]"
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
                  className="max-w-[68ch] rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 sm:p-5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <ShieldCheck className="h-4 w-4 shrink-0 text-[#065f46]" strokeWidth={1.5} aria-hidden="true" />
                    <p className="text-xs font-medium text-[#065f46]">Verified SOP answer</p>
                  </div>
                  <div className="mt-3">
                    <SafeMarkdown content={message.content} />
                  </div>

                  {message.sources.length > 0 && (
                    <div className="mt-4 border-t border-[#e2e8f0] pt-3">
                      <p className="text-xs font-medium text-[#475569]">Sources</p>
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {message.sources.map((source) => {
                          const pageLabel = formatPageLabel(source);
                          const citationKey = `${message.id}:${source.chunkId}`;
                          const isSelected = inspectedCitation?.key === citationKey;

                          return (
                            <li key={source.chunkId} className="max-w-full">
                              {source.available && source.sourcePath ? (
                                <button
                                  type="button"
                                  onClick={() => void inspectCitation(source, message.id)}
                                  data-testid={`citation-button-${source.chunkId}`}
                                  data-document-id={source.documentId}
                                  aria-pressed={isSelected}
                                  className={`cp-instant min-h-11 max-w-full cursor-pointer rounded-[var(--radius-md)] border px-3 py-2 text-left text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8] ${
                                    isSelected
                                      ? "border-[#1d4ed8] bg-[#dbeafe] text-[#1e40af]"
                                      : "border-[#bfdbfe] bg-[#eff6ff] text-[#1e40af] hover:bg-[#dbeafe]"
                                  }`}
                                >
                                  <span className="flex items-center gap-1.5 font-semibold">
                                    <FileText className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                                    <span className="min-w-0 break-words">{source.sopTitle}</span>
                                  </span>
                                  <span className="tabular-nums mt-0.5 block break-words text-[#475569]">
                                    {source.section}
                                    {pageLabel ? ` · ${pageLabel}` : ""}
                                  </span>
                                </button>
                              ) : (
                                <div
                                  data-source-unavailable="true"
                                  data-document-id={source.documentId}
                                  className="min-h-11 max-w-full rounded-[var(--radius-md)] border border-[#e2e8f0] bg-[#f8fafc] px-3 py-2 text-xs text-[#64748b]"
                                >
                                  <span className="block break-words font-medium text-[#475569]">
                                    {source.sopTitle}
                                  </span>
                                  <span className="tabular-nums block break-words">
                                    {source.section}
                                    {pageLabel ? ` · ${pageLabel}` : ""} · Source unavailable
                                  </span>
                                </div>
                              )}
                              {isSelected && inspectedCitation && (
                                <p
                                  role={inspectedCitation.status === "error" ? "alert" : "status"}
                                  data-source-status={
                                    inspectedCitation.status === "ready" ? "opened" : inspectedCitation.status
                                  }
                                  className={`mt-1 text-xs ${
                                    inspectedCitation.status === "error"
                                      ? "text-[#991b1b]"
                                      : "text-[#475569]"
                                  }`}
                                >
                                  {inspectedCitation.statusText}
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
                className="max-w-[68ch] rounded-[var(--radius-lg)] border border-[#bfdbfe] bg-[#eff6ff] p-4 text-sm text-[#1e40af]"
              >
                <div className="flex items-center gap-2 font-medium">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                  <span>{chatStageLabels[activeStage]}</span>
                </div>
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
                className="max-w-[68ch] rounded-[var(--radius-lg)] border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                  <p className="font-medium">{streamFailure.message}</p>
                </div>
                <div className="mt-3">
                  <button
                    type="button"
                    onClick={() => void submitQuestion(streamFailure.question)}
                    className={buttonClass(
                      "secondary",
                      "default",
                      "border-[#fecaca] text-[#991b1b] hover:border-[#fca5a5] hover:bg-[#fee2e2]",
                    )}
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
            className="mx-auto mt-6 w-full max-w-[68ch] border-t border-[#e2e8f0] pt-4"
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
                className="cp-control min-h-11 w-full min-w-0 flex-1 resize-y rounded-[var(--radius-md)] border border-[#cbd5e1] bg-white px-3 py-2 text-sm text-[#0f172a] placeholder:text-[#64748b] hover:border-[#94a3b8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8] disabled:cursor-not-allowed disabled:bg-[#f1f5f9]"
              />
              <button
                type="submit"
                disabled={submitting || questionInput.trim().length === 0}
                className={buttonClass("primary", "default", "shrink-0")}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <SendHorizontal className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                )}
                <span>{submitting ? "Checking..." : "Send"}</span>
              </button>
            </div>
          </form>
        </div>

        {inspectedCitation && (
          <aside
            aria-label="Citation inspector"
            data-testid="citation-inspector"
            className="cp-drawer w-full shrink-0 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 xl:sticky xl:top-6 xl:w-80"
          >
            <div className="flex items-start justify-between gap-2 border-b border-[#e2e8f0] pb-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-[#475569]">Citation source</p>
                <h2 className="mt-0.5 break-words text-base font-semibold text-[#0f172a]">
                  {inspectedCitation.source.sopTitle}
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close citation inspector"
                onClick={() => setInspectedCitation(null)}
                className={buttonClass("ghost", "icon")}
              >
                <X className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>

            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="text-xs text-[#64748b]">Status</dt>
                <dd className="mt-1">
                  <StatusBadge
                    label={
                      inspectedCitation.status === "ready"
                        ? "ACTIVE"
                        : inspectedCitation.status === "loading"
                          ? "Checking"
                          : "Unavailable"
                    }
                    tone={
                      inspectedCitation.status === "ready"
                        ? "active"
                        : inspectedCitation.status === "loading"
                          ? "processing"
                          : "danger"
                    }
                  />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[#64748b]">Section</dt>
                <dd className="mt-0.5 break-words font-medium text-[#0f172a]">
                  {inspectedCitation.source.section}
                </dd>
              </div>
              {inspectedPageLabel && (
                <div>
                  <dt className="text-xs text-[#64748b]">Location</dt>
                  <dd className="tabular-nums mt-0.5 font-mono text-xs text-[#0f172a]">
                    {inspectedPageLabel}
                  </dd>
                </div>
              )}
              {inspectedCitation.fileName && (
                <div>
                  <dt className="text-xs text-[#64748b]">Original file</dt>
                  <dd className="mt-0.5 break-all font-mono text-xs text-[#475569]">
                    {inspectedCitation.fileName}
                  </dd>
                </div>
              )}
            </dl>

            <div className="mt-4 space-y-3 border-t border-[#e2e8f0] pt-4">
              {inspectedCitation.status === "loading" && (
                <p role="status" className="flex items-center gap-2 text-xs text-[#475569]">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                  <span>{inspectedCitation.statusText}</span>
                </p>
              )}
              {inspectedCitation.status === "error" && (
                <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]">
                  {inspectedCitation.statusText}
                </p>
              )}
              <button
                type="button"
                disabled={inspectedCitation.status === "loading" || openingSource}
                onClick={() => void openInspectedSource()}
                className={buttonClass("primary", "default", "w-full")}
              >
                {openingSource ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                ) : (
                  <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                )}
                <span>Open source</span>
              </button>
            </div>
          </aside>
        )}
      </div>
    </AppShell>
  );
}
