import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");

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
  status: text().$type<"UPLOADED">().default("UPLOADED").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("sop_documents_status", sql`${table.status} = 'UPLOADED'`),
  check("sop_documents_sha256", sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
  check("sop_documents_bytes", sql`${table.sizeBytes} between 1 and 20000000`),
]);

export const workflowJobs = appSchema.table("workflow_jobs", {
  id: uuid().defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => authUsers.id),
  requestKey: uuid("request_key").notNull(),
  inputHash: text("input_hash").notNull(),
  kind: text().$type<"synthetic_probe" | "document_ingestion">().default("synthetic_probe").notNull(),
  scenario: text().$type<"success" | "validation_failure">(),
  documentId: uuid("document_id").references(() => sopDocuments.id),
  sourceSha256: text("source_sha256"),
  pipelineVersion: text("pipeline_version"),
  state: text().$type<"QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "WAITING_FOR_PIPELINE">().default("QUEUED").notNull(),
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
  check("workflow_jobs_kind", sql`${table.kind} in ('synthetic_probe','document_ingestion')`),
  check("workflow_jobs_state", sql`${table.state} in ('QUEUED','RUNNING','COMPLETED','FAILED','WAITING_FOR_PIPELINE')`),
  check("workflow_jobs_kind_state", sql`(${table.kind} = 'synthetic_probe' and ${table.scenario} in ('success','validation_failure') and ${table.scenario} is not null and ${table.attemptDeadline} is not null and ${table.state} <> 'WAITING_FOR_PIPELINE' and ${table.documentId} is null and ${table.sourceSha256} is null and ${table.pipelineVersion} is null) or (${table.kind} = 'document_ingestion' and ${table.scenario} is null and ${table.documentId} is not null and ${table.sourceSha256} ~ '^[a-f0-9]{64}$' and ${table.sourceSha256} is not null and ${table.pipelineVersion} is not null and ${table.state} = 'WAITING_FOR_PIPELINE' and ${table.attemptDeadline} is null and ${table.dispatchCount} = 0 and ${table.dispatchLeaseToken} is null and ${table.dispatchLeaseUntil} is null and ${table.dispatchAcceptedAt} is null and ${table.runLeaseUntil} is null and ${table.executionId} is null and ${table.step} = 0 and ${table.attemptNumber} = 1)`),
  check("workflow_jobs_attempt_bounds", sql`${table.attemptNumber} between 1 and 3 and ${table.dispatchCount} between 0 and 3 and ${table.step} between 0 and 5`),
]);

export const workflowEvents = appSchema.table("workflow_events", {
  id: uuid().defaultRandom().primaryKey(),
  jobId: uuid("job_id").notNull().references(() => workflowJobs.id, { onDelete: "cascade" }),
  attemptId: uuid("attempt_id").notNull(),
  sequence: integer().notNull(),
  step: integer().notNull(),
  kind: text().$type<"accepted" | "started" | "processing" | "deterministic_pass" | "judge_stub_pass" | "synthetic_completed" | "failed" | "retrying">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("workflow_events_sequence").on(table.jobId, table.sequence),
  uniqueIndex("workflow_events_attempt_step").on(table.jobId, table.attemptId, table.step),
  check("workflow_events_kind", sql`${table.kind} in ('accepted','started','processing','deterministic_pass','judge_stub_pass','synthetic_completed','failed','retrying')`),
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
  metadata: jsonb().$type<Record<string, string | number | boolean>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
