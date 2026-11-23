import { z } from "zod";
import type { DocumentLifecycleStatus } from "../documents/contracts";
import type { VerificationIssueSummary } from "../db/schema";

const controlCharacterPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const safeNotesSchema = z
  .string()
  .max(2000)
  .refine((value) => !controlCharacterPattern.test(value), "Notes cannot contain control characters.")
  .optional();

export const verifyDocumentInput = z
  .object({
    decision: z.enum(["APPROVE", "REJECT"]),
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    expectedJobId: z.uuid(),
    expectedPipelineVersion: z.string().trim().min(1).max(64),
    expectedAttemptId: z.uuid(),
    explicitConfirmation: z.literal(true),
    notes: safeNotesSchema,
    resolvedIssueIds: z.array(z.uuid()).max(200).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "REJECT" && (!value.notes || value.notes.trim().length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["notes"],
        message: "Rejection requires an explanation note.",
      });
    }
  });

export const reprocessDocumentInput = z
  .object({
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
    notes: safeNotesSchema,
  })
  .strict();

export type VerifyDocumentInput = z.infer<typeof verifyDocumentInput>;
export type ReprocessDocumentInput = z.infer<typeof reprocessDocumentInput>;

export type ReviewPageDto = {
  id: string;
  pageIndex: number;
  pageKind: "native" | "scanned_ocr" | "mixed_ocr" | "blank" | "docx_section_flow";
  sourceLocationKind: "pdf_page" | "docx_derivative_preview";
  normalizedText: string;
  ocrConfidence: number | null;
  ocrModel: string | null;
  verificationStatus: "UNVERIFIED" | "APPROVED" | "REJECTED";
};

export type ReviewChunkDto = {
  id: string;
  sequence: number;
  sectionPath: string;
  pageStart: number | null;
  pageEnd: number | null;
  contentType: "procedure" | "table" | "narrative" | "mixed";
  text: string;
  contentHash: string;
  tokenEstimate: number;
  hasEmbedding: boolean;
  embeddingModel: string | null;
};

export type ReviewIssueDto = {
  id: string;
  pageIndex: number | null;
  sectionPath: string | null;
  severity: "info" | "warning" | "error";
  issueCode: string;
  summary: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
};

export type VerificationRecordDto = {
  id: string;
  documentId: string;
  sourceSha256: string;
  jobId: string;
  pipelineVersion: string;
  attemptId: string;
  reviewerId: string;
  reviewerName: string;
  decision: "APPROVED" | "REJECTED";
  notes: string | null;
  issueSummary: VerificationIssueSummary;
  beforeStatus: "PENDING_VERIFICATION";
  afterStatus: "ACTIVE" | "REJECTED";
  createdAt: string;
};

export type ReviewDocumentDto = {
  id: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  status: DocumentLifecycleStatus;
  latestJobId: string | null;
  processedJobId: string | null;
  processedPipelineVersion: string | null;
  processedAttemptId: string | null;
  activeJobId: string | null;
  activePipelineVersion: string | null;
  activeAttemptId: string | null;
  verifiedBy: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  processingErrorCode: string | null;
  hasPreview: boolean;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DocumentReviewDto = {
  document: ReviewDocumentDto;
  pages: ReviewPageDto[];
  chunks: ReviewChunkDto[];
  issues: ReviewIssueDto[];
  verificationHistory: VerificationRecordDto[];
};

export type VerificationMutationResponse = DocumentReviewDto & {
  record: VerificationRecordDto;
};

// Matches numeric values, temperatures, pressures, durations, percentages and scientific units for visual review emphasis.
const suspiciousQuantityPattern =
  /\b\d+(?:[.,]\d+)?(?:\s?(?:%|°\s?[CF]|C|F|bar|mbar|kPa|MPa|psi|rpm|Hz|kHz|MHz|V|mV|kV|A|mA|W|kW|mg|g|kg|ug|µg|mL|ml|L|l|mm|cm|m|in|ft|sec|s|min|mins|minutes|hr|hrs|hours|days))\b|\b\d+[.,]\d+\b/gi;

export type HighlightSegment = {
  text: string;
  kind: "plain" | "quantity" | "search";
};

export function splitReviewHighlights(text: string, searchQuery = ""): HighlightSegment[] {
  if (!text) return [];
  const trimmedQuery = searchQuery.trim();
  const spans: Array<{ start: number; end: number; kind: "quantity" | "search" }> = [];

  if (trimmedQuery) {
    const lowerText = text.toLowerCase();
    const lowerQuery = trimmedQuery.toLowerCase();
    let offset = 0;
    while (offset < lowerText.length) {
      const index = lowerText.indexOf(lowerQuery, offset);
      if (index === -1) break;
      spans.push({ start: index, end: index + lowerQuery.length, kind: "search" });
      offset = index + lowerQuery.length;
    }
  }

  for (const match of text.matchAll(suspiciousQuantityPattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const overlapsSearch = spans.some((span) => span.kind === "search" && start < span.end && end > span.start);
    if (!overlapsSearch && end > start) {
      spans.push({ start, end, kind: "quantity" });
    }
  }

  if (spans.length === 0) return [{ text, kind: "plain" }];
  spans.sort((left, right) => left.start - right.start || right.end - left.end);

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), kind: "plain" });
    }
    segments.push({ text: text.slice(span.start, span.end), kind: span.kind });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), kind: "plain" });
  }
  return segments;
}
