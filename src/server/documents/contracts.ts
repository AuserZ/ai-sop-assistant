import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readServerSecret } from "../auth/config";
import { AuthFailure } from "../auth/errors";

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
  cleanupLeaseSeconds: 45,
  cleanupBatchSize: 5,
  cleanupBackoffMaxSeconds: 60,
} as const;
export const ingestionPipelineVersion = "document-ingestion-v1";
export const documentMimeTypes = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] as const;
export const documentLifecycleStatuses = [
  "UPLOADED",
  "PROCESSING",
  "PENDING_VERIFICATION",
  "ACTIVE",
  "REJECTED",
  "FAILED",
  "DELETED",
] as const;
export const documentCleanupStates = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
] as const;
export const documentJobStates = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "WAITING_FOR_PIPELINE",
] as const;

export const sourceLinkTtlSeconds = 60;
export const documentLibraryBounds = {
  defaultLimit: 25,
  maximumLimit: 50,
  maximumQueryLength: 100,
  maximumCursorLength: 512,
  maximumSectionLength: 200,
  maximumPageNumber: 5_000,
  sourceLinkTtlSeconds,
} as const;

const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const sourceSigningInfo = "ai-sop-assistant:document-source-link:v1";

export const uploadInput = z.object({
  requestKey: z.uuid(),
  title: z.string().trim().min(1).max(200).refine((value) => !controlCharacterPattern.test(value)),
  fileName: z.string().min(1).max(200).refine((value) => !/[\\/\u0000-\u001f\u007f]/.test(value) && value !== "." && value !== ".."),
  mimeType: z.enum(documentMimeTypes),
  sizeBytes: z.number().int().positive().max(documentBounds.maximumFileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((value) => value.fileName.toLowerCase().endsWith(value.mimeType === "application/pdf" ? ".pdf" : ".docx"));
export const emptyDocumentBody = z.object({}).strict();
export const documentIdInput = z.uuid();
export type UploadInput = z.infer<typeof uploadInput>;
export type DocumentLifecycleStatus = typeof documentLifecycleStatuses[number];
export type DocumentCleanupState = typeof documentCleanupStates[number];
export type DocumentJobState = typeof documentJobStates[number];
export type DocumentCleanupDto = {
  state: DocumentCleanupState;
  attempts: number;
  errorCode: string | null;
  completedAt: string | null;
};
export type DocumentDeleteResponse = {
  deleted: true;
  created: boolean;
  document: {
    id: string;
    status: "DELETED";
    deletedAt: string;
    cleanup: DocumentCleanupDto;
  };
};
export type EligibleActiveChunkDto = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  fileName: string;
  jobId: string;
  pipelineVersion: string;
  sourceSha256: string;
  sequence: number;
  sectionPath: string;
  pageStart: number | null;
  pageEnd: number | null;
  contentType: "procedure" | "table" | "narrative" | "mixed";
  text: string;
  contentHash: string;
  tokenEstimate: number;
};
export type DocumentCitationAvailabilityDto =
  | {
      available: true;
      documentId: string;
      title: string;
      status: "ACTIVE";
    }
  | {
      available: false;
      documentId: string;
      reason: "UNAVAILABLE" | "DELETED";
    };
export function calculateCleanupBackoffSeconds(attempts: number): number {
  const normalized = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  if (normalized >= 6) return documentBounds.cleanupBackoffMaxSeconds;
  return Math.min(2 ** normalized, documentBounds.cleanupBackoffMaxSeconds);
}
export type DocumentProcessingSummary = {
  pageCount: number;
  chunkCount: number;
  issueCount: number;
  hasPreview: boolean;
};
export type DocumentUploadDto = {
  id: string;
  title: string;
  fileName: string;
  mimeType: typeof documentMimeTypes[number];
  sizeBytes: number;
  sha256: string;
  uploadStatus: "AWAITING_UPLOAD" | "FINALIZING" | "FAILED" | "ACCEPTED" | "EXPIRED";
  status: DocumentLifecycleStatus | null;
  failureCode: string | null;
  processingErrorCode: string | null;
  processedJobId: string | null;
  processedAttemptId?: string | null;
  activeJobId: string | null;
  activeAttemptId?: string | null;
  verifiedAt: string | null;
  rejectionReason: string | null;
  summary: DocumentProcessingSummary | null;
  job: {
    id: string;
    state: DocumentJobState;
    stage: string | null;
    attemptNumber: number;
    errorCode: string | null;
  } | null;
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

export function escapeIlikePattern(query: string): string {
  return query.replace(/[\\%_]/g, "\\$&");
}

const cursorPayloadSchema = z
  .object({
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/),
    id: z.uuid(),
  })
  .strict()
  .refine((value) => !Number.isNaN(Date.parse(value.createdAt)), "Invalid cursor timestamp.");

export type DocumentLibraryCursor = z.infer<typeof cursorPayloadSchema>;

export function encodeDocumentLibraryCursor(cursor: DocumentLibraryCursor): string {
  const parsed = cursorPayloadSchema.parse(cursor);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodeDocumentLibraryCursor(cursor: string): DocumentLibraryCursor | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(decoded));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const limitInputSchema = z.union([
  z.number().int().min(1).max(documentLibraryBounds.maximumLimit),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value))
    .pipe(z.number().int().min(1).max(documentLibraryBounds.maximumLimit)),
]);

export const listDocumentsQueryInput = z
  .object({
    q: z
      .string()
      .refine((value) => !controlCharacterPattern.test(value), "Search query cannot contain control characters.")
      .transform((value) => value.trim())
      .refine((value) => value.length <= documentLibraryBounds.maximumQueryLength, "Search query is too long.")
      .optional()
      .default(""),
    limit: limitInputSchema.optional().default(documentLibraryBounds.defaultLimit),
    cursor: z
      .string()
      .trim()
      .min(1)
      .max(documentLibraryBounds.maximumCursorLength)
      .refine((value) => !controlCharacterPattern.test(value) && decodeDocumentLibraryCursor(value) !== null, "Invalid cursor.")
      .optional(),
  })
  .strict();

export type ListDocumentsQueryInput = z.infer<typeof listDocumentsQueryInput>;

const pageInputSchema = z.union([
  z.number().int().min(1).max(documentLibraryBounds.maximumPageNumber),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value))
    .pipe(z.number().int().min(1).max(documentLibraryBounds.maximumPageNumber)),
]);

export const documentSourceQueryInput = z
  .object({
    disposition: z.enum(["inline", "attachment"]).optional().default("inline"),
    page: pageInputSchema.optional(),
    section: z
      .string()
      .refine((value) => !controlCharacterPattern.test(value), "Section cannot contain control characters.")
      .transform((value) => value.trim())
      .refine(
        (value) => value.length >= 1 && value.length <= documentLibraryBounds.maximumSectionLength,
        "Invalid section context.",
      )
      .optional(),
  })
  .strict();

export type DocumentSourceQueryInput = z.infer<typeof documentSourceQueryInput>;

export const documentSourceContentQueryInput = z
  .object({
    token: z.string().min(1).max(2048).refine((value) => !controlCharacterPattern.test(value)),
  })
  .strict();

export type DocumentLibraryDiagnosticsDto = {
  processingErrorCode: string | null;
  rejectionReason: string | null;
  latestJob: {
    id: string;
    state: DocumentJobState;
    stage: string | null;
    attemptNumber: number;
    errorCode: string | null;
  } | null;
  pageCount: number;
  chunkCount: number;
  issueCount: number;
  hasPreview: boolean;
  cleanup: DocumentCleanupDto | null;
};

export type DocumentLibraryItemDto = {
  id: string;
  title: string;
  fileName: string;
  mimeType: typeof documentMimeTypes[number];
  fileType: "PDF" | "DOCX";
  sizeBytes: number;
  uploaderName: string;
  uploadedAt: string;
  verifiedAt: string | null;
  deletedAt: string | null;
  status: DocumentLifecycleStatus;
  diagnostics: DocumentLibraryDiagnosticsDto | null;
};

export type DocumentLibraryResponse = {
  items: DocumentLibraryItemDto[];
  nextCursor: string | null;
};

export type DocumentSourceContextDto = {
  page: number | null;
  section: string | null;
};

export type DocumentSourceDto = {
  documentId: string;
  title: string;
  fileName: string;
  mimeType: typeof documentMimeTypes[number];
  disposition: "inline" | "attachment";
  url: string;
  expiresAt: string;
  ttlSeconds: typeof sourceLinkTtlSeconds;
  context: DocumentSourceContextDto;
};

export type DocumentSourceAuthorizationResponse = {
  source: DocumentSourceDto;
};

export const documentSourceTokenClaimsSchema = z
  .object({
    v: z.literal(1),
    documentId: z.uuid(),
    accountId: z.string().min(1).max(128).refine((value) => !controlCharacterPattern.test(value)),
    role: z.enum(["ADMIN", "STAFF"]),
    statusAtIssue: z.enum(documentLifecycleStatuses),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    disposition: z.enum(["inline", "attachment"]),
    page: z.number().int().min(1).max(documentLibraryBounds.maximumPageNumber).nullable(),
    section: z
      .string()
      .min(1)
      .max(documentLibraryBounds.maximumSectionLength)
      .refine((value) => !controlCharacterPattern.test(value))
      .nullable(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type DocumentSourceTokenClaims = z.infer<typeof documentSourceTokenClaimsSchema>;

export function deriveSourceSigningKey(authSecret = readServerSecret("AUTH_SECRET")): Buffer {
  if (authSecret.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters.");
  }
  return Buffer.from(hkdfSync("sha256", authSecret, "", sourceSigningInfo, 32));
}

export function signDocumentSourceToken(
  input: Omit<DocumentSourceTokenClaims, "v" | "iat" | "exp"> & { iat?: number; exp?: number },
  options?: { nowSeconds?: number; signingKey?: Buffer },
): { token: string; claims: DocumentSourceTokenClaims } {
  const iat = input.iat ?? options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = input.exp ?? iat + sourceLinkTtlSeconds;
  const claims = documentSourceTokenClaimsSchema.parse({
    v: 1,
    documentId: input.documentId,
    accountId: input.accountId,
    role: input.role,
    statusAtIssue: input.statusAtIssue,
    sha256: input.sha256,
    disposition: input.disposition,
    page: input.page ?? null,
    section: input.section ?? null,
    iat,
    exp,
  });
  const signingKey = options?.signingKey ?? deriveSourceSigningKey();
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey).update(encodedPayload, "utf8").digest("base64url");
  return { token: `${encodedPayload}.${signature}`, claims };
}

export function verifyDocumentSourceToken(
  token: string | null | undefined,
  expectedDocumentId: string,
  options?: { nowSeconds?: number; signingKey?: Buffer },
): DocumentSourceTokenClaims {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  const [encodedPayload, encodedSignature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(encodedPayload) || !/^[A-Za-z0-9_-]+$/.test(encodedSignature)) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  const signingKey = options?.signingKey ?? deriveSourceSigningKey();
  const expectedSignature = createHmac("sha256", signingKey).update(encodedPayload, "utf8").digest();
  const actualSignature = Buffer.from(encodedSignature, "base64url");
  if (
    actualSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  let rawClaims: unknown;
  try {
    rawClaims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  const parsed = documentSourceTokenClaimsSchema.safeParse(rawClaims);
  if (!parsed.success) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  const claims = parsed.data;
  if (
    claims.documentId !== expectedDocumentId ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > sourceLinkTtlSeconds
  ) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (claims.iat > nowSeconds + 5) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  if (nowSeconds >= claims.exp) {
    throw new AuthFailure("SOURCE_LINK_EXPIRED", 410);
  }
  return claims;
}

export function formatContentDisposition(
  disposition: "inline" | "attachment",
  fileName: string,
): string {
  const cleanedUtf8 =
    fileName
      .replace(/[\u0000-\u001f\u007f\\/]/g, "_")
      .trim() || "document";
  const asciiFallback =
    cleanedUtf8
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\;]/g, "_")
      .trim() || "document";
  const encodedUtf8 = encodeURIComponent(cleanedUtf8).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodedUtf8}`;
}
