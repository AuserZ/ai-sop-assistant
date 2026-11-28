import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");

const pgVector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "public.vector(1536)";
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string) {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
    const inner = trimmed.slice(1, -1).trim();
    return inner ? inner.split(",").map(Number) : [];
  },
});

const pgTsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "tsvector";
  },
});

export const authUsers = appSchema.table("auth_users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text(),
  role: text().$type<"ADMIN" | "STAFF">().default("STAFF").notNull(),
  active: boolean().default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("auth_users_role", sql`${table.role} in ('ADMIN', 'STAFF')`),
  check("auth_users_email_normalized", sql`${table.email} = lower(btrim(${table.email}))`),
]);

export const authSessions = appSchema.table("auth_sessions", {
  id: text().primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("auth_sessions_user_id").on(table.userId)]);

export const authAccounts = appSchema.table("auth_accounts", {
  id: text().primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text(),
  password: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_accounts_provider_identity").on(table.providerId, table.accountId),
  index("auth_accounts_user_id").on(table.userId),
]);

export const authVerifications = appSchema.table("auth_verifications", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("auth_verifications_identifier").on(table.identifier)]);

export const authInvitations = appSchema.table("auth_invitations", {
  id: uuid().defaultRandom().primaryKey(),
  email: text().notNull(),
  role: text().$type<"ADMIN" | "STAFF">().notNull(),
  tokenDigest: text("token_digest").notNull().unique(),
  invitedBy: text("invited_by").notNull().references(() => authUsers.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("auth_invitations_role", sql`${table.role} in ('ADMIN', 'STAFF')`),
  check("auth_invitations_email_normalized", sql`${table.email} = lower(btrim(${table.email}))`),
]);

export const authRateLimits = appSchema.table("auth_rate_limits", {
  key: text().primaryKey(),
  attempts: integer().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("auth_rate_limits_expiry").on(table.expiresAt)]);

export const documentUploadIntents = appSchema.table("document_upload_intents", {
  id: uuid().defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => authUsers.id),
  requestKey: uuid("request_key").notNull(),
  inputHash: text("input_hash").notNull(),
  title: text().notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").$type<"application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document">().notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text().notNull(),
  stagingKey: text("staging_key").notNull().unique(),
  finalKey: text("final_key").notNull().unique(),
  reservedBytes: bigint("reserved_bytes", { mode: "number" }).notNull(),
  state: text().$type<"AWAITING_UPLOAD" | "FINALIZING" | "FAILED" | "ACCEPTED">().default("AWAITING_UPLOAD").notNull(),
  failureCode: text("failure_code"),
  uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  finalizeLeaseToken: uuid("finalize_lease_token"),
  finalizeLeaseUntil: timestamp("finalize_lease_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("document_upload_owner_request").on(table.ownerId, table.requestKey),
  check("document_upload_state", sql`${table.state} in ('AWAITING_UPLOAD','FINALIZING','FAILED','ACCEPTED')`),
  check("document_upload_bytes", sql`${table.sizeBytes} between 1 and 20000000 and ${table.reservedBytes} = 2::bigint * ${table.sizeBytes}`),
  check("document_upload_sha256", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  check("document_upload_mime", sql`${table.mimeType} in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')`),
]);

export const sopDocuments = appSchema.table("sop_documents", {
  id: uuid().primaryKey().references(() => documentUploadIntents.id),
  title: text().notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text().notNull(),
  originalKey: text("original_key").notNull().unique(),
  uploadedBy: text("uploaded_by").notNull().references(() => authUsers.id),
  status: text().$type<"UPLOADED" | "PROCESSING" | "PENDING_VERIFICATION" | "ACTIVE" | "REJECTED" | "FAILED" | "DELETED">().default("UPLOADED").notNull(),
  previewKey: text("preview_key").unique(),
  latestJobId: uuid("latest_job_id").references((): AnyPgColumn => workflowJobs.id),
  processedJobId: uuid("processed_job_id").references((): AnyPgColumn => workflowJobs.id),
  processedPipelineVersion: text("processed_pipeline_version"),
  processedAttemptId: uuid("processed_attempt_id"),
  activeJobId: uuid("active_job_id").references((): AnyPgColumn => workflowJobs.id),
  activePipelineVersion: text("active_pipeline_version"),
  activeAttemptId: uuid("active_attempt_id"),
  verifiedBy: text("verified_by").references(() => authUsers.id),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  processingErrorCode: text("processing_error_code"),
  deletedBy: text("deleted_by").references(() => authUsers.id),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  cleanupState: text("cleanup_state").$type<"PENDING" | "RUNNING" | "COMPLETED" | "FAILED">(),
  cleanupAttempts: integer("cleanup_attempts").default(0).notNull(),
  cleanupErrorCode: text("cleanup_error_code"),
  cleanupNextAt: timestamp("cleanup_next_at", { withTimezone: true }),
  cleanupLeaseToken: uuid("cleanup_lease_token"),
  cleanupLeaseUntil: timestamp("cleanup_lease_until", { withTimezone: true }),
  cleanupCompletedAt: timestamp("cleanup_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("sop_documents_status_verified").on(table.status, table.verifiedAt),
  index("sop_documents_cleanup_due").on(table.status, table.cleanupState, table.cleanupNextAt),
  check("sop_documents_status", sql`${table.status} in ('UPLOADED','PROCESSING','PENDING_VERIFICATION','ACTIVE','REJECTED','FAILED','DELETED')`),
  check("sop_documents_activation_binding", sql`(${table.status} = 'ACTIVE' and ${table.activeJobId} is not null and ${table.activePipelineVersion} is not null and ${table.activeAttemptId} is not null and ${table.processedJobId} = ${table.activeJobId} and ${table.processedPipelineVersion} = ${table.activePipelineVersion} and ${table.processedAttemptId} = ${table.activeAttemptId} and ${table.verifiedBy} is not null and ${table.verifiedAt} is not null and ${table.rejectionReason} is null) or (${table.status} <> 'ACTIVE' and ${table.activeJobId} is null and ${table.activePipelineVersion} is null and ${table.activeAttemptId} is null)`),
  check("sop_documents_rejection_binding", sql`(${table.status} = 'REJECTED' and ${table.verifiedBy} is not null and ${table.verifiedAt} is not null and ${table.rejectionReason} is not null and length(btrim(${table.rejectionReason})) > 0) or (${table.status} <> 'REJECTED' and ${table.rejectionReason} is null)`),
  check("sop_documents_cleanup_attempts", sql`${table.cleanupAttempts} >= 0`),
  check("sop_documents_deletion_binding", sql`(${table.status} = 'DELETED' and ${table.deletedBy} is not null and ${table.deletedAt} is not null and ${table.cleanupState} in ('PENDING','RUNNING','COMPLETED','FAILED') and ${table.activeJobId} is null and ${table.activePipelineVersion} is null and ${table.activeAttemptId} is null and ${table.rejectionReason} is null) or (${table.status} <> 'DELETED' and ${table.deletedBy} is null and ${table.deletedAt} is null and ${table.cleanupState} is null and ${table.cleanupErrorCode} is null and ${table.cleanupNextAt} is null and ${table.cleanupLeaseToken} is null and ${table.cleanupLeaseUntil} is null and ${table.cleanupCompletedAt} is null)`),
  check("sop_documents_sha256", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  check("sop_documents_bytes", sql`${table.sizeBytes} between 1 and 20000000`),
]);

export const workflowJobs = appSchema.table("workflow_jobs", {
  id: uuid().defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => authUsers.id),
  requestKey: uuid("request_key").notNull(),
  inputHash: text("input_hash").notNull(),
  kind: text().$type<"synthetic_probe" | "document_ingestion" | "chat_turn">().default("synthetic_probe").notNull(),
  scenario: text().$type<"success" | "validation_failure">(),
  documentId: uuid("document_id").references(() => sopDocuments.id),
  sourceSha256: text("source_sha256"),
  pipelineVersion: text("pipeline_version"),
  conversationId: uuid("conversation_id").references((): AnyPgColumn => chatConversations.id, { onDelete: "cascade" }),
  assistantMessageId: uuid("assistant_message_id").references((): AnyPgColumn => chatMessages.id, { onDelete: "set null" }),
  state: text().$type<"QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "WAITING_FOR_PIPELINE">().default("QUEUED").notNull(),
  stage: text(),
  errorCode: text("error_code"),
  errorRetryable: boolean("error_retryable"),
  attemptId: uuid("attempt_id").notNull(),
  attemptNumber: integer("attempt_number").default(1).notNull(),
  dispatchNonce: uuid("dispatch_nonce").notNull(),
  dispatchCount: integer("dispatch_count").default(0).notNull(),
  dispatchNextAt: timestamp("dispatch_next_at", { withTimezone: true }).defaultNow().notNull(),
  dispatchLeaseToken: uuid("dispatch_lease_token"),
  dispatchLeaseUntil: timestamp("dispatch_lease_until", { withTimezone: true }),
  dispatchAcceptedAt: timestamp("dispatch_accepted_at", { withTimezone: true }),
  attemptDeadline: timestamp("attempt_deadline", { withTimezone: true }),
  runLeaseUntil: timestamp("run_lease_until", { withTimezone: true }),
  executionId: text("execution_id"),
  step: integer().default(0).notNull(),
  eventSequence: integer("event_sequence").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("workflow_jobs_owner_request").on(table.ownerId, table.kind, table.requestKey),
  uniqueIndex("workflow_jobs_ingestion_identity").on(table.documentId, table.sourceSha256, table.pipelineVersion),
  index("workflow_jobs_dispatch_due").on(table.state, table.dispatchNextAt),
  check("workflow_jobs_kind", sql`${table.kind} in ('synthetic_probe','document_ingestion','chat_turn')`),
  check("workflow_jobs_state", sql`${table.state} in ('QUEUED','RUNNING','COMPLETED','FAILED','WAITING_FOR_PIPELINE')`),
  check("workflow_jobs_kind_state", sql`(${table.kind} = 'synthetic_probe' and ${table.scenario} in ('success','validation_failure') and ${table.scenario} is not null and ${table.attemptDeadline} is not null and ${table.state} <> 'WAITING_FOR_PIPELINE' and ${table.documentId} is null and ${table.sourceSha256} is null and ${table.pipelineVersion} is null and ${table.conversationId} is null and ${table.assistantMessageId} is null) or (${table.kind} = 'document_ingestion' and ${table.scenario} is null and ${table.documentId} is not null and ${table.sourceSha256} ~ '^[a-f0-9]{64}$' and ${table.sourceSha256} is not null and ${table.pipelineVersion} is not null and ${table.conversationId} is null and ${table.assistantMessageId} is null and ((${table.state} = 'WAITING_FOR_PIPELINE' and ${table.attemptDeadline} is null and ${table.dispatchCount} = 0 and ${table.dispatchLeaseToken} is null and ${table.dispatchLeaseUntil} is null and ${table.dispatchAcceptedAt} is null and ${table.runLeaseUntil} is null and ${table.executionId} is null and ${table.step} = 0 and ${table.attemptNumber} = 1) or (${table.state} in ('QUEUED','RUNNING','COMPLETED','FAILED') and ${table.attemptDeadline} is not null))) or (${table.kind} = 'chat_turn' and ${table.scenario} is null and ${table.documentId} is null and ${table.sourceSha256} is null and ${table.pipelineVersion} is null and ${table.conversationId} is not null and ${table.attemptDeadline} is not null and ${table.state} in ('QUEUED','RUNNING','COMPLETED','FAILED'))`),
  check("workflow_jobs_attempt_bounds", sql`${table.attemptNumber} between 1 and 3 and ${table.dispatchCount} between 0 and 3 and ${table.step} between 0 and 8`),
]);

export const sopExtractionPages = appSchema.table("sop_extraction_pages", {
  id: uuid().defaultRandom().primaryKey(),
  documentId: uuid("document_id").notNull().references(() => sopDocuments.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => workflowJobs.id, { onDelete: "cascade" }),
  sourceSha256: text("source_sha256").notNull(),
  pipelineVersion: text("pipeline_version").notNull(),
  pageIndex: integer("page_index").notNull(),
  pageKind: text("page_kind").$type<"native" | "scanned_ocr" | "mixed_ocr" | "blank" | "docx_section_flow">().notNull(),
  sourceLocationKind: text("source_location_kind").$type<"pdf_page" | "docx_derivative_preview">().notNull(),
  rawText: text("raw_text").notNull(),
  normalizedText: text("normalized_text").notNull(),
  ocrConfidence: real("ocr_confidence"),
  ocrModel: text("ocr_model"),
  layoutMetadata: jsonb("layout_metadata").$type<Record<string, unknown>>(),
  verificationStatus: text("verification_status").$type<"UNVERIFIED" | "APPROVED" | "REJECTED">().default("UNVERIFIED").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sop_extraction_pages_job_page").on(table.jobId, table.pageIndex),
  index("sop_extraction_pages_document_job").on(table.documentId, table.jobId),
  check("sop_extraction_pages_sha256", sql`${table.sourceSha256} ~ '^[a-f0-9]{64}$'`),
  check("sop_extraction_pages_index", sql`${table.pageIndex} >= 1`),
  check("sop_extraction_pages_kind", sql`${table.pageKind} in ('native','scanned_ocr','mixed_ocr','blank','docx_section_flow')`),
  check("sop_extraction_pages_location", sql`${table.sourceLocationKind} in ('pdf_page','docx_derivative_preview')`),
  check("sop_extraction_pages_confidence", sql`${table.ocrConfidence} is null or (${table.ocrConfidence} >= 0 and ${table.ocrConfidence} <= 1)`),
  check("sop_extraction_pages_unverified", sql`${table.verificationStatus} in ('UNVERIFIED','APPROVED','REJECTED')`),
]);

export const sopChunks = appSchema.table("sop_chunks", {
  id: uuid().defaultRandom().primaryKey(),
  documentId: uuid("document_id").notNull().references(() => sopDocuments.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => workflowJobs.id, { onDelete: "cascade" }),
  sourceSha256: text("source_sha256").notNull(),
  pipelineVersion: text("pipeline_version").notNull(),
  sequence: integer().notNull(),
  sectionPath: text("section_path").notNull(),
  pageStart: integer("page_start"),
  pageEnd: integer("page_end"),
  contentType: text("content_type").$type<"procedure" | "table" | "narrative" | "mixed">().notNull(),
  text: text().notNull(),
  contentHash: text("content_hash").notNull(),
  tokenEstimate: integer("token_estimate").notNull(),
  searchVector: pgTsvector("search_vector").generatedAlwaysAs((): SQL => sql`to_tsvector('simple', coalesce(section_path, '') || ' ' || text)`).notNull(),
  embedding: pgVector1536("embedding"),
  embeddingModel: text("embedding_model"),
  embeddingDimensions: integer("embedding_dimensions"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("sop_chunks_job_sequence").on(table.jobId, table.sequence),
  index("sop_chunks_search_vector").using("gin", table.searchVector),
  index("sop_chunks_document_job").on(table.documentId, table.jobId),
  check("sop_chunks_sha256", sql`${table.sourceSha256} ~ '^[a-f0-9]{64}$'`),
  check("sop_chunks_sequence", sql`${table.sequence} >= 0`),
  check("sop_chunks_pages", sql`(${table.pageStart} is null or ${table.pageStart} >= 1) and (${table.pageEnd} is null or (${table.pageStart} is not null and ${table.pageEnd} >= ${table.pageStart}))`),
  check("sop_chunks_content_type", sql`${table.contentType} in ('procedure','table','narrative','mixed')`),
  check("sop_chunks_text_nonempty", sql`length(btrim(${table.text})) > 0`),
  check("sop_chunks_content_hash", sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
  check("sop_chunks_token_estimate", sql`${table.tokenEstimate} > 0`),
  check("sop_chunks_embedding_dimensions", sql`${table.embeddingDimensions} is null or ${table.embeddingDimensions} = 1536`),
]);

export const sopVerificationIssues = appSchema.table("sop_verification_issues", {
  id: uuid().defaultRandom().primaryKey(),
  documentId: uuid("document_id").notNull().references(() => sopDocuments.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => workflowJobs.id, { onDelete: "cascade" }),
  pageIndex: integer("page_index"),
  sectionPath: text("section_path"),
  severity: text().$type<"info" | "warning" | "error">().notNull(),
  issueCode: text("issue_code").notNull(),
  summary: text().notNull(),
  region: jsonb().$type<Record<string, unknown>>(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: text("resolved_by").references(() => authUsers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("sop_verification_issues_document_job").on(table.documentId, table.jobId),
  check("sop_verification_issues_severity", sql`${table.severity} in ('info','warning','error')`),
]);

export type VerificationIssueSummary = {
  total: number;
  resolved: number;
  unresolved: number;
  bySeverity: { error: number; warning: number; info: number };
};

export const sopVerificationRecords = appSchema.table("sop_verification_records", {
  id: uuid().defaultRandom().primaryKey(),
  documentId: uuid("document_id").notNull().references(() => sopDocuments.id),
  sourceSha256: text("source_sha256").notNull(),
  jobId: uuid("job_id").notNull().references(() => workflowJobs.id),
  pipelineVersion: text("pipeline_version").notNull(),
  attemptId: uuid("attempt_id").notNull(),
  reviewerId: text("reviewer_id").notNull().references(() => authUsers.id),
  decision: text().$type<"APPROVED" | "REJECTED">().notNull(),
  notes: text(),
  issueSummary: jsonb("issue_summary").$type<VerificationIssueSummary>().notNull(),
  beforeStatus: text("before_status").$type<"PENDING_VERIFICATION">().notNull(),
  afterStatus: text("after_status").$type<"ACTIVE" | "REJECTED">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("sop_verification_records_document_created").on(table.documentId, table.createdAt),
  check("sop_verification_records_sha256", sql`${table.sourceSha256} ~ '^[a-f0-9]{64}$'`),
  check("sop_verification_records_decision", sql`${table.decision} in ('APPROVED','REJECTED')`),
  check("sop_verification_records_notes", sql`${table.decision} = 'APPROVED' or (${table.notes} is not null and length(btrim(${table.notes})) > 0)`),
  check("sop_verification_records_before_status", sql`${table.beforeStatus} = 'PENDING_VERIFICATION'`),
  check("sop_verification_records_transition", sql`(${table.decision} = 'APPROVED' and ${table.afterStatus} = 'ACTIVE') or (${table.decision} = 'REJECTED' and ${table.afterStatus} = 'REJECTED')`),
]);

export type ChatTurnTimings = {
  retrievalMs: number;
  generateMs: number;
  deterministicCheckMs: number;
  judgeMs: number;
  citationResolveMs: number;
  totalMs: number;
};

export type ChatTurnRetrievalArtifact = {
  originalQuestion: string;
  standaloneQuery: string;
  passages: Array<{
    chunkId: string;
    documentId: string;
    jobId: string;
    pipelineVersion: string;
    sourceSha256: string;
    contentHash: string;
    documentTitle: string;
    fileName: string;
    sequence: number;
    sectionPath: string;
    pageStart: number | null;
    pageEnd: number | null;
    contentType: "procedure" | "table" | "narrative" | "mixed";
    text: string;
    tokenEstimate: number;
    rerankScore: number;
    rrfScore: number;
    semanticRank: number | null;
    keywordRank: number | null;
  }>;
  retrievalMs: number;
  mode: "openai" | "synthetic_fixture";
  embeddingModel: string;
  rerankerModel: string;
  rewriteModel: string | null;
};

export type ChatTurnCandidateArtifact = {
  isProcedural: boolean;
  claims: Array<{
    text: string;
    stepNumber?: number | null;
    chunkIds: string[];
  }>;
  generateMs: number;
  answerModel: string;
};

export const chatConversations = appSchema.table("chat_conversations", {
  id: uuid().defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => authUsers.id),
  title: text().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("chat_conversations_owner_updated").on(table.ownerId, table.updatedAt.desc()),
  index("chat_conversations_owner_active_updated")
    .on(table.ownerId, table.updatedAt.desc(), table.id.desc())
    .where(sql`${table.archivedAt} is null`),
  check("chat_conversations_title_nonempty", sql`length(btrim(${table.title})) > 0`),
]);

export const chatMessages = appSchema.table("chat_messages", {
  id: uuid().defaultRandom().primaryKey(),
  conversationId: uuid("conversation_id").notNull().references(() => chatConversations.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => authUsers.id),
  role: text().$type<"user" | "assistant">().notNull(),
  content: text().notNull(),
  requestKey: uuid("request_key").notNull(),
  jobId: uuid("job_id").references((): AnyPgColumn => workflowJobs.id, { onDelete: "set null" }),
  validationStatus: text("validation_status").$type<"USER_INPUT" | "PASSED" | "NO_EVIDENCE">().notNull(),
  isProcedural: boolean("is_procedural").default(false).notNull(),
  timings: jsonb().$type<ChatTurnTimings | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("chat_messages_owner_request_role").on(table.ownerId, table.requestKey, table.role),
  index("chat_messages_conversation_created").on(table.conversationId, table.createdAt),
  check("chat_messages_role", sql`${table.role} in ('user','assistant')`),
  check("chat_messages_content_nonempty", sql`length(btrim(${table.content})) > 0`),
  check("chat_messages_validation_status", sql`(${table.role} = 'user' and ${table.validationStatus} = 'USER_INPUT' and ${table.isProcedural} = false) or (${table.role} = 'assistant' and ${table.validationStatus} in ('PASSED','NO_EVIDENCE'))`),
  check("chat_messages_no_evidence_exact", sql`${table.validationStatus} <> 'NO_EVIDENCE' or (${table.content} = 'No SOP found for this question' and ${table.isProcedural} = false)`),
]);

export const chatMessageSources = appSchema.table("chat_message_sources", {
  id: uuid().defaultRandom().primaryKey(),
  messageId: uuid("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").notNull().references(() => sopDocuments.id),
  chunkId: uuid("chunk_id").notNull(),
  sopTitle: text("sop_title").notNull(),
  sectionPath: text("section_path").notNull(),
  pageStart: integer("page_start"),
  pageEnd: integer("page_end"),
  citationOrder: integer("citation_order").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("chat_message_sources_message_chunk").on(table.messageId, table.chunkId),
  index("chat_message_sources_message_order").on(table.messageId, table.citationOrder),
  check("chat_message_sources_order", sql`${table.citationOrder} >= 0`),
  check("chat_message_sources_pages", sql`(${table.pageStart} is null or ${table.pageStart} >= 1) and (${table.pageEnd} is null or (${table.pageStart} is not null and ${table.pageEnd} >= ${table.pageStart}))`),
]);

export const chatTurnArtifacts = appSchema.table("chat_turn_artifacts", {
  jobId: uuid("job_id").primaryKey().references(() => workflowJobs.id, { onDelete: "cascade" }),
  attemptId: uuid("attempt_id").notNull(),
  questionText: text("question_text").notNull(),
  retrievalPayload: jsonb("retrieval_payload").$type<ChatTurnRetrievalArtifact | null>(),
  candidatePayload: jsonb("candidate_payload").$type<ChatTurnCandidateArtifact | null>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("chat_turn_artifacts_question_nonempty", sql`length(btrim(${table.questionText})) > 0`),
]);

export const workflowEvents = appSchema.table("workflow_events", {
  id: uuid().defaultRandom().primaryKey(),
  jobId: uuid("job_id").notNull().references(() => workflowJobs.id, { onDelete: "cascade" }),
  attemptId: uuid("attempt_id").notNull(),
  sequence: integer().notNull(),
  step: integer().notNull(),
  kind: text().$type<"accepted" | "started" | "processing" | "deterministic_pass" | "judge_stub_pass" | "synthetic_completed" | "failed" | "retrying" | "retrieving" | "reranking" | "generating" | "validating" | "completed" | "no_evidence">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("workflow_events_sequence").on(table.jobId, table.sequence),
  uniqueIndex("workflow_events_attempt_step").on(table.jobId, table.attemptId, table.step),
  check("workflow_events_kind", sql`${table.kind} in ('accepted','started','processing','deterministic_pass','judge_stub_pass','synthetic_completed','failed','retrying','retrieving','reranking','generating','validating','completed','no_evidence')`),
]);

export const workflowNonceReceipts = appSchema.table("workflow_nonce_receipts", {
  id: text().primaryKey(),
  jobId: uuid("job_id").notNull().references(() => workflowJobs.id, { onDelete: "cascade" }),
  attemptId: uuid("attempt_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("workflow_nonce_expiry").on(table.expiresAt)]);

export const auditEvents = appSchema.table("audit_events", {
  id: uuid().defaultRandom().primaryKey(),
  actorId: text("actor_id").notNull(),
  action: text().notNull(),
  targetId: text("target_id"),
  outcome: text().notNull(),
  metadata: jsonb().$type<Record<string, string | number | boolean | null>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
