import { z } from "zod";
import { approvedEmbeddingDimensions } from "./config";

export const ingestionLimits = {
  maxPdfPages: 100,
  maxDocxXmlBytes: 4_000_000,
  maxDocxStylesXmlBytes: 512_000,
  maxPreviewBytes: 30_000_000,
  maxRenderedPngBytes: 10_000_000,
  conversionTimeoutMilliseconds: 60_000,
  pdfInspectTimeoutMilliseconds: 60_000,
  pdfRenderTimeoutMilliseconds: 30_000,
  ocrTimeoutMilliseconds: 80_000,
  embeddingTimeoutMilliseconds: 30_000,
  embeddingBatchSize: 16,
  embeddingDimensions: approvedEmbeddingDimensions,
  ocrLowConfidenceThreshold: 0.85,
  mixedPageMinImagePixels: 40_000,
  blankPageMaxChars: 10,
  scannedPageMaxNativeChars: 25,
  chunkTargetMinTokens: 400,
  chunkTargetMaxTokens: 800,
  chunkPracticalMaxTokens: 1000,
  chunkOverlapRatio: 0.12,
} as const;

export class IngestionStageError extends Error {
  constructor(
    public readonly code: string,
    public readonly transient: boolean,
    public readonly status: number = transient ? 503 : 422,
  ) {
    super(code);
  }
}

export const emptyStageBody = z.object({}).strict();
export const extractStageBody = z.object({
  fileRefToken: z.string().min(16).max(4096),
}).strict();
export const failStageBody = z.object({
  errorCode: z.string().regex(/^[A-Z0-9_]{3,64}$/).default("INGESTION_STAGE_FAILED"),
  transient: z.boolean().default(false),
}).strict();

export const pdfInspectResponseSchema = z.object({
  result: z.literal("PASS"),
  pageCount: z.number().int().min(0).max(ingestionLimits.maxPdfPages),
  pages: z.array(z.object({
    pageIndex: z.number().int().min(1),
    nativeText: z.string(),
    imageCount: z.number().int().min(0),
    maxImagePixels: z.number().int().min(0),
  })),
});

const ocrSegmentSchema = z.object({
  order: z.number().int().min(0),
  text: z.string(),
  confidence: z.number().finite().min(0).max(1),
  box: z.array(z.array(z.number().finite()).length(2)).length(4),
});

export const paddleOcrPassSchema = z.object({
  result: z.literal("PASS"),
  pipelineVersion: z.string().min(1),
  verificationStatus: z.literal("UNVERIFIED"),
  input: z.object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  models: z.union([
    z.object({ detection: z.string().min(1), recognition: z.string().min(1) }),
    z.array(z.object({ name: z.string().min(1) })).min(1),
  ]),
  segmentCount: z.number().int().min(0),
  segments: z.array(ocrSegmentSchema),
  text: z.string(),
});

// Matches direct output from infra/paddleocr/server.py (engine.recognize).
export const paddleOcrEngineSchema = z.object({
  pipelineVersion: z.string().min(1),
  verificationStatus: z.literal("UNVERIFIED"),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  models: z.array(z.object({ name: z.string().min(1) })).min(1),
  segments: z.array(ocrSegmentSchema),
});

export const paddleOcrFailSchema = z.object({
  result: z.literal("FAIL"),
  code: z.string().min(1).max(64),
});

export const paddleOcrResponseSchema = z.union([
  paddleOcrPassSchema,
  paddleOcrEngineSchema,
  paddleOcrFailSchema,
]);

export const openaiEmbeddingResponseSchema = z.object({
  model: z.string().min(1).optional(),
  data: z.array(z.object({
    index: z.number().int().min(0),
    embedding: z.array(z.number()),
  })),
});

export type ExtractedBlockKind = "heading" | "paragraph" | "list_item" | "table";

export type ExtractedBlock = {
  kind: ExtractedBlockKind;
  text: string;
  headingLevel?: number;
  sectionPath: string;
  rows?: string[][];
};

export type ExtractedPageDraft = {
  pageIndex: number;
  pageKind: "native" | "scanned_ocr" | "mixed_ocr" | "blank" | "docx_section_flow";
  sourceLocationKind: "pdf_page" | "docx_derivative_preview";
  rawText: string;
  normalizedText: string;
  ocrConfidence: number | null;
  ocrModel: string | null;
  layoutMetadata: Record<string, unknown> | null;
  blocks?: ExtractedBlock[];
};

export type VerificationIssueDraft = {
  pageIndex: number | null;
  sectionPath: string | null;
  severity: "info" | "warning" | "error";
  issueCode: string;
  summary: string;
  region: Record<string, unknown> | null;
};

export type ChunkDraft = {
  sequence: number;
  sectionPath: string;
  pageStart: number | null;
  pageEnd: number | null;
  contentType: "procedure" | "table" | "narrative" | "mixed";
  text: string;
  contentHash: string;
  tokenEstimate: number;
};
