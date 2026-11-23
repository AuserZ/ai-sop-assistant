import { z } from "zod";
import type {
  DocumentReviewDto,
  ReprocessDocumentInput,
  VerificationMutationResponse,
  VerifyDocumentInput,
} from "@/server/verification/contracts";

const requestTimeoutMilliseconds = 30_000;

const issueSummarySchema = z.object({
  total: z.number().int().min(0),
  resolved: z.number().int().min(0),
  unresolved: z.number().int().min(0),
  bySeverity: z.object({
    error: z.number().int().min(0),
    warning: z.number().int().min(0),
    info: z.number().int().min(0),
  }),
});

const verificationRecordSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  jobId: z.uuid(),
  pipelineVersion: z.string(),
  attemptId: z.uuid(),
  reviewerId: z.string(),
  reviewerName: z.string(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  notes: z.string().nullable(),
  issueSummary: issueSummarySchema,
  beforeStatus: z.literal("PENDING_VERIFICATION"),
  afterStatus: z.enum(["ACTIVE", "REJECTED"]),
  createdAt: z.string().datetime(),
});

const reviewSchema = z.object({
  document: z.object({
    id: z.uuid(),
    title: z.string(),
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["UPLOADED", "PROCESSING", "PENDING_VERIFICATION", "ACTIVE", "REJECTED", "FAILED"]),
    latestJobId: z.uuid().nullable(),
    processedJobId: z.uuid().nullable(),
    processedPipelineVersion: z.string().nullable(),
    processedAttemptId: z.uuid().nullable(),
    activeJobId: z.uuid().nullable(),
    activePipelineVersion: z.string().nullable(),
    activeAttemptId: z.uuid().nullable(),
    verifiedBy: z.string().nullable(),
    verifiedByName: z.string().nullable(),
    verifiedAt: z.string().datetime().nullable(),
    rejectionReason: z.string().nullable(),
    processingErrorCode: z.string().nullable(),
    hasPreview: z.boolean(),
    previewUrl: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }),
  pages: z.array(
    z.object({
      id: z.uuid(),
      pageIndex: z.number().int().min(1),
      pageKind: z.enum(["native", "scanned_ocr", "mixed_ocr", "blank", "docx_section_flow"]),
      sourceLocationKind: z.enum(["pdf_page", "docx_derivative_preview"]),
      normalizedText: z.string(),
      ocrConfidence: z.number().nullable(),
      ocrModel: z.string().nullable(),
      verificationStatus: z.enum(["UNVERIFIED", "APPROVED", "REJECTED"]),
    }),
  ),
  chunks: z.array(
    z.object({
      id: z.uuid(),
      sequence: z.number().int().min(0),
      sectionPath: z.string(),
      pageStart: z.number().int().min(1).nullable(),
      pageEnd: z.number().int().min(1).nullable(),
      contentType: z.enum(["procedure", "table", "narrative", "mixed"]),
      text: z.string(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      tokenEstimate: z.number().int().positive(),
      hasEmbedding: z.boolean(),
      embeddingModel: z.string().nullable(),
    }),
  ),
  issues: z.array(
    z.object({
      id: z.uuid(),
      pageIndex: z.number().int().min(1).nullable(),
      sectionPath: z.string().nullable(),
      severity: z.enum(["info", "warning", "error"]),
      issueCode: z.string(),
      summary: z.string(),
      resolvedAt: z.string().datetime().nullable(),
      resolvedBy: z.string().nullable(),
    }),
  ),
  verificationHistory: z.array(verificationRecordSchema),
});

const mutationSchema = reviewSchema.extend({
  record: verificationRecordSchema,
});

const verificationErrorMessages: Record<string, string> = {
  UNAUTHENTICATED: "Sign in again to continue.",
  FORBIDDEN: "Only Admins can verify SOPs.",
  NOT_FOUND: "This SOP document was not found.",
  INVALID_INPUT: "Complete the required confirmation and notes before submitting.",
  RATE_LIMITED: "Too many verification requests. Wait a moment and try again.",
  VERIFICATION_STATE_CONFLICT: "This document is no longer waiting for verification. Refresh to view its latest state.",
  VERIFICATION_STALE_SNAPSHOT: "This document snapshot changed while you were reviewing. Refresh before deciding.",
  VERIFICATION_INCOMPLETE_ARTIFACTS: "Extracted pages, chunks, or embeddings are incomplete. Reprocess before activating.",
  DOCUMENT_ALREADY_ACTIVE: "This SOP is already ACTIVE and cannot be modified in place.",
  DOCUMENT_ALREADY_PROCESSING: "This SOP is already queued or processing.",
  PREVIEW_NOT_AVAILABLE: "No PDF preview is currently available for this document.",
};

export function verificationErrorMessage(code: string) {
  return verificationErrorMessages[code] ?? "Verification service is temporarily unavailable. Try again.";
}

export class VerificationRequestError extends Error {
  constructor(readonly code: string) {
    super(verificationErrorMessage(code));
  }
}

async function requestVerification(
  path: string,
  method: "GET" | "POST",
  signal: AbortSignal,
  body?: unknown,
) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMilliseconds)]),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
    throw new VerificationRequestError(parsedError.success ? parsedError.data.error.code : "SERVICE_UNAVAILABLE");
  }
  return payload;
}

export async function fetchDocumentReview(id: string, signal: AbortSignal): Promise<DocumentReviewDto> {
  return reviewSchema.parse(await requestVerification(`/api/documents/${id}/review`, "GET", signal));
}

export async function submitVerificationDecision(
  id: string,
  body: VerifyDocumentInput,
  signal: AbortSignal,
): Promise<VerificationMutationResponse> {
  return mutationSchema.parse(await requestVerification(`/api/documents/${id}/verify`, "POST", signal, body));
}

export async function requestDocumentReprocess(
  id: string,
  body: ReprocessDocumentInput,
  signal: AbortSignal,
): Promise<DocumentReviewDto> {
  return reviewSchema.parse(await requestVerification(`/api/documents/${id}/reprocess`, "POST", signal, body));
}
