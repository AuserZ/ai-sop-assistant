"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  Check,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import { buttonClass } from "@/components/ui/primitives";
import type { ConversationSummary } from "./client";

const maximumTitleChars = 120;

export type ConversationHistoryPanelProps = {
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchSubmit: (value: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onNewChat: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRenameConversation: (conversationId: string, nextTitle: string) => Promise<void>;
  onArchiveConversation: (conversationId: string) => Promise<void>;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  desktopOpen: boolean;
};

function formatConversationTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

type HistoryListContentProps = {
  idPrefix: string;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchSubmit: (value: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onNewChat: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRenameConversation: (conversationId: string, nextTitle: string) => Promise<void>;
  onArchiveConversation: (conversationId: string) => Promise<void>;
  onClose?: () => void;
};

function HistoryListContent({
  idPrefix,
  conversations,
  activeConversationId,
  loading,
  loadingMore,
  hasMore,
  error,
  searchQuery,
  onSearchQueryChange,
  onSearchSubmit,
  onSelectConversation,
  onNewChat,
  onLoadMore,
  onRetry,
  onRenameConversation,
  onArchiveConversation,
  onClose,
}: HistoryListContentProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [archivingConfirmId, setArchivingConfirmId] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  function startRename(conversation: ConversationSummary) {
    setArchivingConfirmId(null);
    setMutationError(null);
    setStatusNotice(null);
    setEditingId(conversation.id);
    setEditingTitle(conversation.title);
  }

  function cancelRename() {
    setEditingId(null);
    setEditingTitle("");
    setMutationError(null);
  }

  async function commitRename(conversationId: string) {
    const trimmed = editingTitle.trim();
    if (!trimmed) {
      setMutationError("Conversation title cannot be empty.");
      return;
    }
    setMutatingId(conversationId);
    setMutationError(null);
    try {
      await onRenameConversation(conversationId, trimmed);
      setEditingId(null);
      setEditingTitle("");
      setStatusNotice("Conversation renamed.");
    } catch (failure) {
      setMutationError(
        failure instanceof Error ? failure.message : "Could not rename this conversation.",
      );
    } finally {
      setMutatingId(null);
    }
  }

  async function commitArchive(conversationId: string) {
    setMutatingId(conversationId);
    setMutationError(null);
    setStatusNotice(null);
    try {
      await onArchiveConversation(conversationId);
      setArchivingConfirmId(null);
      setStatusNotice("Conversation archived.");
    } catch (failure) {
      setMutationError(
        failure instanceof Error ? failure.message : "Could not archive this conversation.",
      );
    } finally {
      setMutatingId(null);
    }
  }

  const searchInputId = `${idPrefix}-conversation-search`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[#e2e8f0] px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MessageSquare className="h-4 w-4 shrink-0 text-[#475569]" strokeWidth={1.5} aria-hidden="true" />
          <h2 className="truncate text-sm font-semibold text-[#0f172a]">Conversations</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              onNewChat();
              onClose?.();
            }}
            aria-label="Start new conversation"
            className={buttonClass("secondary", "icon")}
          >
            <Plus className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close conversation history"
              className={buttonClass("ghost", "icon")}
            >
              <X className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSearchSubmit(searchQuery);
        }}
        className="border-b border-[#e2e8f0] p-3"
      >
        <label htmlFor={searchInputId} className="sr-only">
          Search conversations
        </label>
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-[#64748b]"
              strokeWidth={1.5}
              aria-hidden="true"
            />
            <input
              id={searchInputId}
              type="search"
              maxLength={100}
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder="Search conversations"
              className="cp-control min-h-11 w-full rounded-[var(--radius-md)] border border-[#cbd5e1] bg-white pr-3 pl-8 text-sm text-[#0f172a] placeholder:text-[#64748b] focus-visible:border-[#1d4ed8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
            />
          </div>
          {searchQuery.trim().length > 0 && (
            <button
              type="button"
              aria-label="Clear conversation search"
              onClick={() => {
                onSearchQueryChange("");
                onSearchSubmit("");
              }}
              className={buttonClass("ghost", "icon")}
            >
              <X className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>

      {statusNotice && (
        <p role="status" aria-live="polite" className="border-b border-[#a7f3d0] bg-[#ecfdf5] px-3 py-2 text-xs text-[#065f46]">
          {statusNotice}
        </p>
      )}

      {mutationError && (
        <div role="alert" className="border-b border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-xs text-[#991b1b]">
          {mutationError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && conversations.length === 0 && (
          <p role="status" className="flex items-center gap-2 px-2 py-4 text-xs text-[#475569]">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
            <span>Loading conversations...</span>
          </p>
        )}

        {error && (
          <div
            role="alert"
            className="space-y-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]"
          >
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              onClick={onRetry}
              className={buttonClass(
                "secondary",
                "default",
                "w-full border-[#fecaca] text-[#991b1b] hover:bg-[#fee2e2]",
              )}
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && conversations.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-[#64748b]">
            {searchQuery.trim().length > 0
              ? "No conversations match your search."
              : "Your saved conversations will appear here."}
          </p>
        )}

        {conversations.length > 0 && (
          <ul className="space-y-1.5" data-testid="conversation-list">
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeConversationId;
              const isEditing = editingId === conversation.id;
              const isConfirmingArchive = archivingConfirmId === conversation.id;
              const isMutating = mutatingId === conversation.id;
              const timestampLabel = formatConversationTimestamp(conversation.updatedAt);

              if (isEditing) {
                return (
                  <li
                    key={conversation.id}
                    data-testid={`conversation-edit-${conversation.id}`}
                    className="rounded-[var(--radius-md)] border border-[#bfdbfe] bg-[#eff6ff] p-2"
                  >
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void commitRename(conversation.id);
                      }}
                      className="space-y-2"
                    >
                      <label htmlFor={`${idPrefix}-rename-${conversation.id}`} className="sr-only">
                        Rename conversation
                      </label>
                      <input
                        ref={editInputRef}
                        id={`${idPrefix}-rename-${conversation.id}`}
                        type="text"
                        maxLength={maximumTitleChars}
                        disabled={isMutating}
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelRename();
                          }
                        }}
                        className="cp-control min-h-11 w-full rounded-[var(--radius-sm)] border border-[#cbd5e1] bg-white px-2.5 py-2 text-sm text-[#0f172a] focus-visible:border-[#1d4ed8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
                      />
                      <div className="flex items-center gap-1.5">
                        <button
                          type="submit"
                          disabled={isMutating || editingTitle.trim().length === 0}
                          className={buttonClass("primary", "default", "flex-1")}
                        >
                          {isMutating ? (
                            <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                          ) : (
                            <Check className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                          )}
                          <span>Save</span>
                        </button>
                        <button
                          type="button"
                          disabled={isMutating}
                          onClick={cancelRename}
                          className={buttonClass("secondary", "default", "flex-1")}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  </li>
                );
              }

              if (isConfirmingArchive) {
                return (
                  <li
                    key={conversation.id}
                    data-testid={`conversation-archive-confirm-${conversation.id}`}
                    className="space-y-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-2.5"
                  >
                    <p className="break-words text-xs font-medium text-[#991b1b]">
                      Archive &ldquo;{conversation.title}&rdquo;? It will be removed from your history list.
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={isMutating}
                        onClick={() => void commitArchive(conversation.id)}
                        className={buttonClass("destructive", "default", "flex-1")}
                      >
                        {isMutating ? (
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
                        ) : (
                          <Archive className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                        )}
                        <span>Archive</span>
                      </button>
                      <button
                        type="button"
                        disabled={isMutating}
                        onClick={() => setArchivingConfirmId(null)}
                        className={buttonClass("secondary", "default", "flex-1")}
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                );
              }

              return (
                <li
                  key={conversation.id}
                  data-conversation-row={conversation.id}
                  className={`rounded-[var(--radius-md)] border ${
                    isActive
                      ? "border-[#bfdbfe] bg-[#eff6ff]"
                      : "border-transparent hover:border-[#e2e8f0] hover:bg-[#f8fafc]"
                  }`}
                >
                  <div className="flex items-start gap-1">
                    <button
                      type="button"
                      data-testid={`conversation-item-${conversation.id}`}
                      data-conversation-item={conversation.id}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => {
                        onSelectConversation(conversation.id);
                        onClose?.();
                      }}
                      className="cp-instant min-h-11 min-w-0 flex-1 cursor-pointer rounded-[var(--radius-md)] px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
                    >
                      <span
                        className={`block truncate text-sm ${
                          isActive ? "font-semibold text-[#1d4ed8]" : "font-medium text-[#0f172a]"
                        }`}
                      >
                        {conversation.title}
                      </span>
                      {timestampLabel && (
                        <span className="tabular-nums mt-0.5 block font-mono text-[11px] text-[#64748b]">
                          {timestampLabel}
                        </span>
                      )}
                    </button>
                    <div className="flex shrink-0 items-center pt-0.5 pr-0.5">
                      <button
                        type="button"
                        aria-label={`Rename ${conversation.title}`}
                        data-testid={`conversation-rename-btn-${conversation.id}`}
                        onClick={() => startRename(conversation)}
                        className={buttonClass("ghost", "icon")}
                      >
                        <Pencil className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Archive ${conversation.title}`}
                        data-testid={`conversation-archive-btn-${conversation.id}`}
                        onClick={() => {
                          setEditingId(null);
                          setMutationError(null);
                          setStatusNotice(null);
                          setArchivingConfirmId(conversation.id);
                        }}
                        className={buttonClass("ghost", "icon", "hover:text-[#991b1b]")}
                      >
                        <Archive className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {hasMore && (
          <div className="mt-2 pt-2 border-t border-[#e2e8f0]">
            <button
              type="button"
              disabled={loadingMore}
              onClick={onLoadMore}
              data-testid="conversation-load-more"
              className={buttonClass("secondary", "default", "w-full")}
            >
              {loadingMore && (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              )}
              <span>{loadingMore ? "Loading..." : "Load more"}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConversationHistoryPanel(props: ConversationHistoryPanelProps) {
  const { mobileOpen, onCloseMobile, desktopOpen } = props;
  const mobileDrawerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mobileOpen) return;
    mobileDrawerRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        onCloseMobile();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      {desktopOpen && (
        <aside
          aria-label="Conversation history"
          data-testid="conversation-history-panel"
          className="hidden lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100vh-8rem)] lg:w-64 lg:shrink-0 lg:flex-col lg:rounded-[var(--radius-lg)] lg:border lg:border-[#e2e8f0] lg:bg-white lg:shadow-[var(--shadow-surface)]"
        >
          <HistoryListContent idPrefix="desktop" {...props} />
        </aside>
      )}

      {mobileOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Conversation history"
          data-testid="conversation-history-drawer"
          className="fixed inset-0 z-40 flex lg:hidden"
        >
          <div
            aria-hidden="true"
            onClick={onCloseMobile}
            className="fixed inset-0 bg-[#0f172a]/35 backdrop-blur-[1px]"
          />
          <div
            ref={mobileDrawerRef}
            tabIndex={-1}
            className="cp-drawer relative z-10 flex h-full w-[min(19rem,calc(100vw-2rem))] max-w-full flex-col border-r border-[#e2e8f0] bg-white shadow-[var(--shadow-elevated)] outline-none"
          >
            <HistoryListContent idPrefix="mobile" {...props} onClose={onCloseMobile} />
          </div>
        </div>
      )}
    </>
  );
}
