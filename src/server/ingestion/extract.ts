import { createHash } from "node:crypto";
import type { DocumentStorage } from "../documents/storage";
import { conversionWorkerUrl, paddleOcrUrl } from "./config";
import {
  ingestionLimits,
  IngestionStageError,
  paddleOcrResponseSchema,
  pdfInspectResponseSchema,
  type ExtractedPageDraft,
  type VerificationIssueDraft,
} from "./contracts";
import { extractDocxStructure } from "./docx";

type Environment = Readonly<Record<string, string | undefined>>;

export type ExtractableDocument = {
  id: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  originalKey: string;
};

export type ExtractionResult = {
  pages: ExtractedPageDraft[];
  issues: VerificationIssueDraft[];
  previewKey: string | null;
};

function normalizeExtractedText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function nonWhitespaceLength(text: string) {
  return text.replace(/\s+/g, "").length;
}

function hasNumbersOrUnits(text: string) {
  return /\d/.test(text) || /\b(?:mg|ml|kg|bar|psi|rpm|kpa|mpa|sec|min|hr|hours|minutes|seconds|°c|°f|%)\b/i.test(text);
}

function hasTableStructure(text: string) {
  const lines = text.split("\n");
  let pipeLines = 0;
  let alignedColumnLines = 0;
  for (const line of lines) {
    if (line.includes("|") && line.split("|").length >= 3) pipeLines++;
    if (/\S+\s{3,}\S+\s{3,}\S+/.test(line) || /\S+\t\S+\t\S+/.test(line)) alignedColumnLines++;
  }
  return pipeLines >= 2 || alignedColumnLines >= 2;
}

function isPdfHeader(bytes: Buffer) {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

function isPngHeader(bytes: Buffer) {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

async function fetchWorkerResponse(
  url: string,
  init: RequestInit,
  timeoutMilliseconds: number,
  codePrefix: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMilliseconds);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: "error", signal: combinedSignal });
  } catch {
    throw new IngestionStageError(`${codePrefix}_TRANSIENT`, true, 503);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const transient = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new IngestionStageError(transient ? `${codePrefix}_TRANSIENT` : `${codePrefix}_FAILED`, transient, transient ? 503 : 422);
  }
  return response;
}

async function readBoundedResponseBytes(response: Response, maximumBytes: number, errorCode: string) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > maximumBytes) {
      throw new IngestionStageError(errorCode, false, 422);
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new IngestionStageError(errorCode, false, 422);
      }
      chunks.push(value);
    }
    if (total === 0) throw new IngestionStageError(errorCode, false, 422);
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

function formatOcrModelName(
  models: { detection: string; recognition: string } | Array<{ name: string }>,
) {
  if (Array.isArray(models)) return models.map((entry) => entry.name).join("+");
  return `${models.detection}+${models.recognition}`;
}

async function runOcrOnRenderedPage(
  pdfBytes: Buffer,
  pageIndex: number,
  conversionOrigin: string,
  ocrOrigin: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
) {
  const renderResponse = await fetchWorkerResponse(
    `${conversionOrigin}/pdf/render-page?page=${pageIndex}&dpi=150`,
    {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array(pdfBytes),
    },
    ingestionLimits.pdfRenderTimeoutMilliseconds,
    "PDF_RENDER",
    fetchImpl,
    signal,
  );
  const pngBytes = await readBoundedResponseBytes(renderResponse, ingestionLimits.maxRenderedPngBytes, "PDF_RENDER_FAILED");
  if (!isPngHeader(pngBytes)) {
    throw new IngestionStageError("PDF_RENDER_FAILED", false, 422);
  }

  const ocrResponse = await fetchWorkerResponse(
    `${ocrOrigin}/ocr`,
    {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(pngBytes),
    },
    ingestionLimits.ocrTimeoutMilliseconds,
    "OCR_WORKER",
    fetchImpl,
    signal,
  );
  const payload: unknown = await ocrResponse.json().catch(() => null);
  const parsed = paddleOcrResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new IngestionStageError("OCR_RESULT_INVALID", false, 422);
  }
  if ("result" in parsed.data && parsed.data.result === "FAIL") {
    throw new IngestionStageError("OCR_PAGE_FAILED", false, 422);
  }

  const orderedSegments = [...parsed.data.segments].sort((left, right) => left.order - right.order);
  const text = orderedSegments.length > 0
    ? orderedSegments.map((segment) => segment.text).join("\n")
    : ("text" in parsed.data ? parsed.data.text : "");
  const confidences = orderedSegments.map((segment) => segment.confidence);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : null;
  const minConfidence = confidences.length > 0 ? Math.min(...confidences) : null;
  const lowConfidenceSegments = orderedSegments
    .filter((segment) => segment.confidence < ingestionLimits.ocrLowConfidenceThreshold)
    .map((segment) => ({ order: segment.order, confidence: segment.confidence, box: segment.box }));

  return {
    text,
    avgConfidence,
    minConfidence,
    lowConfidenceSegments,
    modelName: formatOcrModelName(parsed.data.models),
    segmentCount: "segmentCount" in parsed.data ? parsed.data.segmentCount : orderedSegments.length,
    pipelineVersion: parsed.data.pipelineVersion,
  };
}

function appendUniqueOcrLines(nativeText: string, ocrText: string) {
  const canonicalize = (line: string) => line.replace(/\s+/g, " ").trim().toLowerCase();
  const nativeLines = new Set(
    nativeText
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map(canonicalize)
      .filter((line) => line.length > 0),
  );
  const appended: string[] = [];
  for (const rawLine of ocrText.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const canonicalLine = canonicalize(trimmed);
    if (!nativeLines.has(canonicalLine)) {
      appended.push(rawLine.trimEnd());
    }
  }
  if (appended.length === 0) return { combined: nativeText, appendedLines: [] as string[] };
  return {
    combined: `${nativeText.trimEnd()}\n${appended.join("\n")}`,
    appendedLines: appended,
  };
}

async function storeDerivativePreview(
  previewKey: string,
  pdfBytes: Buffer,
  storage: DocumentStorage,
  signal: AbortSignal,
) {
  const existing = await storage.read(previewKey, ingestionLimits.maxPreviewBytes, signal);
  if (existing && isPdfHeader(existing.bytes)) return;
  try {
    await storage.create(previewKey, { bytes: pdfBytes, contentType: "application/pdf" }, signal);
  } catch (error) {
    const written = await storage.read(previewKey, ingestionLimits.maxPreviewBytes, signal);
    if (written && isPdfHeader(written.bytes)) return;
    throw error;
  }
}

export async function extractDocumentContent(input: {
  document: ExtractableDocument;
  jobId: string;
  storage: DocumentStorage;
  fetchImpl?: typeof fetch;
  env?: Environment;
  signal?: AbortSignal;
}): Promise<ExtractionResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const signal = input.signal ?? new AbortController().signal;
  const stored = await input.storage.read(input.document.originalKey, input.document.sizeBytes, signal);
  if (!stored) {
    throw new IngestionStageError("SOURCE_OBJECT_MISSING", false, 409);
  }
  if (
    stored.bytes.length !== input.document.sizeBytes ||
    createHash("sha256").update(stored.bytes).digest("hex") !== input.document.sha256
  ) {
    throw new IngestionStageError("SOURCE_INTEGRITY_MISMATCH", false, 422);
  }

  const conversionOrigin = conversionWorkerUrl(input.env);

  if (input.document.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const docx = await extractDocxStructure(stored.bytes, signal);

    const convertResponse = await fetchWorkerResponse(
      `${conversionOrigin}/convert/docx-to-pdf`,
      {
        method: "POST",
        headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        body: new Uint8Array(stored.bytes),
      },
      ingestionLimits.conversionTimeoutMilliseconds,
      "DOCX_CONVERSION",
      fetchImpl,
      signal,
    );
    const previewBytes = await readBoundedResponseBytes(
      convertResponse,
      ingestionLimits.maxPreviewBytes,
      "DOCX_CONVERSION_FAILED",
    );
    if (!isPdfHeader(previewBytes)) {
      throw new IngestionStageError("DOCX_CONVERSION_FAILED", false, 422);
    }

    const previewKey = `previews/${input.document.id}/${input.jobId}.pdf`;
    try {
      await storeDerivativePreview(previewKey, previewBytes, input.storage, signal);
    } catch {
      throw new IngestionStageError("PREVIEW_STORAGE_TRANSIENT", true, 503);
    }

    let derivativePageCount: number | null = null;
    try {
      const inspectPreview = await fetchWorkerResponse(
        `${conversionOrigin}/pdf/inspect-and-extract`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/pdf",
            "X-Max-Pages": String(ingestionLimits.maxPdfPages),
          },
          body: new Uint8Array(previewBytes),
        },
        ingestionLimits.pdfInspectTimeoutMilliseconds,
        "PDF_INSPECT",
        fetchImpl,
        signal,
      );
      const parsedPreview = pdfInspectResponseSchema.safeParse(await inspectPreview.json().catch(() => null));
      if (parsedPreview.success) derivativePageCount = parsedPreview.data.pageCount;
    } catch {
      // Derivative preview inspection is informational; keep native DOCX extraction authoritative.
    }

    const issues: VerificationIssueDraft[] = [
      {
        pageIndex: 1,
        sectionPath: null,
        severity: "info",
        issueCode: "DOCX_PREVIEW_PAGINATION_NOTE",
        summary: "DOCX content was extracted from native document structure; derivative PDF preview pagination is approximate.",
        region: derivativePageCount !== null ? { derivativePageCount } : null,
      },
    ];
    if (docx.tableCount > 0) {
      issues.push({
        pageIndex: 1,
        sectionPath: null,
        severity: "warning",
        issueCode: "TABLE_STRUCTURE_REVIEW",
        summary: "Extracted DOCX contains tables; verify column alignment, headers, and numeric values during review.",
        region: { tableCount: docx.tableCount },
      });
    }
    if (!docx.normalizedText) {
      issues.push({
        pageIndex: 1,
        sectionPath: null,
        severity: "error",
        issueCode: "EMPTY_DOCUMENT_TEXT",
        summary: "No readable text was found in this DOCX file.",
        region: null,
      });
    }

    const page: ExtractedPageDraft = {
      pageIndex: 1,
      pageKind: "docx_section_flow",
      sourceLocationKind: "docx_derivative_preview",
      rawText: docx.rawText,
      normalizedText: docx.normalizedText,
      ocrConfidence: null,
      ocrModel: null,
      layoutMetadata: {
        blockCount: docx.blocks.length,
        tableCount: docx.tableCount,
        derivativePageCount,
        blocks: docx.blocks,
      },
      blocks: docx.blocks,
    };

    return { pages: [page], issues, previewKey };
  }

  if (input.document.mimeType === "application/pdf") {
    const ocrOrigin = paddleOcrUrl(input.env);
    const inspectResponse = await fetchWorkerResponse(
      `${conversionOrigin}/pdf/inspect-and-extract`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "X-Max-Pages": String(ingestionLimits.maxPdfPages),
        },
        body: new Uint8Array(stored.bytes),
      },
      ingestionLimits.pdfInspectTimeoutMilliseconds,
      "PDF_INSPECT",
      fetchImpl,
      signal,
    );
    const inspected = pdfInspectResponseSchema.safeParse(await inspectResponse.json().catch(() => null));
    if (!inspected.success) {
      throw new IngestionStageError("PDF_INSPECT_INVALID", false, 422);
    }
    if (inspected.data.pageCount === 0 || inspected.data.pages.length === 0) {
      throw new IngestionStageError("PDF_EMPTY", false, 422);
    }

    const orderedPages = [...inspected.data.pages].sort((left, right) => left.pageIndex - right.pageIndex);
    const pages: ExtractedPageDraft[] = [];
    const issues: VerificationIssueDraft[] = [];

    for (const inspectedPage of orderedPages) {
      const nativeCharCount = nonWhitespaceLength(inspectedPage.nativeText);

      if (nativeCharCount < ingestionLimits.blankPageMaxChars && inspectedPage.imageCount === 0) {
        pages.push({
          pageIndex: inspectedPage.pageIndex,
          pageKind: "blank",
          sourceLocationKind: "pdf_page",
          rawText: inspectedPage.nativeText,
          normalizedText: normalizeExtractedText(inspectedPage.nativeText),
          ocrConfidence: null,
          ocrModel: null,
          layoutMetadata: { imageCount: 0, maxImagePixels: 0 },
        });
        issues.push({
          pageIndex: inspectedPage.pageIndex,
          sectionPath: null,
          severity: "warning",
          issueCode: "BLANK_PAGE",
          summary: `Page ${inspectedPage.pageIndex} contains no readable text or images.`,
          region: null,
        });
        continue;
      }

      if (nativeCharCount < ingestionLimits.scannedPageMaxNativeChars && inspectedPage.imageCount > 0) {
        const ocr = await runOcrOnRenderedPage(
          stored.bytes,
          inspectedPage.pageIndex,
          conversionOrigin,
          ocrOrigin,
          fetchImpl,
          signal,
        );
        const normalizedOcr = normalizeExtractedText(ocr.text);
        if (!normalizedOcr) {
          pages.push({
            pageIndex: inspectedPage.pageIndex,
            pageKind: "blank",
            sourceLocationKind: "pdf_page",
            rawText: "",
            normalizedText: "",
            ocrConfidence: ocr.avgConfidence,
            ocrModel: ocr.modelName,
            layoutMetadata: { imageCount: inspectedPage.imageCount, maxImagePixels: inspectedPage.maxImagePixels, segmentCount: ocr.segmentCount },
          });
          issues.push({
            pageIndex: inspectedPage.pageIndex,
            sectionPath: null,
            severity: "warning",
            issueCode: "BLANK_PAGE",
            summary: `Page ${inspectedPage.pageIndex} produced no readable text after OCR.`,
            region: null,
          });
          continue;
        }

        pages.push({
          pageIndex: inspectedPage.pageIndex,
          pageKind: "scanned_ocr",
          sourceLocationKind: "pdf_page",
          rawText: ocr.text,
          normalizedText: normalizedOcr,
          ocrConfidence: ocr.avgConfidence,
          ocrModel: ocr.modelName,
          layoutMetadata: {
            imageCount: inspectedPage.imageCount,
            maxImagePixels: inspectedPage.maxImagePixels,
            segmentCount: ocr.segmentCount,
            minConfidence: ocr.minConfidence,
            ocrPipelineVersion: ocr.pipelineVersion,
          },
        });

        if (
          (ocr.avgConfidence !== null && ocr.avgConfidence < ingestionLimits.ocrLowConfidenceThreshold) ||
          (ocr.minConfidence !== null && ocr.minConfidence < ingestionLimits.ocrLowConfidenceThreshold)
        ) {
          issues.push({
            pageIndex: inspectedPage.pageIndex,
            sectionPath: null,
            severity: "warning",
            issueCode: "LOW_OCR_CONFIDENCE",
            summary: `Page ${inspectedPage.pageIndex} has OCR segments below ${ingestionLimits.ocrLowConfidenceThreshold} confidence.`,
            region: {
              avgConfidence: ocr.avgConfidence,
              minConfidence: ocr.minConfidence,
              lowConfidenceSegments: ocr.lowConfidenceSegments,
            },
          });
        }
        if (hasNumbersOrUnits(normalizedOcr)) {
          issues.push({
            pageIndex: inspectedPage.pageIndex,
            sectionPath: null,
            severity: "warning",
            issueCode: "NUMERIC_UNIT_REVIEW",
            summary: `Page ${inspectedPage.pageIndex} contains OCR-extracted numbers or units; verify exact values against the source scan.`,
            region: null,
          });
        }
        continue;
      }

      if (
        nativeCharCount >= ingestionLimits.scannedPageMaxNativeChars &&
        inspectedPage.imageCount > 0 &&
        inspectedPage.maxImagePixels >= ingestionLimits.mixedPageMinImagePixels
      ) {
        const ocr = await runOcrOnRenderedPage(
          stored.bytes,
          inspectedPage.pageIndex,
          conversionOrigin,
          ocrOrigin,
          fetchImpl,
          signal,
        );
        const { combined, appendedLines } = appendUniqueOcrLines(inspectedPage.nativeText, ocr.text);
        const normalizedCombined = normalizeExtractedText(combined);

        pages.push({
          pageIndex: inspectedPage.pageIndex,
          pageKind: "mixed_ocr",
          sourceLocationKind: "pdf_page",
          rawText: combined,
          normalizedText: normalizedCombined,
          ocrConfidence: ocr.avgConfidence,
          ocrModel: ocr.modelName,
          layoutMetadata: {
            imageCount: inspectedPage.imageCount,
            maxImagePixels: inspectedPage.maxImagePixels,
            segmentCount: ocr.segmentCount,
            appendedOcrLineCount: appendedLines.length,
            minConfidence: ocr.minConfidence,
          },
        });

        issues.push({
          pageIndex: inspectedPage.pageIndex,
          sectionPath: null,
          severity: "warning",
          issueCode: "MIXED_PAGE_OCR",
          summary: `Page ${inspectedPage.pageIndex} combines native PDF text and large embedded images; verify merged OCR content.`,
          region: { appendedOcrLineCount: appendedLines.length },
        });
        if (
          (ocr.avgConfidence !== null && ocr.avgConfidence < ingestionLimits.ocrLowConfidenceThreshold) ||
          (ocr.minConfidence !== null && ocr.minConfidence < ingestionLimits.ocrLowConfidenceThreshold)
        ) {
          issues.push({
            pageIndex: inspectedPage.pageIndex,
            sectionPath: null,
            severity: "warning",
            issueCode: "LOW_OCR_CONFIDENCE",
            summary: `Page ${inspectedPage.pageIndex} has OCR segments below ${ingestionLimits.ocrLowConfidenceThreshold} confidence.`,
            region: {
              avgConfidence: ocr.avgConfidence,
              minConfidence: ocr.minConfidence,
              lowConfidenceSegments: ocr.lowConfidenceSegments,
            },
          });
        }
        if (hasNumbersOrUnits(ocr.text)) {
          issues.push({
            pageIndex: inspectedPage.pageIndex,
            sectionPath: null,
            severity: "warning",
            issueCode: "NUMERIC_UNIT_REVIEW",
            summary: `Page ${inspectedPage.pageIndex} contains OCR-extracted numbers or units; verify exact figures against the original page.`,
            region: null,
          });
        }
        continue;
      }

      const normalizedNative = normalizeExtractedText(inspectedPage.nativeText);
      pages.push({
        pageIndex: inspectedPage.pageIndex,
        pageKind: "native",
        sourceLocationKind: "pdf_page",
        rawText: inspectedPage.nativeText,
        normalizedText: normalizedNative,
        ocrConfidence: null,
        ocrModel: null,
        layoutMetadata: {
          imageCount: inspectedPage.imageCount,
          maxImagePixels: inspectedPage.maxImagePixels,
        },
      });
      if (hasTableStructure(normalizedNative)) {
        issues.push({
          pageIndex: inspectedPage.pageIndex,
          sectionPath: null,
          severity: "warning",
          issueCode: "TABLE_STRUCTURE_REVIEW",
          summary: `Page ${inspectedPage.pageIndex} appears to contain tabular content; verify row and column fidelity.`,
          region: null,
        });
      }
    }

    return { pages, issues, previewKey: null };
  }

  throw new IngestionStageError("UNSUPPORTED_DOCUMENT_MIME", false, 422);
}
