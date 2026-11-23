import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import {
  auditEvents,
  documentUploadIntents,
  sopChunks,
  sopDocuments,
  sopExtractionPages,
  sopVerificationIssues,
  workflowJobs,
} from "../db/schema";
import { lockCurrentAdmin, type CurrentAccount } from "../auth/authorization";
import { AuthFailure } from "../auth/errors";
import type { AuthDatabase } from "../auth/rate-limit";
import { ingestionBounds } from "../jobs/contracts";
import { appendEvent } from "../jobs/service";
import { documentQuotaBytes } from "./config";
import { documentBounds, ingestionPipelineVersion, uploadInput, type DocumentUploadDto } from "./contracts";
import { validateDocumentObject } from "./format";
import { getDocumentStorage, type DocumentStorage } from "./storage";

type UploadIntent = typeof documentUploadIntents.$inferSelect;
type Transaction = Parameters<Parameters<AuthDatabase["transaction"]>[0]>[0];
let activeFinalizers = 0;

async function ownedIntent(transaction: Transaction, account: CurrentAccount, id: string) {
  await lockCurrentAdmin(account, transaction);
  const [intent] = await transaction.select({ intent: documentUploadIntents,
    expired: sql<boolean>`${documentUploadIntents.expiresAt} <= clock_timestamp()`,
    leaseActive: sql<boolean>`coalesce(${documentUploadIntents.finalizeLeaseUntil} > clock_timestamp(), false)`,
  }).from(documentUploadIntents).where(and(eq(documentUploadIntents.id, id), eq(documentUploadIntents.ownerId, account.id))).for("update");
  if (!intent) throw new AuthFailure("NOT_FOUND", 404);
  return intent;
}

async function documentDto(transaction: Transaction, intent: UploadIntent, expired = false, leaseActive = true): Promise<DocumentUploadDto> {
  const accepted = intent.state === "ACCEPTED";
  const [doc] = accepted
    ? await transaction
        .select({
          status: sopDocuments.status,
          previewKey: sopDocuments.previewKey,
          processingErrorCode: sopDocuments.processingErrorCode,
          processedJobId: sopDocuments.processedJobId,
          processedAttemptId: sopDocuments.processedAttemptId,
          activeJobId: sopDocuments.activeJobId,
          activeAttemptId: sopDocuments.activeAttemptId,
          verifiedAt: sopDocuments.verifiedAt,
          rejectionReason: sopDocuments.rejectionReason,
        })
        .from(sopDocuments)
        .where(eq(sopDocuments.id, intent.id))
    : [];
  const [job] = accepted
    ? await transaction
        .select({
          id: workflowJobs.id,
          state: workflowJobs.state,
          stage: workflowJobs.stage,
          attemptNumber: workflowJobs.attemptNumber,
          errorCode: workflowJobs.errorCode,
        })
        .from(workflowJobs)
        .where(
          and(
            eq(workflowJobs.documentId, intent.id),
            eq(workflowJobs.kind, "document_ingestion"),
            eq(workflowJobs.sourceSha256, intent.sha256),
            eq(workflowJobs.pipelineVersion, ingestionPipelineVersion),
          ),
        )
    : [];
  if (accepted && (!job || !doc)) throw new Error("Accepted document job missing.");

  let summary: DocumentUploadDto["summary"] = null;
  if (
    accepted &&
    doc &&
    job &&
    (doc.status === "PENDING_VERIFICATION" || doc.status === "ACTIVE" || doc.status === "REJECTED")
  ) {
    const [pageSummary] = await transaction
      .select({ total: count() })
      .from(sopExtractionPages)
      .where(eq(sopExtractionPages.jobId, job.id));
    const [chunkSummary] = await transaction
      .select({ total: count() })
      .from(sopChunks)
      .where(eq(sopChunks.jobId, job.id));
    const [issueSummary] = await transaction
      .select({ total: count() })
      .from(sopVerificationIssues)
      .where(eq(sopVerificationIssues.jobId, job.id));
    summary = {
      pageCount: pageSummary.total,
      chunkCount: chunkSummary.total,
      issueCount: issueSummary.total,
      hasPreview: Boolean(doc.previewKey),
    };
  }

  const uploadStatus = accepted ? "ACCEPTED" : expired ? "EXPIRED" : intent.state === "FINALIZING" && !leaseActive ? "FAILED" : intent.state;
  return {
    id: intent.id,
    title: intent.title,
    fileName: intent.fileName,
    mimeType: intent.mimeType,
    sizeBytes: intent.sizeBytes,
    sha256: intent.sha256,
    uploadStatus,
    status: accepted && doc ? doc.status : null,
    failureCode: expired && !accepted ? "UPLOAD_EXPIRED" : uploadStatus === "FAILED" ? intent.failureCode ?? "UPLOAD_RETRY_REQUIRED" : null,
    processingErrorCode: accepted && doc ? doc.processingErrorCode : null,
    processedJobId: accepted && doc ? (doc.processedJobId ?? null) : null,
    processedAttemptId: accepted && doc ? (doc.processedAttemptId ?? null) : null,
    activeJobId: accepted && doc ? (doc.activeJobId ?? null) : null,
    activeAttemptId: accepted && doc ? (doc.activeAttemptId ?? null) : null,
    verifiedAt: accepted && doc?.verifiedAt ? doc.verifiedAt.toISOString() : null,
    rejectionReason: accepted && doc ? (doc.rejectionReason ?? null) : null,
    summary,
    job: job
      ? {
          id: job.id,
          state: job.state,
          stage: job.stage,
          attemptNumber: job.attemptNumber,
          errorCode: job.errorCode,
        }
      : null,
  };
}

export async function initializeDocumentUpload(account: CurrentAccount, input: unknown,
  database: AuthDatabase = getDatabase(), storage: DocumentStorage = getDocumentStorage(), quotaBytes = documentQuotaBytes()) {
  const parsed = uploadInput.safeParse(input);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 1) throw new Error("Invalid upload quota.");
  const metadata = parsed.data;
  const inputHash = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
  const result = await database.transaction(async (transaction) => {
    await lockCurrentAdmin(account, transaction);
    // Serializes aggregate reservations across accounts and application instances.
    await transaction.execute(sql`select pg_advisory_xact_lock(7480401)`);
    const [existing] = await transaction.select().from(documentUploadIntents).where(and(
      eq(documentUploadIntents.ownerId, account.id), eq(documentUploadIntents.requestKey, metadata.requestKey),
    ));
    if (existing) {
      if (existing.inputHash !== inputHash) throw new AuthFailure("IDEMPOTENCY_CONFLICT", 409);
      const owned = await ownedIntent(transaction, account, existing.id);
      return { intent: owned.intent, document: await documentDto(transaction, owned.intent, owned.expired, owned.leaseActive), created: false };
    }
    const reservedBytes = metadata.sizeBytes * 2;
    const [capacity] = await transaction.select({ fits: sql<boolean>`coalesce(sum(${documentUploadIntents.reservedBytes}), 0) + ${reservedBytes} <= ${quotaBytes}` }).from(documentUploadIntents);
    if (!capacity.fits) throw new AuthFailure("UPLOAD_QUOTA_EXCEEDED", 409);
    const id = randomUUID();
    const [intent] = await transaction.insert(documentUploadIntents).values({
      ...metadata, id, ownerId: account.id, inputHash, reservedBytes,
      stagingKey: `staging/${id}/${randomUUID()}`, finalKey: `originals/${id}/${randomUUID()}`,
      uploadExpiresAt: sql`clock_timestamp() + ${documentBounds.uploadSeconds} * interval '1 second'`,
      expiresAt: sql`clock_timestamp() + ${documentBounds.intentSeconds} * interval '1 second'`,
    }).returning();
    await transaction.insert(auditEvents).values({ actorId: account.id, action: "document.upload_initialized", targetId: id,
      outcome: "reserved", metadata: { sizeBytes: metadata.sizeBytes } });
    return { intent, document: await documentDto(transaction, intent), created: true };
  });
  const canUpload = result.document.uploadStatus !== "ACCEPTED" && result.document.uploadStatus !== "EXPIRED" &&
    result.document.uploadStatus !== "FINALIZING" && result.intent.uploadExpiresAt.getTime() > Date.now() + 1000;
  return { document: result.document, upload: canUpload ? await storage.authorizeUpload(result.intent) : null, created: result.created };
}

export async function getDocumentUploadStatus(account: CurrentAccount, id: string, database: AuthDatabase = getDatabase()) {
  return database.transaction(async (transaction) => {
    const { intent, expired, leaseActive } = await ownedIntent(transaction, account, id);
    return { document: await documentDto(transaction, intent, expired, leaseActive) };
  });
}

async function sealOriginal(intent: UploadIntent, storage: DocumentStorage, signal: AbortSignal) {
  const existing = await storage.read(intent.finalKey, intent.sizeBytes, signal);
  if (existing) { await validateDocumentObject(existing, intent, signal); return; }
  const staged = await storage.read(intent.stagingKey, intent.sizeBytes, signal);
  if (!staged) throw new AuthFailure("UPLOAD_OBJECT_MISSING", 409);
  await validateDocumentObject(staged, intent, signal);
  signal.throwIfAborted();
  try { await storage.create(intent.finalKey, staged, signal); }
  catch (error) {
    signal.throwIfAborted();
    const written = await storage.read(intent.finalKey, intent.sizeBytes, signal);
    if (!written) throw error;
    await validateDocumentObject(written, intent, signal);
  }
}

export async function finalizeDocumentUpload(account: CurrentAccount, id: string,
  database: AuthDatabase = getDatabase(), storage: DocumentStorage = getDocumentStorage()) {
  if (activeFinalizers >= documentBounds.maximumFinalizers) throw new AuthFailure("UPLOAD_BUSY", 503);
  activeFinalizers++;
  let intent: UploadIntent | undefined;
  let fence: string | undefined;
  try {
    const claim = await database.transaction(async (transaction) => {
      const owned = await ownedIntent(transaction, account, id);
      if (owned.intent.state === "ACCEPTED") {
        const [job] = await transaction
          .select()
          .from(workflowJobs)
          .where(
            and(
              eq(workflowJobs.documentId, id),
              eq(workflowJobs.kind, "document_ingestion"),
              eq(workflowJobs.sourceSha256, owned.intent.sha256),
              eq(workflowJobs.pipelineVersion, ingestionPipelineVersion),
            ),
          )
          .for("update");
        const [doc] = await transaction
          .select({ status: sopDocuments.status })
          .from(sopDocuments)
          .where(eq(sopDocuments.id, id))
          .for("update");
        if (doc && doc.status !== "ACTIVE" && job && (job.state === "FAILED" || job.state === "WAITING_FOR_PIPELINE")) {
          await transaction.delete(sopChunks).where(eq(sopChunks.jobId, job.id));
          await transaction.delete(sopExtractionPages).where(eq(sopExtractionPages.jobId, job.id));
          await transaction.delete(sopVerificationIssues).where(eq(sopVerificationIssues.jobId, job.id));
          const [requeued] = await transaction
            .update(workflowJobs)
            .set({
              state: "QUEUED",
              stage: null,
              errorCode: null,
              attemptId: randomUUID(),
              attemptNumber: 1,
              dispatchNonce: randomUUID(),
              dispatchCount: 0,
              dispatchNextAt: sql`clock_timestamp()`,
              dispatchLeaseToken: null,
              dispatchLeaseUntil: null,
              dispatchAcceptedAt: null,
              runLeaseUntil: null,
              executionId: null,
              step: 0,
              attemptDeadline: sql`clock_timestamp() + ${ingestionBounds.attemptMilliseconds} * interval '1 millisecond'`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(workflowJobs.id, job.id))
            .returning();
          await appendEvent(transaction, requeued, "accepted", 0);
          await transaction
            .update(sopDocuments)
            .set({
              status: "UPLOADED",
              latestJobId: job.id,
              processingErrorCode: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(eq(sopDocuments.id, id));
          await transaction.insert(auditEvents).values({
            actorId: account.id,
            action: "document.ingestion_requeued",
            targetId: id,
            outcome: "queued",
            metadata: { jobId: job.id, previousState: job.state },
          });
        }
        return { document: await documentDto(transaction, owned.intent) };
      }
      if (owned.expired) throw new AuthFailure("UPLOAD_EXPIRED", 410);
      if (owned.leaseActive) throw new AuthFailure("UPLOAD_FINALIZING", 409);
      const token = randomUUID();
      const [leased] = await transaction.update(documentUploadIntents).set({ state: "FINALIZING", failureCode: null,
        finalizeLeaseToken: token, finalizeLeaseUntil: sql`clock_timestamp() + ${documentBounds.finalizeLeaseSeconds} * interval '1 second'`,
      }).where(eq(documentUploadIntents.id, id)).returning();
      return { intent: leased, fence: token };
    });
    if (claim.document) return { document: claim.document, created: false };
    intent = claim.intent!;
    fence = claim.fence!;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AuthFailure("UPLOAD_STORAGE_UNAVAILABLE", 503)); }, documentBounds.storageTimeoutMilliseconds);
        timer.unref();
      });
      await Promise.race([sealOriginal(intent, storage, controller.signal), deadline]);
    } finally { if (timer) clearTimeout(timer); }
    return await database.transaction(async (transaction) => {
      await lockCurrentAdmin(account, transaction);
      const [live] = await transaction.select().from(documentUploadIntents).where(and(
        eq(documentUploadIntents.id, id), eq(documentUploadIntents.finalizeLeaseToken, fence!),
        gt(documentUploadIntents.finalizeLeaseUntil, sql`clock_timestamp()`), gt(documentUploadIntents.expiresAt, sql`clock_timestamp()`),
        eq(documentUploadIntents.state, "FINALIZING"),
      )).for("update");
      if (!live) throw new AuthFailure("UPLOAD_STALE_FINALIZER", 409);
      await transaction.insert(sopDocuments).values({ id, title: live.title, fileName: live.fileName, mimeType: live.mimeType,
        sizeBytes: live.sizeBytes, sha256: live.sha256, originalKey: live.finalKey, uploadedBy: live.ownerId });
      const [createdJob] = await transaction.insert(workflowJobs).values({
        ownerId: live.ownerId,
        requestKey: live.requestKey,
        inputHash: live.sha256,
        kind: "document_ingestion",
        documentId: id,
        sourceSha256: live.sha256,
        pipelineVersion: ingestionPipelineVersion,
        state: "QUEUED",
        attemptId: randomUUID(),
        dispatchNonce: randomUUID(),
        attemptDeadline: sql`clock_timestamp() + ${ingestionBounds.attemptMilliseconds} * interval '1 millisecond'`,
      }).returning();
      await appendEvent(transaction, createdJob, "accepted", 0);
      await transaction.update(sopDocuments).set({
        latestJobId: createdJob.id,
        updatedAt: sql`clock_timestamp()`,
      }).where(eq(sopDocuments.id, id));
      const [accepted] = await transaction.update(documentUploadIntents).set({ state: "ACCEPTED", failureCode: null,
        finalizeLeaseToken: null, finalizeLeaseUntil: null }).where(and(eq(documentUploadIntents.id, id), eq(documentUploadIntents.finalizeLeaseToken, fence!))).returning();
      await transaction.insert(auditEvents).values({ actorId: account.id, action: "document.upload_accepted", targetId: id,
        outcome: "uploaded", metadata: { sizeBytes: live.sizeBytes, jobId: createdJob.id } });
      return { document: await documentDto(transaction, accepted), created: true };
    });
  } catch (error) {
    const failure = error instanceof AuthFailure ? error : new AuthFailure("UPLOAD_STORAGE_UNAVAILABLE", 503);
    if (intent && fence) {
      const safeCode = ["UPLOAD_SIZE_MISMATCH", "UPLOAD_TYPE_MISMATCH", "UPLOAD_CHECKSUM_MISMATCH", "UPLOAD_INVALID_FORMAT", "UPLOAD_OBJECT_MISSING"].includes(failure.code)
        ? failure.code : "UPLOAD_RETRY_REQUIRED";
      await database.update(documentUploadIntents).set({ state: "FAILED", failureCode: safeCode,
        finalizeLeaseToken: null, finalizeLeaseUntil: null }).where(and(eq(documentUploadIntents.id, id),
        eq(documentUploadIntents.finalizeLeaseToken, fence), gt(documentUploadIntents.finalizeLeaseUntil, sql`clock_timestamp()`),
        eq(documentUploadIntents.state, "FINALIZING"))).catch(() => undefined);
    }
    throw failure;
  } finally { activeFinalizers--; }
}
