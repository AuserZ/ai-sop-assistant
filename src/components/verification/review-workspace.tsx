"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { accountSchema, buttonClassName, inputClassName, linkClassName } from "@/components/auth/client";
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

type AccessState = "loading" | "anonymous" | "error" | "ADMIN" | "STAFF";
type ReviewTab = "pages" | "chunks" | "history";

const secondaryButtonClassName =
  "inline-flex min-h-11 items-center justify-center rounded border border-[#1f2937] bg-white px-4 py-2 font-medium text-[#111827] hover:bg-[#f3f4f6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111827] disabled:cursor-not-allowed disabled:opacity-60";
const dangerButtonClassName =
  "inline-flex min-h-11 items-center justify-center rounded border border-[#991b1b] bg-[#991b1b] px-4 py-2 font-medium text-white hover:bg-[#7f1d1d] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#991b1b] disabled:cursor-not-allowed disabled:opacity-60";

function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => splitReviewHighlights(text, query), [text, query]);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "search") {
          return (
            <mark key={index} className="rounded bg-[#fde047] px-0.5 text-[#111827]">
              {segment.text}
            </mark>
          );
        }
        if (segment.kind === "quantity") {
          return (
            <mark
              key={index}
              title="Verify numeric value or unit against the original preview"
              className="rounded bg-[#ffedd5] px-0.5 font-semibold text-[#9a3412]"
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

function severityBadgeClass(severity: "info" | "warning" | "error") {
  if (severity === "error") return "bg-[#fee2e2] text-[#991b1b]";
  if (severity === "warning") return "bg-[#fef3c7] text-[#92400e]";
  return "bg-[#dbeafe] text-[#1e40af]";
}

function statusBadgeClass(status: DocumentReviewDto["document"]["status"]) {
  if (status === "ACTIVE") return "bg-[#dcfce7] text-[#166534]";
  if (status === "REJECTED" || status === "FAILED") return "bg-[#fee2e2] text-[#991b1b]";
  if (status === "PENDING_VERIFICATION") return "bg-[#fef3c7] text-[#92400e]";
  return "bg-[#e5e7eb] text-[#1f2937]";
}

export function ReviewWorkspace({ documentId }: { documentId: string }) {
  const [access, setAccess] = useState<AccessState>("loading");
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
          if (!controller.signal.aborted) setAccess("anonymous");
          return;
        }
        const parsed = z.object({ user: accountSchema }).safeParse(await response.json());
        if (!response.ok || !parsed.success) throw new Error("Account unavailable");
        if (controller.signal.aborted) return;
        setAccess(parsed.data.user.role);
        if (parsed.data.user.role === "ADMIN") {
          await loadReview(controller.signal);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof VerificationRequestError) {
          setLoadError(failure.message);
        } else {
          setAccess("error");
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
    if (access !== "ADMIN") return;
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
        if (failure.code === "UNAUTHENTICATED") setAccess("anonymous");
        if (failure.code === "FORBIDDEN") setAccess("STAFF");
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

  if (access === "loading") {
    return (
      <section className="mt-6 min-h-64">
        <p role="status">Checking sign-in...</p>
      </section>
    );
  }
  if (access === "anonymous") {
    return (
      <section className="mt-6 space-y-4">
        <p>Sign in with your Admin account to verify SOPs.</p>
        <Link href="/sign-in" className={linkClassName}>
          Sign in
        </Link>
      </section>
    );
  }
  if (access === "STAFF") {
    return <p className="mt-6">Only Admins can verify SOPs.</p>;
  }
  if (access === "error") {
    return (
      <section className="mt-6 space-y-4">
        <p role="alert">Sign-in status is temporarily unavailable.</p>
        <button
          type="button"
          className={buttonClassName}
          onClick={() => {
            setAccess("loading");
            setRefreshTick((tick) => tick + 1);
          }}
        >
          Retry
        </button>
      </section>
    );
  }
  if (loadError) {
    return (
      <section className="mt-6 space-y-4">
        <p role="alert" className="text-[#991b1b]">
          {loadError}
        </p>
        <button
          type="button"
          className={buttonClassName}
          onClick={() => setRefreshTick((tick) => tick + 1)}
        >
          Retry
        </button>
      </section>
    );
  }
  if (!review) {
    return (
      <section className="mt-6 min-h-64">
        <p role="status">Loading SOP verification workspace...</p>
      </section>
    );
  }

  const { document: doc, pages, chunks, issues, verificationHistory } = review;
  const activePageRecord =
    filteredPages.find((page) => page.pageIndex === selectedPage) ?? filteredPages[0] ?? null;

  return (
    <div className="mt-4 min-w-0 space-y-6" aria-busy={busy}>
      <header className="min-w-0 space-y-2 rounded border border-[#d1d5db] bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">{doc.title}</h1>
          <span
            data-testid="document-status-badge"
            className={`inline-flex rounded px-2.5 py-1 text-xs font-semibold ${statusBadgeClass(doc.status)}`}
          >
            {doc.status}
          </span>
        </div>
        <p className="break-all text-sm text-[#4b5563]">{doc.fileName}</p>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[#4b5563]">
          <div>
            <dt className="inline font-medium">SHA-256: </dt>
            <dd className="inline font-mono">{doc.sha256.slice(0, 16)}…</dd>
          </div>
          {doc.processedPipelineVersion && (
            <div>
              <dt className="inline font-medium">Pipeline: </dt>
              <dd className="inline">{doc.processedPipelineVersion}</dd>
            </div>
          )}
          {doc.verifiedAt && (
            <div>
              <dt className="inline font-medium">Reviewed: </dt>
              <dd className="inline">
                {doc.verifiedByName ?? "Admin"} ({new Date(doc.verifiedAt).toLocaleString()})
              </dd>
            </div>
          )}
        </dl>
      </header>

      {actionNotice && (
        <p role="status" className="rounded border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-sm text-[#166534]">
          {actionNotice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="rounded border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
          {actionError}
        </p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
        <PdfPreview
          previewUrl={doc.previewUrl}
          pageNumber={selectedPage}
          onPageChange={setSelectedPage}
          isDocxDerivative={doc.mimeType !== "application/pdf"}
          fileName={doc.fileName}
        />

        <section aria-label="Extracted content and verification" className="min-w-0 space-y-4 rounded border border-[#d1d5db] bg-white p-4">
          <div className="space-y-2">
            <label htmlFor="review-search" className="block text-sm font-medium">
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
                <span className="text-xs font-medium text-[#4b5563]" aria-live="polite">
                  {searchMatchCount} {searchMatchCount === 1 ? "match" : "matches"}
                </span>
              )}
            </div>
          </div>

          {hasOcrPages && (
            <p className="rounded border border-[#fde68a] bg-[#fffbeb] p-3 text-sm text-[#92400e]">
              OCR confidence is not proof of accuracy. Verify all digits, units, conditions, and tables against the preview.
            </p>
          )}

          {issues.length > 0 && (
            <div className="space-y-2 rounded border border-[#e5e7eb] bg-[#f9fafb] p-3" aria-label="Verification issues">
              <h2 className="text-sm font-semibold">
                Flagged review items ({issues.length})
              </h2>
              <ul className="space-y-2">
                {issues.map((issue) => {
                  const checked = Boolean(issue.resolvedAt) || selectedIssueIds.includes(issue.id);
                  return (
                    <li key={issue.id} className="flex items-start gap-2 text-sm">
                      <input
                        id={`issue-${issue.id}`}
                        type="checkbox"
                        className="mt-1 h-5 w-5 shrink-0"
                        checked={checked}
                        disabled={Boolean(issue.resolvedAt) || doc.status !== "PENDING_VERIFICATION" || busy}
                        onChange={() => toggleIssue(issue.id)}
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${severityBadgeClass(issue.severity)}`}>
                            {issue.severity}
                          </span>
                          <span className="font-mono text-xs">{issue.issueCode}</span>
                          {issue.pageIndex !== null && (
                            <button
                              type="button"
                              className="inline-flex min-h-11 items-center px-2 text-xs font-medium underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111827]"
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
                            <span className="text-xs text-[#166534]">Reviewed</span>
                          )}
                        </div>
                        <label htmlFor={`issue-${issue.id}`} className="block break-words text-xs text-[#374151]">
                          {issue.summary}
                        </label>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div role="tablist" aria-label="Extraction views" className="flex flex-wrap gap-2 border-b border-[#e5e7eb] pb-2">
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
                className={activeTab === tabKey ? buttonClassName : secondaryButtonClassName}
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
                <p className="text-sm text-[#4b5563]">
                  {pages.length === 0 ? "No extracted pages yet." : "No pages match your search query."}
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {filteredPages.map((page) => (
                      <button
                        key={page.id}
                        type="button"
                        className={
                          activePageRecord?.pageIndex === page.pageIndex
                            ? buttonClassName
                            : secondaryButtonClassName
                        }
                        onClick={() => setSelectedPage(page.pageIndex)}
                      >
                        Page {page.pageIndex} ({page.pageKind})
                      </button>
                    ))}
                  </div>
                  {activePageRecord && (
                    <div className="space-y-2 rounded border border-[#e5e7eb] p-3">
                      <div className="flex flex-wrap items-center gap-3 text-xs text-[#4b5563]">
                        <span>Kind: {activePageRecord.pageKind}</span>
                        <span>Location: {activePageRecord.sourceLocationKind}</span>
                        <span>Status: {activePageRecord.verificationStatus}</span>
                        {activePageRecord.ocrConfidence !== null && (
                          <span>OCR avg confidence: {(activePageRecord.ocrConfidence * 100).toFixed(1)}%</span>
                        )}
                        {activePageRecord.ocrModel && <span>Model: {activePageRecord.ocrModel}</span>}
                      </div>
                      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[#f9fafb] p-3 font-mono text-xs leading-relaxed text-[#111827]">
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
                <p className="text-sm text-[#4b5563]">
                  {chunks.length === 0 ? "No chunks indexed yet." : "No chunks match your search query."}
                </p>
              ) : (
                filteredChunks.map((chunk) => (
                  <article key={chunk.id} className="space-y-1.5 rounded border border-[#e5e7eb] p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#4b5563]">
                      <span className="font-semibold text-[#111827]">
                        #{chunk.sequence + 1} · {chunk.sectionPath}
                      </span>
                      <span>
                        {chunk.pageStart !== null
                          ? chunk.pageEnd !== null && chunk.pageEnd !== chunk.pageStart
                            ? `Pages ${chunk.pageStart}–${chunk.pageEnd}`
                            : `Page ${chunk.pageStart}`
                          : "Section-only (DOCX)"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-[#4b5563]">
                      <span>Type: {chunk.contentType}</span>
                      <span>Tokens: ~{chunk.tokenEstimate}</span>
                      <span>Embedding: {chunk.hasEmbedding ? chunk.embeddingModel ?? "ready" : "missing"}</span>
                    </div>
                    <pre className="whitespace-pre-wrap break-words rounded bg-[#f9fafb] p-2 font-mono text-xs text-[#111827]">
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
                <p className="text-sm text-[#4b5563]">No verification decisions recorded yet.</p>
              ) : (
                verificationHistory.map((entry) => (
                  <article key={entry.id} className="space-y-1 rounded border border-[#e5e7eb] p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">
                        {entry.decision} ({entry.beforeStatus} → {entry.afterStatus})
                      </span>
                      <span className="text-xs text-[#4b5563]">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-[#4b5563]">
                      Reviewer: {entry.reviewerName} · Pipeline: {entry.pipelineVersion} · Issues: {entry.issueSummary.total} total ({entry.issueSummary.resolved} resolved)
                    </p>
                    {entry.notes && <p className="break-words text-sm text-[#111827]">{entry.notes}</p>}
                  </article>
                ))
              )}
            </div>
          )}

          <div className="space-y-4 border-t border-[#e5e7eb] pt-4" aria-label="Verification decision">
            {doc.status === "PENDING_VERIFICATION" && (
              <>
                <div className="flex items-start gap-2">
                  <input
                    id="explicit-confirmation"
                    type="checkbox"
                    className="mt-1 h-5 w-5 shrink-0"
                    checked={explicitConfirmation}
                    disabled={busy}
                    onChange={(event) => setExplicitConfirmation(event.target.checked)}
                  />
                  <label htmlFor="explicit-confirmation" className="text-sm font-medium text-[#111827]">
                    I compared the original preview with the extracted text, numbers, units, and tables for this snapshot.
                  </label>
                </div>
                <div className="space-y-1">
                  <label htmlFor="verification-notes" className="block text-sm font-medium">
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
                    className={buttonClassName}
                    disabled={busy || !explicitConfirmation}
                    onClick={() => handleDecision("APPROVE")}
                  >
                    Approve and activate SOP
                  </button>
                  <button
                    type="button"
                    className={dangerButtonClassName}
                    disabled={busy || !explicitConfirmation}
                    onClick={() => handleDecision("REJECT")}
                  >
                    Reject extraction
                  </button>
                  <button
                    type="button"
                    className={secondaryButtonClassName}
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
                <p className="rounded border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
                  Rejected: {doc.rejectionReason}
                </p>
                <button
                  type="button"
                  className={buttonClassName}
                  disabled={busy}
                  onClick={handleReprocess}
                >
                  Reprocess document
                </button>
              </div>
            )}

            {doc.status === "ACTIVE" && (
              <p className="rounded border border-[#bbf7d0] bg-[#f0fdf4] p-3 text-sm text-[#166534]">
                This SOP is verified and ACTIVE for retrieval. ACTIVE originals cannot be mutated in place.
              </p>
            )}

            {(doc.status === "UPLOADED" || doc.status === "PROCESSING" || doc.status === "FAILED") && (
              <div className="space-y-3">
                <p className="text-sm text-[#4b5563]">
                  {doc.status === "FAILED"
                    ? `Processing failed (${doc.processingErrorCode ?? "INGESTION_FAILED"}). Reprocess to generate a fresh snapshot.`
                    : "Processing is underway. This review page will update once extraction finishes."}
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    className={secondaryButtonClassName}
                    disabled={busy}
                    onClick={() => void runAction(loadReview)}
                  >
                    Refresh review
                  </button>
                  {doc.status === "FAILED" && (
                    <button
                      type="button"
                      className={buttonClassName}
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
  );
}
