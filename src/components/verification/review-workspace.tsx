"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { z } from "zod";
import { accountSchema, buttonClassName, inputClassName, type Account } from "@/components/auth/client";
import { AppShell } from "@/components/layout/app-shell";
import { BrandMark, buttonClass, StatusBadge, textLinkClassName } from "@/components/ui/primitives";
import {
  splitReviewHighlights,
  type DocumentReviewDto,
} from "@/server/verification/contracts";
import {
  fetchDocumentReview,
  requestDocumentReprocess,
  submitVerificationDecision,
  VerificationRequestError,
} from "./client";
import { PdfPreview } from "./pdf-preview";

type AccessState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "error" }
  | { kind: "signed-in"; user: Account };
type ReviewTab = "pages" | "chunks" | "history";

function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => splitReviewHighlights(text, query), [text, query]);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "search") {
          return (
            <mark key={index} className="rounded bg-[#fde047] px-0.5 text-[#0f172a]">
              {segment.text}
            </mark>
          );
        }
        if (segment.kind === "quantity") {
          return (
            <mark
              key={index}
              title="Verify numeric value or unit against the original preview"
              className="tabular-nums rounded bg-[#ffedd5] px-0.5 font-semibold text-[#9a3412]"
            >
              {segment.text}
            </mark>
          );
        }
        return <span key={index}>{segment.text}</span>;
      })}
    </>
  );
}

function severityLabel(severity: "info" | "warning" | "error"): string {
  if (severity === "error") return "Error";
  if (severity === "warning") return "Warning";
  return "Info";
}

export function ReviewWorkspace({ documentId }: { documentId: string }) {
  const [access, setAccess] = useState<AccessState>({ kind: "loading" });
  const [review, setReview] = useState<DocumentReviewDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<ReviewTab>("pages");
  const [selectedPage, setSelectedPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const [explicitConfirmation, setExplicitConfirmation] = useState(false);
  const [notes, setNotes] = useState("");
  const [selectedIssueIds, setSelectedIssueIds] = useState<string[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const activeAction = useRef<AbortController | null>(null);

  const loadReview = useCallback(
    async (signal: AbortSignal) => {
      if (!z.uuid().safeParse(documentId).success) {
        throw new VerificationRequestError("NOT_FOUND");
      }
      const loaded = await fetchDocumentReview(documentId, signal);
      if (signal.aborted) return;
      setReview(loaded);
      setLoadError(null);
      setSelectedIssueIds((current) => {
        const validIds = new Set(loaded.issues.filter((issue) => !issue.resolvedAt).map((issue) => issue.id));
        return current.filter((id) => validIds.has(id));
      });
    },
    [documentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/account", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.status === 401) {
          if (!controller.signal.aborted) setAccess({ kind: "anonymous" });
          return;
        }
        const parsed = z.object({ user: accountSchema }).safeParse(await response.json());
        if (!response.ok || !parsed.success) throw new Error("Account unavailable");
        if (controller.signal.aborted) return;
        setAccess({ kind: "signed-in", user: parsed.data.user });
        if (parsed.data.user.role === "ADMIN") {
          await loadReview(controller.signal);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof VerificationRequestError) {
          setLoadError(failure.message);
        } else {
          setAccess({ kind: "error" });
        }
      }
    })();
    return () => {
      controller.abort();
      activeAction.current?.abort();
    };
  }, [loadReview, refreshTick]);

  const currentStatus = review?.document.status;
  useEffect(() => {
    if (access.kind !== "signed-in" || access.user.role !== "ADMIN") return;
    if (currentStatus !== "UPLOADED" && currentStatus !== "PROCESSING") return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void loadReview(controller.signal).catch(() => undefined);
    }, 2000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [access, currentStatus, loadReview]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredPages = useMemo(() => {
    if (!review) return [];
    if (!normalizedSearch) return review.pages;
    return review.pages.filter((page) => page.normalizedText.toLowerCase().includes(normalizedSearch));
  }, [review, normalizedSearch]);

  const filteredChunks = useMemo(() => {
    if (!review) return [];
    if (!normalizedSearch) return review.chunks;
    return review.chunks.filter(
      (chunk) =>
        chunk.text.toLowerCase().includes(normalizedSearch) ||
        chunk.sectionPath.toLowerCase().includes(normalizedSearch),
    );
  }, [review, normalizedSearch]);

  const searchMatchCount = useMemo(() => {
    if (!review || !normalizedSearch) return 0;
    let total = 0;
    const countMatches = (haystack: string) => {
      const lower = haystack.toLowerCase();
      let offset = 0;
      while (offset < lower.length) {
        const idx = lower.indexOf(normalizedSearch, offset);
        if (idx === -1) break;
        total++;
        offset = idx + normalizedSearch.length;
      }
    };
    for (const page of review.pages) countMatches(page.normalizedText);
    return total;
  }, [review, normalizedSearch]);

  const hasOcrPages = useMemo(
    () => Boolean(review?.pages.some((page) => page.pageKind === "scanned_ocr" || page.pageKind === "mixed_ocr")),
    [review],
  );

  async function runAction(work: (signal: AbortSignal) => Promise<void>) {
    if (activeAction.current) return;
    const controller = new AbortController();
    activeAction.current = controller;
    setBusy(true);
    setActionError(null);
    setActionNotice(null);
    try {
      await work(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return;
      if (failure instanceof VerificationRequestError) {
        setActionError(failure.message);
        if (failure.code === "UNAUTHENTICATED") setAccess({ kind: "anonymous" });
        if (failure.code === "FORBIDDEN") {
          setAccess((current) =>
            current.kind === "signed-in"
              ? { kind: "signed-in", user: { ...current.user, role: "STAFF" } }
              : current,
          );
        }
      } else {
        setActionError("Verification request failed. Refresh and try again.");
      }
    } finally {
      if (activeAction.current === controller) {
        activeAction.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }

  function toggleIssue(issueId: string) {
    setSelectedIssueIds((current) =>
      current.includes(issueId) ? current.filter((entry) => entry !== issueId) : [...current, issueId],
    );
  }

  function handleDecision(decision: "APPROVE" | "REJECT") {
    if (!review) return;
    if (!explicitConfirmation) {
      setActionError("Check the explicit confirmation box before submitting a verification decision.");
      return;
    }
    if (decision === "REJECT" && !notes.trim()) {
      setActionError("Enter a rejection reason before rejecting this extraction.");
      return;
    }
    if (
      !review.document.processedJobId ||
      !review.document.processedPipelineVersion ||
      !review.document.processedAttemptId
    ) {
      setActionError("This document does not have a completed processing snapshot to verify.");
      return;
    }
    const payload = {
      decision,
      expectedSha256: review.document.sha256,
      expectedJobId: review.document.processedJobId,
      expectedPipelineVersion: review.document.processedPipelineVersion,
      expectedAttemptId: review.document.processedAttemptId,
      explicitConfirmation: true as const,
      notes: notes.trim() || undefined,
      resolvedIssueIds: selectedIssueIds.length > 0 ? selectedIssueIds : undefined,
    };
    void runAction(async (signal) => {
      const updated = await submitVerificationDecision(review.document.id, payload, signal);
      if (signal.aborted) return;
      setReview(updated);
      setExplicitConfirmation(false);
      setNotes("");
      setSelectedIssueIds([]);
      setActionNotice(
        decision === "APPROVE"
          ? "SOP verified and activated for retrieval."
          : "Extraction rejected and recorded in verification history.",
      );
    });
  }

  function handleReprocess() {
    if (!review) return;
    void runAction(async (signal) => {
      const updated = await requestDocumentReprocess(
        review.document.id,
        { expectedSha256: review.document.sha256, notes: notes.trim() || undefined },
        signal,
      );
      if (signal.aborted) return;
      setReview(updated);
      setExplicitConfirmation(false);
      setNotes("");
      setSelectedIssueIds([]);
      setActionNotice("Document queued for reprocessing. Renewed verification will be required.");
    });
  }

  if (access.kind !== "signed-in") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4 py-10 sm:px-6">
        <div className="rounded-[var(--radius-lg)] border border-[#e2e8f0] border-t-2 border-t-[#1d4ed8] bg-white p-6 shadow-[var(--shadow-elevated)]">
          <BrandMark />
          <h1 className="mt-5 text-2xl font-semibold text-[#0f172a]">Verify SOP</h1>
          {access.kind === "loading" && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-[#475569]">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              <span>Checking sign-in...</span>
            </p>
          )}
          {access.kind === "anonymous" && (
            <div className="mt-4 space-y-4">
              <p className="text-sm text-[#475569]">
                Sign in with your Admin account to verify SOPs.
              </p>
              <Link href="/sign-in" className={buttonClass("primary", "default", "w-full")}>
                Sign in
              </Link>
            </div>
          )}
          {access.kind === "error" && (
            <div className="mt-4 space-y-4">
              <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                Sign-in status is temporarily unavailable.
              </p>
              <button
                type="button"
                className={buttonClassName}
                onClick={() => {
                  setAccess({ kind: "loading" });
                  setRefreshTick((tick) => tick + 1);
                }}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      </main>
    );
  }

  if (access.user.role !== "ADMIN") {
    return (
      <AppShell
        user={access.user}
        activeMenu="documents"
        onSignedOut={() => setAccess({ kind: "anonymous" })}
      >
        <div className="space-y-4">
          <Link href="/documents" className={textLinkClassName}>
            <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>Back to List Document SOP</span>
          </Link>
          <div className="rounded-[var(--radius-lg)] border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]">
            <p>Only Admins can verify SOPs.</p>
          </div>
        </div>
      </AppShell>
    );
  }

  if (loadError) {
    return (
      <AppShell
        user={access.user}
        activeMenu="documents"
        onSignedOut={() => setAccess({ kind: "anonymous" })}
      >
        <div className="space-y-4">
          <Link href="/documents" className={textLinkClassName}>
            <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>Back to List Document SOP</span>
          </Link>
          <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-4 text-sm text-[#991b1b]">
            {loadError}
          </p>
          <button
            type="button"
            className={buttonClass("primary")}
            onClick={() => setRefreshTick((tick) => tick + 1)}
          >
            Retry
          </button>
        </div>
      </AppShell>
    );
  }

  if (!review) {
    return (
      <AppShell
        user={access.user}
        activeMenu="documents"
        onSignedOut={() => setAccess({ kind: "anonymous" })}
      >
        <div className="space-y-4">
          <Link href="/documents" className={textLinkClassName}>
            <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>Back to List Document SOP</span>
          </Link>
          <p role="status" className="flex items-center gap-2 text-sm text-[#475569]">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
            <span>Loading SOP verification workspace...</span>
          </p>
        </div>
      </AppShell>
    );
  }

  const { document: doc, pages, chunks, issues, verificationHistory } = review;
  const activePageRecord =
    filteredPages.find((page) => page.pageIndex === selectedPage) ?? filteredPages[0] ?? null;

  return (
    <AppShell
      user={access.user}
      activeMenu="documents"
      onSignedOut={() => setAccess({ kind: "anonymous" })}
      mainClassName="mx-auto w-full min-w-0 max-w-7xl flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8"
    >
      <div className="min-w-0 space-y-6" aria-busy={busy}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/documents" className={textLinkClassName}>
            <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>Back to List Document SOP</span>
          </Link>
        </div>

        <header className="min-w-0 space-y-2 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 shadow-[var(--shadow-surface)] sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="min-w-0 break-words text-xl font-semibold text-[#0f172a] sm:text-2xl">
              {doc.title}
            </h1>
            <StatusBadge label={doc.status} testId="document-status-badge" />
          </div>
          <p className="break-all font-mono text-xs text-[#475569]">{doc.fileName}</p>
          <dl className="tabular-nums flex flex-wrap gap-x-6 gap-y-1 text-xs text-[#475569]">
            <div>
              <dt className="inline font-medium text-[#0f172a]">SHA-256: </dt>
              <dd className="inline font-mono">{doc.sha256.slice(0, 16)}…</dd>
            </div>
            {doc.processedPipelineVersion && (
              <div>
                <dt className="inline font-medium text-[#0f172a]">Pipeline: </dt>
                <dd className="inline font-mono">{doc.processedPipelineVersion}</dd>
              </div>
            )}
            {doc.verifiedAt && (
              <div>
                <dt className="inline font-medium text-[#0f172a]">Reviewed: </dt>
                <dd className="inline">
                  {doc.verifiedByName ?? "Admin"} ({new Date(doc.verifiedAt).toLocaleString()})
                </dd>
              </div>
            )}
          </dl>
        </header>

        {actionNotice && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#a7f3d0] bg-[#ecfdf5] p-3 text-sm text-[#065f46]"
          >
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>{actionNotice}</span>
          </div>
        )}
        {actionError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>{actionError}</span>
          </div>
        )}

        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
          <PdfPreview
            previewUrl={doc.previewUrl}
            pageNumber={selectedPage}
            onPageChange={setSelectedPage}
            isDocxDerivative={doc.mimeType !== "application/pdf"}
            fileName={doc.fileName}
          />

          <section
            aria-label="Extracted content and verification"
            className="min-w-0 space-y-5 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 shadow-[var(--shadow-surface)]"
          >
            <div className="space-y-1.5">
              <label htmlFor="review-search" className="block text-sm font-medium text-[#0f172a]">
                Search extracted text
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="review-search"
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search steps, numbers, units, sections..."
                  className={`${inputClassName} min-w-0 flex-1`}
                />
                {searchQuery.trim() && (
                  <span className="tabular-nums font-mono text-xs font-medium text-[#475569]" aria-live="polite">
                    {searchMatchCount} {searchMatchCount === 1 ? "match" : "matches"}
                  </span>
                )}
              </div>
            </div>

            {hasOcrPages && (
              <div className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fde68a] bg-[#fffbeb] p-3 text-sm text-[#92400e]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                <p>
                  OCR confidence is not proof of accuracy. Verify all digits, units, conditions, and tables against the preview.
                </p>
              </div>
            )}

            {issues.length > 0 && (
              <div
                className="space-y-3 rounded-[var(--radius-md)] border border-[#e2e8f0] bg-[#f8fafc] p-4"
                aria-label="Verification issues"
              >
                <h2 className="tabular-nums text-sm font-semibold text-[#0f172a]">
                  Flagged review items ({issues.length})
                </h2>
                <ul className="space-y-2.5">
                  {issues.map((issue) => {
                    const checked = Boolean(issue.resolvedAt) || selectedIssueIds.includes(issue.id);
                    return (
                      <li key={issue.id} className="flex items-start gap-2.5 text-sm">
                        <input
                          id={`issue-${issue.id}`}
                          type="checkbox"
                          className="mt-1 h-5 w-5 shrink-0 accent-[#1d4ed8]"
                          checked={checked}
                          disabled={Boolean(issue.resolvedAt) || doc.status !== "PENDING_VERIFICATION" || busy}
                          onChange={() => toggleIssue(issue.id)}
                        />
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge
                              label={severityLabel(issue.severity)}
                              tone={
                                issue.severity === "error"
                                  ? "danger"
                                  : issue.severity === "warning"
                                    ? "pending"
                                    : "processing"
                              }
                            />
                            <span className="font-mono text-xs text-[#475569]">{issue.issueCode}</span>
                            {issue.pageIndex !== null && (
                              <button
                                type="button"
                                className="cp-instant inline-flex min-h-11 cursor-pointer items-center px-2 font-mono text-xs font-medium text-[#1d4ed8] underline underline-offset-4 hover:text-[#1e40af] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1d4ed8]"
                                onClick={() => {
                                  setSearchQuery("");
                                  setSelectedPage(issue.pageIndex!);
                                  setActiveTab("pages");
                                }}
                              >
                                Page {issue.pageIndex}
                              </button>
                            )}
                            {issue.resolvedAt && (
                              <StatusBadge label="Reviewed" tone="active" />
                            )}
                          </div>
                          <label htmlFor={`issue-${issue.id}`} className="block break-words text-xs text-[#475569]">
                            {issue.summary}
                          </label>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div
              role="tablist"
              aria-label="Extraction views"
              className="flex flex-wrap gap-2 border-b border-[#e2e8f0] pb-3"
            >
              {(
                [
                  ["pages", `Extracted pages (${pages.length})`],
                  ["chunks", `Chunks (${chunks.length})`],
                  ["history", `Audit history (${verificationHistory.length})`],
                ] as const
              ).map(([tabKey, label]) => (
                <button
                  key={tabKey}
                  id={`review-tab-${tabKey}`}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tabKey}
                  aria-controls={`review-tabpanel-${tabKey}`}
                  className={`cp-instant tabular-nums ${buttonClass(
                    activeTab === tabKey ? "primary" : "secondary",
                    "sm",
                  )}`}
                  onClick={() => setActiveTab(tabKey)}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab === "pages" && (
              <div
                id="review-tabpanel-pages"
                className="space-y-3"
                role="tabpanel"
                aria-labelledby="review-tab-pages"
              >
                {filteredPages.length === 0 ? (
                  <p className="text-sm text-[#475569]">
                    {pages.length === 0 ? "No extracted pages yet." : "No pages match your search query."}
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {filteredPages.map((page) => (
                        <button
                          key={page.id}
                          type="button"
                          className={`cp-instant tabular-nums ${buttonClass(
                            activePageRecord?.pageIndex === page.pageIndex ? "primary" : "secondary",
                            "sm",
                          )}`}
                          onClick={() => setSelectedPage(page.pageIndex)}
                        >
                          Page {page.pageIndex} ({page.pageKind})
                        </button>
                      ))}
                    </div>
                    {activePageRecord && (
                      <div className="space-y-2 rounded-[var(--radius-md)] border border-[#e2e8f0] p-3">
                        <div className="tabular-nums flex flex-wrap items-center gap-3 text-xs text-[#475569]">
                          <span>Kind: {activePageRecord.pageKind}</span>
                          <span>Location: {activePageRecord.sourceLocationKind}</span>
                          <span>Status: {activePageRecord.verificationStatus}</span>
                          {activePageRecord.ocrConfidence !== null && (
                            <span className="font-mono">
                              OCR avg confidence: {(activePageRecord.ocrConfidence * 100).toFixed(1)}%
                            </span>
                          )}
                          {activePageRecord.ocrModel && <span>Model: {activePageRecord.ocrModel}</span>}
                        </div>
                        <pre className="tabular-nums max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[#f8fafc] p-3 font-mono text-xs leading-relaxed text-[#0f172a]">
                          {activePageRecord.normalizedText ? (
                            <HighlightedText text={activePageRecord.normalizedText} query={searchQuery} />
                          ) : (
                            "(Blank page — no text extracted)"
                          )}
                        </pre>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeTab === "chunks" && (
              <div
                id="review-tabpanel-chunks"
                className="max-h-96 space-y-3 overflow-auto"
                role="tabpanel"
                aria-labelledby="review-tab-chunks"
              >
                {filteredChunks.length === 0 ? (
                  <p className="text-sm text-[#475569]">
                    {chunks.length === 0 ? "No chunks indexed yet." : "No chunks match your search query."}
                  </p>
                ) : (
                  filteredChunks.map((chunk) => (
                    <article
                      key={chunk.id}
                      className="space-y-1.5 rounded-[var(--radius-md)] border border-[#e2e8f0] p-3"
                    >
                      <div className="tabular-nums flex flex-wrap items-center justify-between gap-2 text-xs text-[#475569]">
                        <span className="font-semibold text-[#0f172a]">
                          #{chunk.sequence + 1} · {chunk.sectionPath}
                        </span>
                        <span className="font-mono">
                          {chunk.pageStart !== null
                            ? chunk.pageEnd !== null && chunk.pageEnd !== chunk.pageStart
                              ? `Pages ${chunk.pageStart}–${chunk.pageEnd}`
                              : `Page ${chunk.pageStart}`
                            : "Section-only (DOCX)"}
                        </span>
                      </div>
                      <div className="tabular-nums flex flex-wrap gap-3 text-xs text-[#475569]">
                        <span>Type: {chunk.contentType}</span>
                        <span>Tokens: ~{chunk.tokenEstimate}</span>
                        <span>Embedding: {chunk.hasEmbedding ? chunk.embeddingModel ?? "ready" : "missing"}</span>
                      </div>
                      <pre className="tabular-nums whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[#f8fafc] p-2.5 font-mono text-xs text-[#0f172a]">
                        <HighlightedText text={chunk.text} query={searchQuery} />
                      </pre>
                    </article>
                  ))
                )}
              </div>
            )}

            {activeTab === "history" && (
              <div
                id="review-tabpanel-history"
                className="space-y-3"
                role="tabpanel"
                aria-labelledby="review-tab-history"
              >
                {verificationHistory.length === 0 ? (
                  <p className="text-sm text-[#475569]">No verification decisions recorded yet.</p>
                ) : (
                  verificationHistory.map((entry) => (
                    <article
                      key={entry.id}
                      className="space-y-1.5 rounded-[var(--radius-md)] border border-[#e2e8f0] p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-[#0f172a]">
                          {entry.decision} ({entry.beforeStatus} → {entry.afterStatus})
                        </span>
                        <span className="tabular-nums font-mono text-xs text-[#64748b]">
                          {new Date(entry.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="tabular-nums text-xs text-[#475569]">
                        Reviewer: {entry.reviewerName} · Pipeline: {entry.pipelineVersion} · Issues:{" "}
                        {entry.issueSummary.total} total ({entry.issueSummary.resolved} resolved)
                      </p>
                      {entry.notes && <p className="break-words text-sm text-[#0f172a]">{entry.notes}</p>}
                    </article>
                  ))
                )}
              </div>
            )}

            <div className="space-y-4 border-t border-[#e2e8f0] pt-4" aria-label="Verification decision">
              {doc.status === "PENDING_VERIFICATION" && (
                <>
                  <div className="flex items-start gap-2.5">
                    <input
                      id="explicit-confirmation"
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0 accent-[#1d4ed8]"
                      checked={explicitConfirmation}
                      disabled={busy}
                      onChange={(event) => setExplicitConfirmation(event.target.checked)}
                    />
                    <label htmlFor="explicit-confirmation" className="text-sm font-medium text-[#0f172a]">
                      I compared the original preview with the extracted text, numbers, units, and tables for this snapshot.
                    </label>
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="verification-notes" className="block text-sm font-medium text-[#0f172a]">
                      Verification notes (required to reject)
                    </label>
                    <textarea
                      id="verification-notes"
                      rows={3}
                      maxLength={2000}
                      disabled={busy}
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      className={`${inputClassName} min-h-20`}
                      placeholder="Record verification remarks or explain why this extraction must be rejected..."
                    />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={buttonClass("primary")}
                      disabled={busy || !explicitConfirmation}
                      onClick={() => handleDecision("APPROVE")}
                    >
                      Approve and activate SOP
                    </button>
                    <button
                      type="button"
                      className={buttonClass("destructive")}
                      disabled={busy || !explicitConfirmation}
                      onClick={() => handleDecision("REJECT")}
                    >
                      Reject extraction
                    </button>
                    <button
                      type="button"
                      className={buttonClass("secondary")}
                      disabled={busy}
                      onClick={handleReprocess}
                    >
                      Reprocess document
                    </button>
                  </div>
                </>
              )}

              {doc.status === "REJECTED" && (
                <div className="space-y-3">
                  <p className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                    Rejected: {doc.rejectionReason}
                  </p>
                  <button
                    type="button"
                    className={buttonClass("primary")}
                    disabled={busy}
                    onClick={handleReprocess}
                  >
                    Reprocess document
                  </button>
                </div>
              )}

              {doc.status === "ACTIVE" && (
                <p className="rounded-[var(--radius-md)] border border-[#a7f3d0] bg-[#ecfdf5] p-3 text-sm text-[#065f46]">
                  This SOP is verified and ACTIVE for retrieval. ACTIVE originals cannot be mutated in place.
                </p>
              )}

              {doc.status === "DELETED" && (
                <p className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                  This SOP document has been deleted and is excluded from retrieval, verification, and source access.
                </p>
              )}

              {(doc.status === "UPLOADED" || doc.status === "PROCESSING" || doc.status === "FAILED") && (
                <div className="space-y-3">
                  <p className="text-sm text-[#475569]">
                    {doc.status === "FAILED"
                      ? `Processing failed (${doc.processingErrorCode ?? "INGESTION_FAILED"}). Reprocess to generate a fresh snapshot.`
                      : "Processing is underway. This review page will update once extraction finishes."}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      className={buttonClass("secondary")}
                      disabled={busy}
                      onClick={() => void runAction(loadReview)}
                    >
                      <RefreshCw className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span>Refresh review</span>
                    </button>
                    {doc.status === "FAILED" && (
                      <button
                        type="button"
                        className={buttonClass("primary")}
                        disabled={busy}
                        onClick={handleReprocess}
                      >
                        Reprocess document
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
