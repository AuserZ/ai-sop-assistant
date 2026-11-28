"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  flexRender,
  tableFeatures,
  useTable,
  type ColumnDef,
} from "@tanstack/react-table";
import {
  AlertCircle,
  Download,
  ExternalLink,
  FileCheck2,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type {
  DocumentLibraryItemDto,
  DocumentLibraryResponse,
  DocumentSourceContextDto,
} from "@/server/documents/contracts";
import { buttonClass, inputFieldClassName, StatusBadge } from "@/components/ui/primitives";
import {
  deleteDocument,
  DocumentRequestError,
  listLibraryDocuments,
  processingErrorCodeMessage,
  requestDocumentSource,
} from "./client";

const libraryTableFeatures = tableFeatures({});

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

const columnWidthClass: Readonly<Record<string, string>> = {
  title: "md:w-[27%]",
  fileType: "md:w-[8%]",
  uploaderName: "md:w-[13%]",
  uploadedAt: "md:w-[13%]",
  status: "md:w-[19%]",
  actions: "md:w-[20%]",
};

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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [urlContext] = useState<DocumentSourceContextDto>(() => readUrlContext());
  const listController = useRef<AbortController | null>(null);
  const sourceController = useRef<AbortController | null>(null);
  const deleteController = useRef<AbortController | null>(null);
  const lastRefreshSignal = useRef(refreshSignal);

  const fetchLibrary = useCallback(
    async (queryText: string, cursor?: string, append = false) => {
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
    },
    [],
  );

  useEffect(() => {
    if (refreshSignal !== lastRefreshSignal.current) {
      lastRefreshSignal.current = refreshSignal;
      void fetchLibrary(appliedQuery);
    }
  }, [refreshSignal, appliedQuery, fetchLibrary]);

  useEffect(() => {
    return () => {
      listController.current?.abort();
      sourceController.current?.abort();
      deleteController.current?.abort();
    };
  }, []);

  const hasPendingCleanup =
    role === "ADMIN" &&
    items.some(
      (item) =>
        item.status === "DELETED" &&
        (item.diagnostics?.cleanup?.state === "PENDING" ||
          item.diagnostics?.cleanup?.state === "RUNNING"),
    );

  useEffect(() => {
    if (!hasPendingCleanup) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void listLibraryDocuments({ q: appliedQuery }, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setItems(response.items);
          setNextCursor(response.nextCursor);
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [hasPendingCleanup, appliedQuery]);

  const handleDeleteDocument = useCallback(async (item: DocumentLibraryItemDto) => {
    deleteController.current?.abort();
    const controller = new AbortController();
    deleteController.current = controller;
    setDeleteBusyId(item.id);
    setError(null);
    setDeleteNotice(null);
    try {
      const result = await deleteDocument(item.id, controller.signal);
      if (controller.signal.aborted) return;
      setConfirmDeleteId(null);
      setItems((previous) =>
        previous.map((entry) =>
          entry.id === item.id
            ? {
                ...entry,
                status: "DELETED",
                deletedAt: result.document.deletedAt,
                diagnostics: entry.diagnostics
                  ? {
                      ...entry.diagnostics,
                      hasPreview: false,
                      cleanup: result.document.cleanup,
                    }
                  : null,
              }
            : entry,
        ),
      );
      setActiveSource((current) => (current?.documentId === item.id ? null : current));
      setDeleteNotice(
        result.created
          ? `Deleted "${item.title}". Retrieval and source access were removed immediately; cleanup is ${result.document.cleanup.state}.`
          : `Cleanup re-queued for "${item.title}" (${result.document.cleanup.state}).`,
      );
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(
        failure instanceof DocumentRequestError
          ? failure.message
          : "Document deletion is temporarily unavailable. Try again.",
      );
    } finally {
      if (deleteController.current === controller && !controller.signal.aborted) {
        setDeleteBusyId(null);
      }
    }
  }, []);

  const handleSourceAccess = useCallback(
    async (item: DocumentLibraryItemDto, disposition: "inline" | "attachment") => {
      sourceController.current?.abort();
      const controller = new AbortController();
      sourceController.current = controller;
      setSourceBusyId(item.id);
      setError(null);
      setActiveSource(null);
      setSourcePhase(
        `Authorizing ${disposition === "inline" ? "original view" : "download"} for ${item.title}...`,
      );

      // Open synchronously inside the click gesture so browser popup blockers allow the new tab.
      const previewWindow =
        disposition === "inline" && typeof window !== "undefined" ? window.open("", "_blank") : null;
      if (previewWindow) previewWindow.opener = null;

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
        if (controller.signal.aborted) {
          previewWindow?.close();
          return;
        }

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
        if (controller.signal.aborted) {
          previewWindow?.close();
          return;
        }

        const shouldOpenInlinePdf =
          disposition === "inline" && authorized.source.mimeType === "application/pdf";

        if (shouldOpenInlinePdf) {
          const targetUrl = authorized.source.context.page
            ? `${authorized.source.url}#page=${authorized.source.context.page}`
            : authorized.source.url;
          if (previewWindow && !previewWindow.closed) {
            previewWindow.location.replace(targetUrl);
          } else {
            window.open(targetUrl, "_blank", "noopener,noreferrer");
          }
        } else {
          previewWindow?.close();
          const objectUrl = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = objectUrl;
          anchor.download = authorized.source.fileName;
          anchor.rel = "noopener noreferrer";
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
        }

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
        previewWindow?.close();
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
    },
    [urlContext.page, urlContext.section],
  );

  const columns = useMemo<ColumnDef<typeof libraryTableFeatures, DocumentLibraryItemDto>[]>(
    () => [
      {
        id: "title",
        header: "Title",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="min-w-0">
              <p className="break-words font-medium text-[#0f172a]">{item.title}</p>
              <p className="tabular-nums mt-0.5 break-all font-mono text-xs text-[#64748b]">
                {item.fileName} ({formatFileSize(item.sizeBytes)})
              </p>
            </div>
          );
        },
      },
      {
        id: "fileType",
        header: "Type",
        cell: ({ row }) => (
          <span className="inline-flex rounded-[var(--radius-sm)] border border-[#e2e8f0] bg-[#f8fafc] px-2 py-0.5 font-mono text-xs font-medium text-[#0f172a]">
            {row.original.fileType}
          </span>
        ),
      },
      {
        id: "uploaderName",
        header: "Uploaded by",
        cell: ({ row }) => (
          <span className="break-words text-sm text-[#475569]">{row.original.uploaderName}</span>
        ),
      },
      {
        id: "uploadedAt",
        header: "Uploaded",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="tabular-nums space-y-0.5 font-mono text-xs text-[#475569]">
              <p className="text-[#0f172a]">{formatDate(item.uploadedAt)}</p>
              {item.verifiedAt && (
                <p className="text-[#065f46]">Verified {formatDate(item.verifiedAt)}</p>
              )}
              {item.deletedAt && (
                <p className="text-[#991b1b]">Deleted {formatDate(item.deletedAt)}</p>
              )}
            </div>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="min-w-0 space-y-1.5">
              <StatusBadge
                label={item.status}
                testId={`library-status-${item.id}`}
                className="break-all"
              />
              {role === "ADMIN" && item.diagnostics && (
                <div
                  className="tabular-nums space-y-1 break-words text-xs text-[#475569]"
                  data-testid={`library-diagnostics-${item.id}`}
                >
                  {item.diagnostics.cleanup && (
                    <p
                      data-testid={`library-cleanup-${item.id}`}
                      className={
                        item.diagnostics.cleanup.state === "FAILED"
                          ? "font-medium text-[#991b1b]"
                          : "font-medium text-[#0f172a]"
                      }
                    >
                      Cleanup: {item.diagnostics.cleanup.state}
                    </p>
                  )}
                  {item.diagnostics.cleanup?.errorCode && (
                    <p className="text-[#991b1b]">
                      {processingErrorCodeMessage(item.diagnostics.cleanup.errorCode)}
                    </p>
                  )}
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
            </div>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const item = row.original;
          const isDeleted = item.status === "DELETED";
          const canReview =
            role === "ADMIN" &&
            (item.status === "PENDING_VERIFICATION" ||
              item.status === "ACTIVE" ||
              item.status === "REJECTED");
          const isConfirmingDelete = role === "ADMIN" && !isDeleted && confirmDeleteId === item.id;
          const canRetryCleanup =
            role === "ADMIN" &&
            isDeleted &&
            item.diagnostics?.cleanup?.state === "FAILED";

          return (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {canReview && (
                  <Link
                    href={`/documents/${item.id}/verify`}
                    aria-label={`Review and verify ${item.title}`}
                    className={buttonClass(
                      item.status === "PENDING_VERIFICATION" ? "primary" : "secondary",
                      "sm",
                    )}
                  >
                    <FileCheck2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                    <span>Review and verify</span>
                  </Link>
                )}
                {!isDeleted && (
                  <>
                    <button
                      type="button"
                      disabled={sourceBusyId === item.id || deleteBusyId === item.id}
                      className={buttonClass("secondary", "sm")}
                      onClick={() => void handleSourceAccess(item, "inline")}
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span>Open original</span>
                    </button>
                    <button
                      type="button"
                      disabled={sourceBusyId === item.id || deleteBusyId === item.id}
                      className={buttonClass("secondary", "sm")}
                      onClick={() => void handleSourceAccess(item, "attachment")}
                    >
                      <Download className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                      <span>Download original</span>
                    </button>
                  </>
                )}
                {role === "ADMIN" && !isDeleted && !isConfirmingDelete && (
                  <button
                    type="button"
                    aria-label={`Delete SOP ${item.title}`}
                    disabled={deleteBusyId === item.id}
                    className={buttonClass("destructive", "sm")}
                    onClick={() => {
                      setConfirmDeleteId(item.id);
                      setError(null);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                    <span>Delete SOP</span>
                  </button>
                )}
                {canRetryCleanup && (
                  <button
                    type="button"
                    disabled={deleteBusyId === item.id}
                    className={buttonClass("secondary", "sm")}
                    onClick={() => void handleDeleteDocument(item)}
                  >
                    Retry cleanup
                  </button>
                )}
              </div>
              {isConfirmingDelete && (
                <div
                  data-testid={`delete-confirm-${item.id}`}
                  className="space-y-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]"
                >
                  <p className="break-words">
                    Deleting removes retrieval and source access immediately. Approved backup
                    retention may outlast live deletion.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={deleteBusyId === item.id}
                      className={buttonClass("destructive", "sm")}
                      onClick={() => void handleDeleteDocument(item)}
                    >
                      Confirm delete
                    </button>
                    <button
                      type="button"
                      disabled={deleteBusyId === item.id}
                      className={buttonClass("secondary", "sm")}
                      onClick={() => setConfirmDeleteId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        },
      },
    ],
    [role, confirmDeleteId, sourceBusyId, deleteBusyId, handleSourceAccess, handleDeleteDocument],
  );

  const table = useTable({
    features: libraryTableFeatures,
    data: items,
    columns,
    getRowId: (row) => row.id,
  });

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
    <section className="space-y-5" aria-label="SOP library" aria-busy={loading}>
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-[#0f172a]">SOP library</h2>
        <p className="max-w-[68ch] text-sm text-[#475569]">
          {role === "ADMIN"
            ? "Search all SOP documents, inspect processing diagnostics, verify extractions, or access authorized originals."
            : "Search verified active SOP documents and open or download authorized original files."}
        </p>
        {contextParts.length > 0 && (
          <p
            className="tabular-nums inline-flex rounded-[var(--radius-sm)] border border-[#bfdbfe] bg-[#eff6ff] px-2.5 py-1 text-xs font-medium text-[#1e40af]"
            data-testid="library-source-context"
          >
            Source context: {contextParts.join(" · ")}
          </p>
        )}
      </div>

      <form
        noValidate
        className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 shadow-[var(--shadow-surface)]"
        onSubmit={(event) => {
          event.preventDefault();
          void fetchLibrary(searchInput);
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label htmlFor="sop-library-search" className="block text-sm font-medium text-[#0f172a]">
              Search SOP title
            </label>
            <input
              id="sop-library-search"
              type="search"
              maxLength={100}
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Filter by SOP title..."
              className={inputFieldClassName}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={loading} className={buttonClass("primary")}>
              <Search className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>Search</span>
            </button>
            {(appliedQuery.length > 0 || searchInput.trim().length > 0) && (
              <button
                type="button"
                disabled={loading}
                className={buttonClass("secondary")}
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
              className={buttonClass("secondary")}
              onClick={() => void fetchLibrary(appliedQuery)}
            >
              <RefreshCw className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
              <span>Refresh library</span>
            </button>
          </div>
        </div>
      </form>

      <p
        className="tabular-nums text-sm text-[#475569]"
        role="status"
        data-testid="library-count-status"
      >
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
          className="tabular-nums rounded-[var(--radius-md)] border border-[#bfdbfe] bg-[#eff6ff] p-3 text-sm text-[#1e40af] break-words"
        >
          {sourcePhase ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
              <span>{sourcePhase}</span>
            </span>
          ) : (
            activeSource && (
              <>
                {activeSource.disposition === "inline" ? "Opened" : "Downloaded"} original{" "}
                <span className="font-mono font-medium break-all">{activeSource.fileName}</span> (
                {activeSource.byteLength} bytes)
                {activeContextParts.length > 0 ? ` — ${activeContextParts.join(" · ")}` : ""}. Signed
                access expires in {activeSource.ttlSeconds}s.
              </>
            )
          )}
        </div>
      )}

      {deleteNotice && (
        <div
          role="status"
          data-testid="delete-action-status"
          className="rounded-[var(--radius-md)] border border-[#a7f3d0] bg-[#ecfdf5] p-3 text-sm text-[#065f46] break-words"
        >
          {deleteNotice}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {!loading && items.length === 0 ? (
        <p
          className="rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-5 text-sm text-[#475569]"
          data-testid="library-empty-state"
        >
          {appliedQuery
            ? `No SOP documents matched "${appliedQuery}".`
            : role === "ADMIN"
              ? "No SOP documents have been uploaded yet."
              : "No active SOP documents are available yet."}
        </p>
      ) : (
        <div className="min-w-0 max-w-full md:overflow-hidden md:rounded-[var(--radius-lg)] md:border md:border-[#e2e8f0] md:bg-white md:shadow-[var(--shadow-surface)]">
          <table className="block w-full md:table md:table-fixed" aria-label="SOP documents">
            <thead className="hidden border-b border-[#e2e8f0] bg-[#f8fafc] text-left text-xs font-medium text-[#475569] md:table-header-group">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="md:table-row">
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      scope="col"
                      className={`md:table-cell md:px-4 md:py-3 ${columnWidthClass[header.id] ?? ""}`}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="block space-y-3 md:table-row-group md:space-y-0 md:divide-y md:divide-[#e2e8f0]">
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`library-row-${row.original.id}`}
                  className="cp-instant block space-y-3 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4 md:table-row md:space-y-0 md:rounded-none md:border-0 md:p-0 md:hover:bg-[#f8fafc]"
                >
                  {row.getAllCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="block min-w-0 md:table-cell md:px-4 md:py-3.5 md:align-top"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <div>
          <button
            type="button"
            disabled={loading}
            className={buttonClass("secondary")}
            onClick={() => void fetchLibrary(appliedQuery, nextCursor, true)}
          >
            Load more SOPs
          </button>
        </div>
      )}
    </section>
  );
}
