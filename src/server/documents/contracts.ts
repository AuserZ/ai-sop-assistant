import { z } from "zod";

export const documentBounds = {
  maximumFileBytes: 20_000_000,
  uploadSeconds: 120,
  intentSeconds: 600,
  finalizeLeaseSeconds: 45,
  storageTimeoutMilliseconds: 30_000,
  maximumFinalizers: 2,
  maximumArchiveEntries: 2048,
  maximumArchiveExpandedBytes: 100_000_000,
  maximumContainerXmlBytes: 262_144,
} as const;
export const ingestionPipelineVersion = "document-ingestion-v1";
export const documentMimeTypes = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] as const;

export const uploadInput = z.object({
  requestKey: z.uuid(),
  title: z.string().trim().min(1).max(200).refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  fileName: z.string().min(1).max(200).refine((value) => !/[\\/\u0000-\u001f\u007f]/.test(value) && value !== "." && value !== ".."),
  mimeType: z.enum(documentMimeTypes),
  sizeBytes: z.number().int().positive().max(documentBounds.maximumFileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((value) => value.fileName.toLowerCase().endsWith(value.mimeType === "application/pdf" ? ".pdf" : ".docx"));
export const emptyDocumentBody = z.object({}).strict();
export const documentIdInput = z.uuid();
export type UploadInput = z.infer<typeof uploadInput>;
export type DocumentUploadDto = {
  id: string;
  title: string;
  fileName: string;
  mimeType: typeof documentMimeTypes[number];
  sizeBytes: number;
  sha256: string;
  uploadStatus: "AWAITING_UPLOAD" | "FINALIZING" | "FAILED" | "ACCEPTED" | "EXPIRED";
  status: "UPLOADED" | null;
  failureCode: string | null;
  job: { id: string; state: "WAITING_FOR_PIPELINE" } | null;
};
export type UploadAuthorization = {
  url: string;
  method: "PUT";
  headers: { "Content-Type": string; "If-None-Match": "*" };
  sizeBytes: number;
  expiresAt: string;
};
export type UploadStatusResponse = { document: DocumentUploadDto };
export type UploadInitResponse = UploadStatusResponse & { upload: UploadAuthorization | null };
