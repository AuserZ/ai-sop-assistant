"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type {
  DocumentLibraryItemDto,
  DocumentLibraryResponse,
  DocumentSourceContextDto,
} from "@/server/documents/contracts";
import { buttonClassName, inputClassName } from "@/components/auth/client";
import {
  DocumentRequestError,
  listLibraryDocuments,
  processingErrorCodeMessage,
  requestDocumentSource,
} from "./client";

type LibraryPanelProps = {
  role: "ADMIN" | "STAFF";
  initialData: DocumentLibraryResponse | null;
  initialError: string | null;
  refreshSignal: number;
};

type ActiveSourceSummary = {
  documentId: string;
  title: string;
  fileName: string;
  mimeType: string;
  disposition: "inline" | "attachment";
  byteLength: number;
  expiresAt: string;
  ttlSeconds: number;
  context: DocumentSourceContextDto;
};

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function readUrlContext(): DocumentSourceContextDto {
  if (typeof window === "undefined") return { page: null, section: null };
  const params = new URLSearchParams(window.location.search);
  const rawPage = params.get("page");
  const parsedPage = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : null;
  const page = parsedPage && parsedPage >= 1 && parsedPage <= 5000 ? parsedPage : null;
  const rawSection = params.get("section")?.trim() ?? "";
  const section =
    rawSection.length >= 1 && rawSection.length <= 200 && !/[\u0000-\u001f\u007f]/.test(rawSection)
      ? rawSection
      : null;
  return { page, section };
}

export function LibraryPanel({
  role,
  initialData,
  initialError,
  refreshSignal,
}: LibraryPanelProps) {
  const [searchInput, setSearchInput] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [items, setItems] = useState<DocumentLibraryItemDto[]>(initialData?.items ?? []);
  const [nextCursor, setNextCursor] = useState<string | null>(initialData?.nextCursor ?? null);
  const [loading, setLoading] = useState(initialData === null && initialError === null);
  const [error, setError] = useState<string | null>(initialError);
  const [sourceBusyId, setSourceBusyId] = useState<string | null>(null);
  const [sourcePhase, setSourcePhase] = useState<string | null>(null);
  const [activeSource, setActiveSource] = useState<ActiveSourceSummary | null>(null);
  const [urlContext] = useState<DocumentSourceContextDto>(() => readUrlContext());
  const listController = useRef<AbortController | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const lastRefreshSignal = useRef(refreshSignal);

  async function fetchLibrary(
    queryText: string,
    cursor?: string,
    append = false,
  ) {
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await listLibraryDocuments(
        { q: queryText, cursor },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setItems((previous) => (append ? [...previous, ...response.items] : response.items));
      setNextCursor(response.nextCursor);
      setAppliedQuery(queryText.trim());
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(
        failure instanceof DocumentRequestError
          ? failure.message
          : "The SOP library is temporarily unavailable. Try again.",
      );
    } finally {
      if (listController.current === controller && !controller.signal.aborted) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    if (refreshSignal !== lastRefreshSignal.current) {
      lastRefreshSignal.current = refreshSignal;
      void fetchLibrary(appliedQuery);
    }
  });

  useEffect(() => {
    return () => {
      listController.current?.abort();
      sourceController.current?.abort();
    };
  }, []);

  async function handleSourceAccess(
    item: DocumentLibraryItemDto,
    disposition: "inline" | "attachment",
  ) {
    sourceController.current?.abort();
    const controller = new AbortController();
    sourceController.current = controller;
    setSourceBusyId(item.id);
    setError(null);
    setActiveSource(null);
    setSourcePhase(`Authorizing ${disposition === "inline" ? "original view" : "download"} for ${item.title}...`);

    try {
      const authorized = await requestDocumentSource(
        item.id,
        {
          disposition,
          page: urlContext.page,
          section: urlContext.section,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;

      const contentResponse = await fetch(authorized.source.url, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!contentResponse.ok) {
        const payload: unknown = await contentResponse.json().catch(() => null);
        const code =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          payload.error &&
          typeof payload.error === "object" &&
          "code" in payload.error &&
          typeof payload.error.code === "string"
            ? payload.error.code
            : "UPLOAD_UNAVAILABLE";
        throw new DocumentRequestError(code);
      }
      const blob = await contentResponse.blob();
      if (controller.signal.aborted) return;

      setActiveSource({
        documentId: authorized.source.documentId,
        title: authorized.source.title,
        fileName: authorized.source.fileName,
        mimeType: authorized.source.mimeType,
        disposition: authorized.source.disposition,
        byteLength: blob.size,
        expiresAt: authorized.source.expiresAt,
        ttlSeconds: authorized.source.ttlSeconds,
        context: authorized.source.context,
      });
      setSourcePhase(null);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setSourcePhase(null);
      setError(
        failure instanceof DocumentRequestError
          ? failure.message
          : "Original SOP access is temporarily unavailable. Try again.",
      );
    } finally {
      if (sourceController.current === controller && !controller.signal.aborted) {
        setSourceBusyId(null);
      }
    }
  }

  const contextParts = [
    urlContext.section ? `Section: ${urlContext.section}` : null,
    urlContext.page ? `Page ${urlContext.page}` : null,
  ].filter((part): part is string => Boolean(part));

  const activeContextParts = activeSource
    ? [
        activeSource.context.section ? `Section: ${activeSource.context.section}` : null,
        activeSource.context.page ? `Page ${activeSource.context.page}` : null,
      ].filter((part): part is string => Boolean(part))
    : [];

  return (
    <section className="mt-8 space-y-6" aria-label="SOP library" aria-busy={loading}>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold">SOP library</h2>
        <p className="text-sm text-[#4b5563]">
          {role === "ADMIN"
            ? "Search all SOP documents, inspect processing diagnostics, verify extractions, or access authorized originals."
            : "Search verified active SOP documents and open or download authorized original files."}
        </p>
        {contextParts.length > 0 && (
          <p className="text-sm font-medium text-black" data-testid="library-source-context">
            Source context: {contextParts.join(" · ")}
          </p>
        )}
      </div>

      <form
        noValidate
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void fetchLibrary(searchInput);
        }}
      >
        <div className="space-y-2">
          <label htmlFor="sop-library-search" className="block font-medium">
            Search SOP title
          </label>
          <input
            id="sop-library-search"
            type="search"
            maxLength={100}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Filter by SOP title..."
            className={inputClassName}
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={loading} className={buttonClassName}>
            Search
          </button>
          {(appliedQuery.length > 0 || searchInput.trim().length > 0) && (
            <button
              type="button"
              disabled={loading}
              className={buttonClassName}
              onClick={() => {
                setSearchInput("");
                void fetchLibrary("");
              }}
            >
              Clear search
            </button>
          )}
          <button
            type="button"
            disabled={loading}
            className={buttonClassName}
            onClick={() => void fetchLibrary(appliedQuery)}
          >
            Refresh library
          </button>
        </div>
      </form>

      <p className="text-sm text-[#4b5563]" role="status" data-testid="library-count-status">
        {loading
          ? "Loading SOP library..."
          : `${items.length} ${items.length === 1 ? "SOP document" : "SOP documents"} shown${
              appliedQuery ? ` for "${appliedQuery}"` : ""
            }.`}
      </p>

      {(sourcePhase || activeSource) && (
        <div
          role="status"
          data-testid="source-access-status"
          className="rounded-md border border-black bg-[#f9fafb] p-3 text-sm break-words"
        >
          {sourcePhase
            ? sourcePhase
            : activeSource && (
                <>
                  {activeSource.disposition === "inline" ? "Opened" : "Downloaded"} original{" "}
                  <span className="font-medium break-all">{activeSource.fileName}</span> (
                  {activeSource.byteLength} bytes)
                  {activeContextParts.length > 0 ? ` — ${activeContextParts.join(" · ")}` : ""}. Signed
                  access expires in {activeSource.ttlSeconds}s.
                </>
              )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-[#991b1b]">
          {error}
        </p>
      )}

      {!loading && items.length === 0 ? (
        <p className="rounded-md border border-[#d1d5db] p-4 text-sm text-[#4b5563]" data-testid="library-empty-state">
          {appliedQuery
            ? `No SOP documents matched "${appliedQuery}".`
            : role === "ADMIN"
              ? "No SOP documents have been uploaded yet."
              : "No active SOP documents are available yet."}
        </p>
      ) : (
        <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-[#d1d5db]">
          <table className="block w-full sm:table sm:table-fixed" aria-label="SOP documents">
            <thead className="sr-only border-b border-[#d1d5db] bg-[#f9fafb] text-left text-xs font-semibold uppercase text-[#374151] sm:not-sr-only sm:table-header-group">
              <tr className="sm:table-row">
                <th scope="col" className="sm:table-cell sm:w-[30%] sm:px-3 sm:py-2.5">Title</th>
                <th scope="col" className="sm:table-cell sm:w-[10%] sm:px-3 sm:py-2.5">Type</th>
                <th scope="col" className="sm:table-cell sm:w-[14%] sm:px-3 sm:py-2.5">Uploader</th>
                <th scope="col" className="sm:table-cell sm:w-[14%] sm:px-3 sm:py-2.5">Date</th>
                <th scope="col" className="sm:table-cell sm:w-[16%] sm:px-3 sm:py-2.5">Status</th>
                <th scope="col" className="sm:table-cell sm:w-[16%] sm:px-3 sm:py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody className="block divide-y divide-[#d1d5db] sm:table-row-group">
              {items.map((item) => {
                const canReview =
                  role === "ADMIN" &&
                  (item.status === "PENDING_VERIFICATION" ||
                    item.status === "ACTIVE" ||
                    item.status === "REJECTED");

                return (
                  <tr
                    key={item.id}
                    data-testid={`library-row-${item.id}`}
                    className="block space-y-2 p-3 sm:table-row sm:space-y-0 sm:p-0"
                  >
                    <td className="block min-w-0 break-words sm:table-cell sm:px-3 sm:py-3 sm:align-top">
                      <p className="font-medium break-words">{item.title}</p>
                      <p className="mt-0.5 text-xs text-[#4b5563] break-all">
                        File: {item.fileName} ({formatFileSize(item.sizeBytes)})
                      </p>
                    </td>
                    <td className="block min-w-0 text-sm sm:table-cell sm:px-3 sm:py-3 sm:align-top">
                      <span className="font-medium">{item.fileType}</span>
                    </td>
                    <td className="block min-w-0 text-sm break-words sm:table-cell sm:px-3 sm:py-3 sm:align-top">
                      {item.uploaderName}
                    </td>
                    <td className="block min-w-0 text-sm sm:table-cell sm:px-3 sm:py-3 sm:align-top">
                      <p>{formatDate(item.uploadedAt)}</p>
                      {item.verifiedAt && (
                        <p className="text-xs text-[#4b5563]">
                          Verified {formatDate(item.verifiedAt)}
                        </p>
                      )}
                    </td>
                    <td className="block min-w-0 text-sm sm:table-cell sm:px-3 sm:py-3 sm:align-top">
                      <span
                        data-testid={`library-status-${item.id}`}
                        className="inline-block rounded border border-black px-2 py-0.5 text-xs font-semibold break-all"
                      >
                        {item.status}
                      </span>
                      {role === "ADMIN" && item.diagnostics && (
                        <div
                          className="mt-1.5 space-y-1 text-xs text-[#4b5563] break-words"
                          data-testid={`library-diagnostics-${item.id}`}
                        >
                          {item.diagnostics.latestJob && (
                            <p>
                              Job: {item.diagnostics.latestJob.state}
                              {item.diagnostics.latestJob.stage
                                ? ` (${item.diagnostics.latestJob.stage})`
                                : ""}{" "}
                              · Attempt {item.diagnostics.latestJob.attemptNumber}
                            </p>
                          )}
                          <p>
                            {item.diagnostics.pageCount}{" "}
                            {item.diagnostics.pageCount === 1 ? "page" : "pages"} ·{" "}
                            {item.diagnostics.chunkCount}{" "}
                            {item.diagnostics.chunkCount === 1 ? "chunk" : "chunks"} ·{" "}
                            {item.diagnostics.issueCount}{" "}
                            {item.diagnostics.issueCount === 1 ? "issue" : "issues"}
                          </p>
                          {item.diagnostics.processingErrorCode && (
                            <p className="text-[#991b1b]">
                              Error: {item.diagnostics.processingErrorCode} —{" "}
                              {processingErrorCodeMessage(item.diagnostics.processingErrorCode)}
                            </p>
                          )}
                          {item.diagnostics.rejectionReason && (
                            <p className="text-[#991b1b]">
                              Rejected: {item.diagnostics.rejectionReason}
                            </p>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="block min-w-0 sm:table-cell sm:px-3 sm:py-3 sm:align-top">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={sourceBusyId === item.id}
                          className={buttonClassName}
                          onClick={() => void handleSourceAccess(item, "inline")}
                        >
                          Open original
                        </button>
                        <button
                          type="button"
                          disabled={sourceBusyId === item.id}
                          className={buttonClassName}
                          onClick={() => void handleSourceAccess(item, "attachment")}
                        >
                          Download original
                        </button>
                        {canReview && (
                          <Link
                            href={`/documents/${item.id}/verify`}
                            aria-label={`Review and verify ${item.title}`}
                            className={`${buttonClassName} inline-flex items-center justify-center text-center`}
                          >
                            Review and verify
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div>
          <button
            type="button"
            disabled={loading}
            className={buttonClassName}
            onClick={() => void fetchLibrary(appliedQuery, nextCursor, true)}
          >
            Load more SOPs
          </button>
        </div>
      )}
    </section>
  );
}
