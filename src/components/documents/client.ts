import { z } from "zod";
import type {
  DocumentLibraryResponse,
  DocumentSourceAuthorizationResponse,
  DocumentUploadDto,
  UploadInitResponse,
  UploadStatusResponse,
} from "@/server/documents/contracts";

export const maximumUploadBytes = 20_000_000;
const metadataTimeoutMilliseconds = 35_000;
const mimeTypeSchema = z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
const lifecycleStatusSchema = z.enum(["UPLOADED", "PROCESSING", "PENDING_VERIFICATION", "ACTIVE", "REJECTED", "FAILED"]);
const jobStateSchema = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "WAITING_FOR_PIPELINE"]);
const documentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  fileName: z.string(),
  mimeType: mimeTypeSchema,
  sizeBytes: z.number().int().positive().max(maximumUploadBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  uploadStatus: z.enum(["AWAITING_UPLOAD", "FINALIZING", "FAILED", "ACCEPTED", "EXPIRED"]),
  status: lifecycleStatusSchema.nullable(),
  failureCode: z.string().nullable(),
  processingErrorCode: z.string().nullable().optional().default(null),
  processedJobId: z.uuid().nullable().optional().default(null),
  activeJobId: z.uuid().nullable().optional().default(null),
  verifiedAt: z.string().datetime().nullable().optional().default(null),
  rejectionReason: z.string().nullable().optional().default(null),
  summary: z.object({
    pageCount: z.number().int().min(0),
    chunkCount: z.number().int().min(0),
    issueCount: z.number().int().min(0),
    hasPreview: z.boolean(),
  }).nullable().optional().default(null),
  job: z.object({
    id: z.uuid(),
    state: jobStateSchema,
    stage: z.string().nullable().optional().default(null),
    attemptNumber: z.number().int().min(1).max(3).optional().default(1),
    errorCode: z.string().nullable().optional().default(null),
  }).nullable(),
}).refine((document) => document.uploadStatus !== "ACCEPTED" || (document.status !== null && document.job !== null));
const statusSchema = z.object({ document: documentSchema });
const initSchema = statusSchema.extend({ upload: z.object({
  url: z.string().url(), method: z.literal("PUT"),
  headers: z.object({ "Content-Type": mimeTypeSchema, "If-None-Match": z.literal("*") }),
  sizeBytes: z.number().int().positive().max(maximumUploadBytes), expiresAt: z.string().datetime(),
}).nullable() });

const libraryDiagnosticsSchema = z.object({
  processingErrorCode: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  latestJob: z.object({
    id: z.uuid(),
    state: jobStateSchema,
    stage: z.string().nullable(),
    attemptNumber: z.number().int().min(1).max(3),
    errorCode: z.string().nullable(),
  }).nullable(),
  pageCount: z.number().int().min(0),
  chunkCount: z.number().int().min(0),
  issueCount: z.number().int().min(0),
  hasPreview: z.boolean(),
});

const libraryItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  fileName: z.string(),
  mimeType: mimeTypeSchema,
  fileType: z.enum(["PDF", "DOCX"]),
  sizeBytes: z.number().int().positive().max(maximumUploadBytes),
  uploaderName: z.string(),
  uploadedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable(),
  status: lifecycleStatusSchema,
  diagnostics: libraryDiagnosticsSchema.nullable(),
});

const libraryResponseSchema = z.object({
  items: z.array(libraryItemSchema),
  nextCursor: z.string().nullable(),
});

const sourceAuthorizationSchema = z.object({
  source: z.object({
    documentId: z.uuid(),
    title: z.string(),
    fileName: z.string(),
    mimeType: mimeTypeSchema,
    disposition: z.enum(["inline", "attachment"]),
    url: z.string().min(1),
    expiresAt: z.string().datetime(),
    ttlSeconds: z.literal(60),
    context: z.object({
      page: z.number().int().positive().nullable(),
      section: z.string().nullable(),
    }),
  }),
});

const messages: Record<string, string> = {
  UNAUTHENTICATED: "Sign in again to continue.", FORBIDDEN: "Only Admins can upload SOPs.",
  NOT_FOUND: "This upload was not found or is unavailable to your account.",
  INVALID_INPUT: "Check the title and file, then try again.", RATE_LIMITED: "Too many attempts. Wait a moment and try again.",
  UPLOAD_QUOTA_EXCEEDED: "There is not enough upload storage available. Contact the app owner.",
  UPLOAD_EXPIRED: "This upload has expired. Choose the file again to start a new upload.",
  UPLOAD_OBJECT_MISSING: "The file upload did not finish. Retry the upload or choose the file again.",
  UPLOAD_FINALIZING: "This file is being checked. Wait a moment, then check again.",
  UPLOAD_BUSY: "Other files are being checked. Wait a moment and try again.",
  UPLOAD_STALE_FINALIZER: "The upload check was interrupted. Check again to recover its status.",
  UPLOAD_SIZE_MISMATCH: "The uploaded size does not match the selected file. Choose the file again.",
  UPLOAD_TYPE_MISMATCH: "The uploaded file type does not match. Choose a PDF or DOCX file.",
  UPLOAD_CHECKSUM_MISMATCH: "The uploaded bytes do not match the selected file. Choose the file again.",
  UPLOAD_INVALID_FORMAT: "This file is not a supported PDF or DOCX. Choose another file.",
  UPLOAD_STORAGE_UNAVAILABLE: "Upload storage is temporarily unavailable. Try again.",
  SOURCE_LINK_INVALID: "This document access link is invalid. Request a new link from the SOP library.",
  SOURCE_LINK_EXPIRED: "This document access link has expired. Request a new link from the SOP library.",
  SOURCE_OBJECT_MISSING: "The original SOP file is unavailable in storage.",
  INGESTION_TIMEOUT: "Document processing timed out. Retry processing.",
  NO_EXTRACTABLE_TEXT: "No readable text could be extracted from this file. Check the source file or retry.",
  DOCX_EXTRACTION_INVALID: "This DOCX file could not be extracted safely.",
  DOCX_CONVERSION_FAILED: "The DOCX preview could not be rendered.",
  DOCX_CONVERSION_TRANSIENT: "Document conversion is temporarily unavailable. Retry processing.",
  PDF_INSPECT_INVALID: "This PDF file could not be inspected.",
  PDF_EMPTY: "This PDF file contains no readable pages.",
  OCR_PAGE_FAILED: "OCR could not read one or more scanned pages.",
  OCR_WORKER_TRANSIENT: "OCR processing is temporarily unavailable. Retry processing.",
  EMBEDDING_PROVIDER_TRANSIENT: "Indexing is temporarily unavailable. Retry processing.",
  EMBEDDING_PROVIDER_REJECTED: "Indexing failed to generate embeddings for this document.",
};

export class DocumentRequestError extends Error {
  constructor(readonly code: string) { super(messages[code] ?? "This upload request is temporarily unavailable. Try again."); }
}

async function requestDocument(path: string, method: "GET" | "POST", signal: AbortSignal, body?: unknown) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(metadataTimeoutMilliseconds)]),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
    throw new DocumentRequestError(error.success ? error.data.error.code : "UPLOAD_UNAVAILABLE");
  }
  return payload;
}

export async function initializeUpload(body: unknown, signal: AbortSignal): Promise<UploadInitResponse> {
  return initSchema.parse(await requestDocument("/api/documents/upload-init", "POST", signal, body));
}
export async function processUpload(id: string, signal: AbortSignal): Promise<UploadStatusResponse> {
  return statusSchema.parse(await requestDocument(`/api/documents/${id}/process`, "POST", signal));
}
export async function readUpload(id: string, signal: AbortSignal): Promise<UploadStatusResponse> {
  return statusSchema.parse(await requestDocument(`/api/documents/${id}`, "GET", signal));
}
export async function listLibraryDocuments(
  query: { q?: string; limit?: number; cursor?: string },
  signal: AbortSignal,
): Promise<DocumentLibraryResponse> {
  const params = new URLSearchParams();
  if (query.q && query.q.trim().length > 0) params.set("q", query.q.trim());
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return libraryResponseSchema.parse(await requestDocument(`/api/documents${suffix}`, "GET", signal));
}
export async function requestDocumentSource(
  id: string,
  options: { disposition?: "inline" | "attachment"; page?: number | null; section?: string | null },
  signal: AbortSignal,
): Promise<DocumentSourceAuthorizationResponse> {
  const params = new URLSearchParams();
  params.set("disposition", options.disposition ?? "inline");
  if (options.page !== null && options.page !== undefined) params.set("page", String(options.page));
  if (options.section && options.section.trim().length > 0) params.set("section", options.section.trim());
  return sourceAuthorizationSchema.parse(
    await requestDocument(`/api/documents/${id}/source?${params.toString()}`, "GET", signal),
  );
}
export function uploadFailureMessage(document: DocumentUploadDto) {
  return new DocumentRequestError(document.failureCode ?? "UPLOAD_UNAVAILABLE").message;
}
export function processingFailureMessage(document: DocumentUploadDto) {
  const code = document.processingErrorCode ?? document.job?.errorCode;
  return code && messages[code] ? messages[code] : "Document processing did not finish. Retry processing.";
}
export function processingErrorCodeMessage(code: string | null | undefined) {
  return code && messages[code] ? messages[code] : "Document processing did not finish.";
}
