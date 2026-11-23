"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import { linkClassName } from "@/components/auth/client";

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
const controlButtonClassName =
  "inline-flex min-h-11 items-center justify-center rounded border border-[#1f2937] px-3 py-2 text-sm font-medium text-[#111827] hover:bg-[#f3f4f6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111827] disabled:cursor-not-allowed disabled:opacity-50";

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
    <section aria-label="Document preview" className="min-w-0 space-y-3 rounded border border-[#d1d5db] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Original preview</h2>
        {previewUrl && (
          <a href={previewUrl} target="_blank" rel="noopener noreferrer" className={linkClassName}>
            Open PDF preview
          </a>
        )}
      </div>

      {isDocxDerivative && (
        <p className="rounded border border-[#bfdbfe] bg-[#eff6ff] p-3 text-sm text-[#1e3a8a]">
          DOCX derivative PDF preview: page breaks are approximate. Extracted chunks are anchored by section path.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Preview controls">
        <button
          type="button"
          className={controlButtonClassName}
          disabled={status !== "ready" || clampedPage <= 1}
          onClick={() => onPageChange(Math.max(1, clampedPage - 1))}
        >
          Previous page
        </button>
        <span className="px-2 text-sm font-medium" aria-live="polite">
          Page {pageCount > 0 ? clampedPage : 0} of {pageCount}
        </span>
        <button
          type="button"
          className={controlButtonClassName}
          disabled={status !== "ready" || clampedPage >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, clampedPage + 1))}
        >
          Next page
        </button>
        <button
          type="button"
          className={controlButtonClassName}
          disabled={status !== "ready" || zoomPercent <= minimumZoomPercent}
          onClick={() => setZoomPercent((current) => Math.max(minimumZoomPercent, current - zoomStepPercent))}
        >
          Zoom out
        </button>
        <span className="px-2 text-sm font-medium">{zoomPercent}%</span>
        <button
          type="button"
          className={controlButtonClassName}
          disabled={status !== "ready" || zoomPercent >= maximumZoomPercent}
          onClick={() => setZoomPercent((current) => Math.min(maximumZoomPercent, current + zoomStepPercent))}
        >
          Zoom in
        </button>
        <button
          type="button"
          className={controlButtonClassName}
          disabled={status !== "ready" || zoomPercent === 100}
          onClick={() => setZoomPercent(100)}
        >
          Reset zoom
        </button>
      </div>

      {!previewUrl && (
        <p className="rounded border border-[#e5e7eb] p-4 text-sm text-[#4b5563]">
          No PDF preview is available yet for {fileName}.
        </p>
      )}

      {status === "loading" && (
        <p role="status" className="rounded border border-[#e5e7eb] p-4 text-sm text-[#4b5563]">
          Loading PDF preview...
        </p>
      )}

      {errorMessage && (
        <p role="alert" className="rounded border border-[#fecaca] bg-[#fef2f2] p-3 text-sm text-[#991b1b]">
          {errorMessage}
        </p>
      )}

      <div className="max-h-[70vh] min-w-0 overflow-auto rounded border border-[#e5e7eb] bg-[#f9fafb] p-2">
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
