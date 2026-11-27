"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { buttonClass, textLinkClassName } from "@/components/ui/primitives";

type PdfPreviewProps = {
  previewUrl: string | null;
  pageNumber: number;
  onPageChange: (page: number) => void;
  isDocxDerivative: boolean;
  fileName: string;
};

const minimumZoomPercent = 75;
const maximumZoomPercent = 200;
const zoomStepPercent = 25;

export function PdfPreview({
  previewUrl,
  pageNumber,
  onPageChange,
  isDocxDerivative,
  fileName,
}: PdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [loaded, setLoaded] = useState<{
    url: string | null;
    status: "ready" | "error";
    pageCount: number;
    errorMessage: string | null;
  }>({ url: null, status: "ready", pageCount: 0, errorMessage: null });
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderedState, setRenderedState] = useState<{ page: number; zoom: number } | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  const status: "idle" | "loading" | "ready" | "error" = !previewUrl
    ? "idle"
    : loaded.url !== previewUrl
      ? "loading"
      : loaded.status;
  const pageCount = status === "ready" ? loaded.pageCount : 0;
  const errorMessage = status === "error" ? loaded.errorMessage : renderError;
  const clampedPage = pageCount > 0 ? Math.min(Math.max(1, pageNumber), pageCount) : 1;

  useEffect(() => {
    if (!previewUrl) return;

    const controller = new AbortController();
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(previewUrl, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Preview unavailable.");
        const buffer = await response.arrayBuffer();
        if (cancelled) return;

        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

        const loadingTask = pdfjs.getDocument({
          data: new Uint8Array(buffer),
        });
        loadingTaskRef.current = loadingTask;
        const loadedDocument = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }
        pdfDocRef.current = loadedDocument;
        setRenderError(null);
        setLoaded({ url: previewUrl, status: "ready", pageCount: loadedDocument.numPages, errorMessage: null });
      } catch {
        if (cancelled) return;
        setLoaded({
          url: previewUrl,
          status: "error",
          pageCount: 0,
          errorMessage: "Could not render the PDF preview in-page.",
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      pdfDocRef.current = null;
      if (loadingTaskRef.current) {
        const currentTask = loadingTaskRef.current;
        loadingTaskRef.current = null;
        void currentTask.destroy();
      }
    };
  }, [previewUrl]);

  useEffect(() => {
    if (status !== "ready" || !pdfDocRef.current || !canvasRef.current || pageCount < 1) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    const documentProxy = pdfDocRef.current;

    void (async () => {
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }
        const page = await documentProxy.getPage(clampedPage);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: zoomPercent / 100 });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        const task = page.render({ canvas, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (!cancelled) {
          setRenderError(null);
          setRenderedState({ page: clampedPage, zoom: zoomPercent });
        }
      } catch (error) {
        if (cancelled) return;
        const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
        if (name !== "RenderingCancelledException") {
          setRenderError("Failed to render the selected preview page.");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [status, clampedPage, zoomPercent, pageCount]);

  return (
    <section
      aria-label="Document preview"
      className="min-w-0 space-y-4 rounded-[var(--radius-lg)] border border-[#e2e8f0] bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-[#0f172a]">Original preview</h2>
        {previewUrl && (
          <a href={previewUrl} target="_blank" rel="noopener noreferrer" className={textLinkClassName}>
            <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
            <span>Open PDF preview</span>
          </a>
        )}
      </div>

      {isDocxDerivative && (
        <p className="rounded-[var(--radius-md)] border border-[#bfdbfe] bg-[#eff6ff] p-3 text-sm text-[#1e40af]">
          DOCX derivative PDF preview: page breaks are approximate. Extracted chunks are anchored by section path.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Preview controls">
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          disabled={status !== "ready" || clampedPage <= 1}
          onClick={() => onPageChange(Math.max(1, clampedPage - 1))}
        >
          <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span>Previous page</span>
        </button>
        <span className="tabular-nums px-2 font-mono text-xs font-medium text-[#0f172a]" aria-live="polite">
          Page {pageCount > 0 ? clampedPage : 0} of {pageCount}
        </span>
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          disabled={status !== "ready" || clampedPage >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, clampedPage + 1))}
        >
          <span>Next page</span>
          <ChevronRight className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          disabled={status !== "ready" || zoomPercent <= minimumZoomPercent}
          onClick={() => setZoomPercent((current) => Math.max(minimumZoomPercent, current - zoomStepPercent))}
        >
          <ZoomOut className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span>Zoom out</span>
        </button>
        <span className="tabular-nums px-2 font-mono text-xs font-medium text-[#0f172a]">
          {zoomPercent}%
        </span>
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          disabled={status !== "ready" || zoomPercent >= maximumZoomPercent}
          onClick={() => setZoomPercent((current) => Math.min(maximumZoomPercent, current + zoomStepPercent))}
        >
          <ZoomIn className="h-4 w-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span>Zoom in</span>
        </button>
        <button
          type="button"
          className={buttonClass("secondary", "sm")}
          disabled={status !== "ready" || zoomPercent === 100}
          onClick={() => setZoomPercent(100)}
        >
          <RotateCcw className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
          <span>Reset zoom</span>
        </button>
      </div>

      {!previewUrl && (
        <p className="rounded-[var(--radius-md)] border border-[#e2e8f0] bg-[#f8fafc] p-4 text-sm text-[#475569]">
          No PDF preview is available yet for {fileName}.
        </p>
      )}

      {status === "loading" && (
        <p role="status" className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[#e2e8f0] bg-[#f8fafc] p-4 text-sm text-[#475569]">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={1.5} aria-hidden="true" />
          <span>Loading PDF preview...</span>
        </p>
      )}

      {errorMessage && (
        <p role="alert" className="rounded-[var(--radius-md)] border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
          {errorMessage}
        </p>
      )}

      <div className="max-h-[70vh] min-w-0 overflow-auto rounded-[var(--radius-md)] border border-[#e2e8f0] bg-[#f8fafc] p-2">
        <canvas
          ref={canvasRef}
          aria-label={`PDF preview canvas page ${clampedPage}`}
          data-rendered-page={renderedState?.page ?? ""}
          data-rendered-zoom={renderedState?.zoom ?? ""}
          className={status === "ready" ? "mx-auto block bg-white shadow-sm" : "hidden"}
        />
      </div>
    </section>
  );
}
