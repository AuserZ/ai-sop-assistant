import { createHash, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { getDatabase } from "../db/client";
import {
  auditEvents,
  authSessions,
  authUsers,
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
import {
  calculateCleanupBackoffSeconds,
  decodeDocumentLibraryCursor,
  documentBounds,
  documentIdInput,
  documentMimeTypes,
  documentSourceContentQueryInput,
  documentSourceQueryInput,
  encodeDocumentLibraryCursor,
  escapeIlikePattern,
  ingestionPipelineVersion,
  listDocumentsQueryInput,
  signDocumentSourceToken,
  sourceLinkTtlSeconds,
  uploadInput,
  verifyDocumentSourceToken,
  type DocumentCitationAvailabilityDto,
  type DocumentDeleteResponse,
  type DocumentLibraryDiagnosticsDto,
  type DocumentLibraryItemDto,
  type DocumentLibraryResponse,
  type DocumentSourceAuthorizationResponse,
  type DocumentUploadDto,
  type EligibleActiveChunkDto,
} from "./contracts";
import { validateDocumentObject } from "./format";
import { getDocumentStorage, type DocumentStorage, type StoredObject } from "./storage";

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
        if (doc?.status === "DELETED") throw new AuthFailure("DOCUMENT_DELETED", 409);
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

async function lockCurrentUser(account: CurrentAccount, transaction: Transaction): Promise<CurrentAccount> {
  const [user] = await transaction
    .select({
      id: authUsers.id,
      name: authUsers.name,
      email: authUsers.email,
      role: authUsers.role,
      active: authUsers.active,
    })
    .from(authUsers)
    .where(eq(authUsers.id, account.id))
    .for("share");
  if (!user?.active) throw new AuthFailure("UNAUTHENTICATED", 401);
  const [session] = await transaction
    .select({ id: authSessions.id, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.id, account.sessionId),
        eq(authSessions.userId, account.id),
        gt(authSessions.expiresAt, sql`clock_timestamp()`),
      ),
    )
    .for("share");
  if (!session) throw new AuthFailure("UNAUTHENTICATED", 401);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sessionId: session.id,
    sessionExpiresAt: session.expiresAt,
  };
}

export async function listDocuments(
  account: CurrentAccount,
  rawQuery: unknown = {},
  database: AuthDatabase = getDatabase(),
): Promise<DocumentLibraryResponse> {
  const parsed = listDocumentsQueryInput.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  const query = parsed.data;
  const decodedCursor = query.cursor ? decodeDocumentLibraryCursor(query.cursor) : null;
  if (query.cursor && !decodedCursor) throw new AuthFailure("INVALID_INPUT", 400);

  return database.transaction(async (transaction) => {
    const liveAccount = await lockCurrentUser(account, transaction);
    const conditions: SQL[] = [];
    if (liveAccount.role !== "ADMIN") {
      conditions.push(eq(sopDocuments.status, "ACTIVE"));
    }
    if (query.q.length > 0) {
      const pattern = `%${escapeIlikePattern(query.q)}%`;
      conditions.push(sql`${sopDocuments.title} ilike ${pattern} escape '\\'`);
    }
    if (decodedCursor) {
      conditions.push(
        sql`(${sopDocuments.createdAt} < ${decodedCursor.createdAt}::timestamptz or (${sopDocuments.createdAt} = ${decodedCursor.createdAt}::timestamptz and ${sopDocuments.id} < ${decodedCursor.id}::uuid))`,
      );
    }

    const rows = await transaction
      .select({
        id: sopDocuments.id,
        title: sopDocuments.title,
        fileName: sopDocuments.fileName,
        mimeType: sopDocuments.mimeType,
        sizeBytes: sopDocuments.sizeBytes,
        uploaderName: authUsers.name,
        createdAt: sopDocuments.createdAt,
        cursorCreatedAt: sql<string>`to_char(${sopDocuments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        verifiedAt: sopDocuments.verifiedAt,
        deletedAt: sopDocuments.deletedAt,
        status: sopDocuments.status,
        previewKey: sopDocuments.previewKey,
        processingErrorCode: sopDocuments.processingErrorCode,
        rejectionReason: sopDocuments.rejectionReason,
        cleanupState: sopDocuments.cleanupState,
        cleanupAttempts: sopDocuments.cleanupAttempts,
        cleanupErrorCode: sopDocuments.cleanupErrorCode,
        cleanupCompletedAt: sopDocuments.cleanupCompletedAt,
        latestJobId: sopDocuments.latestJobId,
        processedJobId: sopDocuments.processedJobId,
        activeJobId: sopDocuments.activeJobId,
      })
      .from(sopDocuments)
      .innerJoin(authUsers, eq(sopDocuments.uploadedBy, authUsers.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(sopDocuments.createdAt), desc(sopDocuments.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeDocumentLibraryCursor({ createdAt: lastRow.cursorCreatedAt, id: lastRow.id })
        : null;

    const latestJobMap = new Map<
      string,
      NonNullable<DocumentLibraryDiagnosticsDto["latestJob"]>
    >();
    const pageCountMap = new Map<string, number>();
    const chunkCountMap = new Map<string, number>();
    const issueCountMap = new Map<string, number>();

    if (liveAccount.role === "ADMIN" && pageRows.length > 0) {
      const latestJobIds = Array.from(
        new Set(pageRows.map((row) => row.latestJobId).filter((id): id is string => Boolean(id))),
      );
      if (latestJobIds.length > 0) {
        const jobs = await transaction
          .select({
            id: workflowJobs.id,
            state: workflowJobs.state,
            stage: workflowJobs.stage,
            attemptNumber: workflowJobs.attemptNumber,
            errorCode: workflowJobs.errorCode,
          })
          .from(workflowJobs)
          .where(inArray(workflowJobs.id, latestJobIds));
        for (const job of jobs) {
          latestJobMap.set(job.id, job);
        }
      }

      const snapshotJobIds = Array.from(
        new Set(
          pageRows
            .map((row) => row.activeJobId ?? row.processedJobId ?? row.latestJobId)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      if (snapshotJobIds.length > 0) {
        const pageCounts = await transaction
          .select({ jobId: sopExtractionPages.jobId, total: count() })
          .from(sopExtractionPages)
          .where(inArray(sopExtractionPages.jobId, snapshotJobIds))
          .groupBy(sopExtractionPages.jobId);
        for (const entry of pageCounts) pageCountMap.set(entry.jobId, entry.total);

        const chunkCounts = await transaction
          .select({ jobId: sopChunks.jobId, total: count() })
          .from(sopChunks)
          .where(inArray(sopChunks.jobId, snapshotJobIds))
          .groupBy(sopChunks.jobId);
        for (const entry of chunkCounts) chunkCountMap.set(entry.jobId, entry.total);

        const issueCounts = await transaction
          .select({ jobId: sopVerificationIssues.jobId, total: count() })
          .from(sopVerificationIssues)
          .where(inArray(sopVerificationIssues.jobId, snapshotJobIds))
          .groupBy(sopVerificationIssues.jobId);
        for (const entry of issueCounts) issueCountMap.set(entry.jobId, entry.total);
      }
    }

    const items: DocumentLibraryItemDto[] = pageRows.map((row) => {
      const snapshotJobId = row.activeJobId ?? row.processedJobId ?? row.latestJobId;
      const diagnostics: DocumentLibraryDiagnosticsDto | null =
        liveAccount.role === "ADMIN"
          ? {
              processingErrorCode: row.processingErrorCode,
              rejectionReason: row.rejectionReason,
              latestJob: row.latestJobId ? (latestJobMap.get(row.latestJobId) ?? null) : null,
              pageCount: snapshotJobId ? (pageCountMap.get(snapshotJobId) ?? 0) : 0,
              chunkCount: snapshotJobId ? (chunkCountMap.get(snapshotJobId) ?? 0) : 0,
              issueCount: snapshotJobId ? (issueCountMap.get(snapshotJobId) ?? 0) : 0,
              hasPreview:
                row.status !== "DELETED" &&
                (row.mimeType === "application/pdf" || Boolean(row.previewKey)),
              cleanup:
                row.status === "DELETED" && row.cleanupState
                  ? {
                      state: row.cleanupState,
                      attempts: row.cleanupAttempts,
                      errorCode: row.cleanupErrorCode,
                      completedAt: row.cleanupCompletedAt ? row.cleanupCompletedAt.toISOString() : null,
                    }
                  : null,
            }
          : null;

      return {
        id: row.id,
        title: row.title,
        fileName: row.fileName,
        mimeType: row.mimeType as typeof documentMimeTypes[number],
        fileType: row.mimeType === "application/pdf" ? "PDF" : "DOCX",
        sizeBytes: row.sizeBytes,
        uploaderName: row.uploaderName,
        uploadedAt: row.createdAt.toISOString(),
        verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
        status: row.status,
        diagnostics,
      };
    });

    return { items, nextCursor };
  });
}

export async function authorizeDocumentSource(
  account: CurrentAccount,
  documentId: string,
  rawQuery: unknown = {},
  database: AuthDatabase = getDatabase(),
  options?: { nowSeconds?: number; signingKey?: Buffer },
): Promise<DocumentSourceAuthorizationResponse> {
  if (!documentIdInput.safeParse(documentId).success) {
    throw new AuthFailure("NOT_FOUND", 404);
  }
  const parsed = documentSourceQueryInput.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  const query = parsed.data;

  return database.transaction(async (transaction) => {
    const liveAccount = await lockCurrentUser(account, transaction);
    const whereClause =
      liveAccount.role === "ADMIN"
        ? and(eq(sopDocuments.id, documentId), ne(sopDocuments.status, "DELETED"))
        : and(eq(sopDocuments.id, documentId), eq(sopDocuments.status, "ACTIVE"));

    const [doc] = await transaction
      .select({
        id: sopDocuments.id,
        title: sopDocuments.title,
        fileName: sopDocuments.fileName,
        mimeType: sopDocuments.mimeType,
        sha256: sopDocuments.sha256,
        status: sopDocuments.status,
      })
      .from(sopDocuments)
      .where(whereClause);

    if (!doc) throw new AuthFailure("NOT_FOUND", 404);

    const { token, claims } = signDocumentSourceToken(
      {
        documentId: doc.id,
        accountId: liveAccount.id,
        role: liveAccount.role,
        statusAtIssue: doc.status,
        sha256: doc.sha256,
        disposition: query.disposition,
        page: query.page ?? null,
        section: query.section ?? null,
      },
      options,
    );

    await transaction.insert(auditEvents).values({
      actorId: liveAccount.id,
      action: "document.source_authorized",
      targetId: doc.id,
      outcome: "authorized",
      metadata: {
        disposition: claims.disposition,
        status: doc.status,
        page: claims.page,
        section: claims.section,
      },
    });

    return {
      source: {
        documentId: doc.id,
        title: doc.title,
        fileName: doc.fileName,
        mimeType: doc.mimeType as typeof documentMimeTypes[number],
        disposition: claims.disposition,
        url: `/api/documents/${doc.id}/source/content?token=${encodeURIComponent(token)}`,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
        ttlSeconds: sourceLinkTtlSeconds,
        context: {
          page: claims.page,
          section: claims.section,
        },
      },
    };
  });
}

export async function readDocumentSourceContent(
  account: CurrentAccount,
  documentId: string,
  rawQuery: unknown,
  database: AuthDatabase = getDatabase(),
  storage: DocumentStorage = getDocumentStorage(),
  options?: { nowSeconds?: number; signingKey?: Buffer; signal?: AbortSignal },
): Promise<{
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  disposition: "inline" | "attachment";
}> {
  if (!documentIdInput.safeParse(documentId).success) {
    throw new AuthFailure("NOT_FOUND", 404);
  }
  const parsed = documentSourceContentQueryInput.safeParse(rawQuery ?? {});
  if (!parsed.success) {
    throw new AuthFailure("SOURCE_LINK_INVALID", 403);
  }
  const claims = verifyDocumentSourceToken(parsed.data.token, documentId, options);

  const target = await database.transaction(async (transaction) => {
    const liveAccount = await lockCurrentUser(account, transaction);
    if (liveAccount.id !== claims.accountId) {
      throw new AuthFailure("FORBIDDEN", 403);
    }
    const whereClause =
      liveAccount.role === "ADMIN"
        ? and(eq(sopDocuments.id, documentId), ne(sopDocuments.status, "DELETED"))
        : and(eq(sopDocuments.id, documentId), eq(sopDocuments.status, "ACTIVE"));

    const [doc] = await transaction
      .select({
        id: sopDocuments.id,
        fileName: sopDocuments.fileName,
        mimeType: sopDocuments.mimeType,
        sizeBytes: sopDocuments.sizeBytes,
        sha256: sopDocuments.sha256,
        originalKey: sopDocuments.originalKey,
      })
      .from(sopDocuments)
      .where(whereClause);

    if (!doc || doc.sha256 !== claims.sha256) {
      throw new AuthFailure("NOT_FOUND", 404);
    }
    return doc;
  });

  const callerSignal = options?.signal ?? new AbortController().signal;
  const boundedSignal = AbortSignal.any([
    callerSignal,
    AbortSignal.timeout(documentBounds.storageTimeoutMilliseconds),
  ]);
  let object: StoredObject | null;
  try {
    object = await storage.read(target.originalKey, target.sizeBytes, boundedSignal);
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    throw new AuthFailure("UPLOAD_STORAGE_UNAVAILABLE", 503);
  }
  if (!object) {
    throw new AuthFailure("SOURCE_OBJECT_MISSING", 404);
  }
  if (
    object.bytes.byteLength !== target.sizeBytes ||
    createHash("sha256").update(object.bytes).digest("hex") !== target.sha256
  ) {
    throw new AuthFailure("SOURCE_OBJECT_MISSING", 404);
  }
  return {
    bytes: object.bytes,
    fileName: target.fileName,
    mimeType: target.mimeType,
    disposition: claims.disposition,
  };
}

function toDeleteResponse(
  row: {
    id: string;
    deletedAt: Date | null;
    cleanupState: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | null;
    cleanupAttempts: number;
    cleanupErrorCode: string | null;
    cleanupCompletedAt: Date | null;
  },
  created: boolean,
): DocumentDeleteResponse {
  if (!row.deletedAt || !row.cleanupState) {
    throw new Error("Deleted tombstone metadata missing.");
  }
  return {
    deleted: true,
    created,
    document: {
      id: row.id,
      status: "DELETED",
      deletedAt: row.deletedAt.toISOString(),
      cleanup: {
        state: row.cleanupState,
        attempts: row.cleanupAttempts,
        errorCode: row.cleanupErrorCode,
        completedAt: row.cleanupCompletedAt ? row.cleanupCompletedAt.toISOString() : null,
      },
    },
  };
}

export async function deleteDocument(
  account: CurrentAccount,
  id: string,
  database: AuthDatabase = getDatabase(),
): Promise<DocumentDeleteResponse> {
  if (!documentIdInput.safeParse(id).success) {
    throw new AuthFailure("NOT_FOUND", 404);
  }

  return database.transaction(async (transaction) => {
    await lockCurrentAdmin(account, transaction);
    const [doc] = await transaction
      .select()
      .from(sopDocuments)
      .where(eq(sopDocuments.id, id))
      .for("update");
    if (!doc) throw new AuthFailure("NOT_FOUND", 404);

    if (doc.status === "DELETED") {
      if (doc.cleanupState === "FAILED") {
        const [requeued] = await transaction
          .update(sopDocuments)
          .set({
            cleanupState: "PENDING",
            cleanupNextAt: sql`clock_timestamp()`,
            cleanupErrorCode: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(sopDocuments.id, id))
          .returning();
        return toDeleteResponse(requeued, false);
      }
      return toDeleteResponse(doc, false);
    }

    const previousStatus = doc.status;
    const hadActiveSnapshot = Boolean(doc.activeJobId);
    const [deleted] = await transaction
      .update(sopDocuments)
      .set({
        status: "DELETED",
        activeJobId: null,
        activePipelineVersion: null,
        activeAttemptId: null,
        rejectionReason: null,
        deletedBy: account.id,
        deletedAt: sql`clock_timestamp()`,
        cleanupState: "PENDING",
        cleanupAttempts: 0,
        cleanupErrorCode: null,
        cleanupNextAt: sql`clock_timestamp()`,
        cleanupLeaseToken: null,
        cleanupLeaseUntil: null,
        cleanupCompletedAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(sopDocuments.id, id))
      .returning();

    await transaction
      .update(workflowJobs)
      .set({
        state: "FAILED",
        errorCode: "DOCUMENT_DELETED",
        dispatchLeaseToken: null,
        dispatchLeaseUntil: null,
        runLeaseUntil: null,
        attemptDeadline: sql`coalesce(${workflowJobs.attemptDeadline}, clock_timestamp())`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(workflowJobs.documentId, id),
          inArray(workflowJobs.state, ["QUEUED", "RUNNING", "WAITING_FOR_PIPELINE"]),
        ),
      );

    await transaction.insert(auditEvents).values({
      actorId: account.id,
      action: "document.deleted",
      targetId: id,
      outcome: "deleted",
      metadata: { previousStatus, hadActiveSnapshot },
    });

    return toDeleteResponse(deleted, true);
  });
}

export async function reconcileDocumentDeletions(
  database: AuthDatabase = getDatabase(),
  storage: DocumentStorage = getDocumentStorage(),
  options?: { signal?: AbortSignal; limit?: number; documentIds?: string[] },
): Promise<{ processed: number; completed: number; failed: number }> {
  const batchSize = Math.max(1, Math.min(options?.limit ?? documentBounds.cleanupBatchSize, 50));
  const claimed = await database.transaction(async (transaction) => {
    const conditions: SQL[] = [
      eq(sopDocuments.status, "DELETED"),
      or(
        and(
          inArray(sopDocuments.cleanupState, ["PENDING", "FAILED"]),
          lte(sopDocuments.cleanupNextAt, sql`clock_timestamp()`),
        ),
        and(
          eq(sopDocuments.cleanupState, "RUNNING"),
          lte(sopDocuments.cleanupLeaseUntil, sql`clock_timestamp()`),
        ),
      )!,
    ];
    if (options?.documentIds && options.documentIds.length > 0) {
      conditions.push(inArray(sopDocuments.id, options.documentIds));
    }

    const due = await transaction
      .select({
        id: sopDocuments.id,
        deletedBy: sopDocuments.deletedBy,
        originalKey: sopDocuments.originalKey,
        previewKey: sopDocuments.previewKey,
        cleanupAttempts: sopDocuments.cleanupAttempts,
      })
      .from(sopDocuments)
      .where(and(...conditions))
      .orderBy(asc(sopDocuments.cleanupNextAt), asc(sopDocuments.deletedAt))
      .limit(batchSize)
      .for("update", { skipLocked: true });

    const stagingMap = new Map<string, string>();
    if (due.length > 0) {
      const intents = await transaction
        .select({ id: documentUploadIntents.id, stagingKey: documentUploadIntents.stagingKey })
        .from(documentUploadIntents)
        .where(inArray(documentUploadIntents.id, due.map((row) => row.id)));
      for (const intent of intents) {
        stagingMap.set(intent.id, intent.stagingKey);
      }
    }

    const leases: Array<{
      id: string;
      deletedBy: string;
      originalKey: string;
      previewKey: string | null;
      stagingKey: string | null;
      leaseToken: string;
      attempts: number;
    }> = [];

    for (const row of due) {
      if (!row.deletedBy) continue;
      const leaseToken = randomUUID();
      const attempts = row.cleanupAttempts + 1;
      await transaction
        .update(sopDocuments)
        .set({
          cleanupState: "RUNNING",
          cleanupAttempts: attempts,
          cleanupLeaseToken: leaseToken,
          cleanupLeaseUntil: sql`clock_timestamp() + ${documentBounds.cleanupLeaseSeconds} * interval '1 second'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(sopDocuments.id, row.id));
      leases.push({
        id: row.id,
        deletedBy: row.deletedBy,
        originalKey: row.originalKey,
        previewKey: row.previewKey,
        stagingKey: stagingMap.get(row.id) ?? null,
        leaseToken,
        attempts,
      });
    }
    return leases;
  });

  let completed = 0;
  let failed = 0;

  for (const item of claimed) {
    if (options?.signal?.aborted) break;

    const purgedDb = await database.transaction(async (transaction) => {
      const [fenced] = await transaction
        .select({ id: sopDocuments.id })
        .from(sopDocuments)
        .where(
          and(
            eq(sopDocuments.id, item.id),
            eq(sopDocuments.status, "DELETED"),
            eq(sopDocuments.cleanupLeaseToken, item.leaseToken),
          ),
        )
        .for("update");
      if (!fenced) return false;

      await transaction.delete(sopChunks).where(eq(sopChunks.documentId, item.id));
      await transaction.delete(sopExtractionPages).where(eq(sopExtractionPages.documentId, item.id));
      await transaction.delete(sopVerificationIssues).where(eq(sopVerificationIssues.documentId, item.id));
      return true;
    });
    if (!purgedDb) continue;

    const keys = Array.from(
      new Set(
        [item.originalKey, item.previewKey, item.stagingKey].filter(
          (key): key is string => Boolean(key),
        ),
      ),
    );

    try {
      for (const key of keys) {
        const timeoutSignal = AbortSignal.timeout(documentBounds.storageTimeoutMilliseconds);
        const boundedSignal = options?.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        await storage.delete(key, boundedSignal);
      }
      await database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(sopDocuments)
          .set({
            cleanupState: "COMPLETED",
            cleanupErrorCode: null,
            cleanupNextAt: null,
            cleanupLeaseToken: null,
            cleanupLeaseUntil: null,
            cleanupCompletedAt: sql`clock_timestamp()`,
            previewKey: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(sopDocuments.id, item.id),
              eq(sopDocuments.status, "DELETED"),
              eq(sopDocuments.cleanupLeaseToken, item.leaseToken),
            ),
          )
          .returning({ id: sopDocuments.id });
        if (updated) {
          await transaction.insert(auditEvents).values({
            actorId: item.deletedBy,
            action: "document.cleanup_completed",
            targetId: item.id,
            outcome: "completed",
            metadata: { attempts: item.attempts },
          });
        }
      });
      completed++;
    } catch {
      const backoffSeconds = calculateCleanupBackoffSeconds(item.attempts);
      await database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(sopDocuments)
          .set({
            cleanupState: "FAILED",
            cleanupErrorCode: "CLEANUP_STORAGE_UNAVAILABLE",
            cleanupLeaseToken: null,
            cleanupLeaseUntil: null,
            cleanupNextAt: sql`clock_timestamp() + ${backoffSeconds} * interval '1 second'`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(sopDocuments.id, item.id),
              eq(sopDocuments.status, "DELETED"),
              eq(sopDocuments.cleanupLeaseToken, item.leaseToken),
            ),
          )
          .returning({ id: sopDocuments.id });
        if (updated) {
          await transaction.insert(auditEvents).values({
            actorId: item.deletedBy,
            action: "document.cleanup_failed",
            targetId: item.id,
            outcome: "failed",
            metadata: { errorCode: "CLEANUP_STORAGE_UNAVAILABLE", attempts: item.attempts },
          });
        }
      });
      failed++;
    }
  }

  return { processed: claimed.length, completed, failed };
}

export async function queryEligibleActiveChunks(
  database: AuthDatabase = getDatabase(),
  options?: { documentId?: string },
): Promise<EligibleActiveChunkDto[]> {
  const conditions: SQL[] = [
    eq(sopDocuments.status, "ACTIVE"),
    eq(sopChunks.jobId, sopDocuments.activeJobId),
    eq(sopChunks.pipelineVersion, sopDocuments.activePipelineVersion),
    eq(sopChunks.sourceSha256, sopDocuments.sha256),
  ];
  if (options?.documentId) {
    if (!documentIdInput.safeParse(options.documentId).success) return [];
    conditions.push(eq(sopDocuments.id, options.documentId));
  }

  return database
    .select({
      chunkId: sopChunks.id,
      documentId: sopDocuments.id,
      documentTitle: sopDocuments.title,
      fileName: sopDocuments.fileName,
      jobId: sopChunks.jobId,
      pipelineVersion: sopChunks.pipelineVersion,
      sourceSha256: sopChunks.sourceSha256,
      sequence: sopChunks.sequence,
      sectionPath: sopChunks.sectionPath,
      pageStart: sopChunks.pageStart,
      pageEnd: sopChunks.pageEnd,
      contentType: sopChunks.contentType,
      text: sopChunks.text,
      contentHash: sopChunks.contentHash,
      tokenEstimate: sopChunks.tokenEstimate,
    })
    .from(sopChunks)
    .innerJoin(sopDocuments, eq(sopChunks.documentId, sopDocuments.id))
    .where(and(...conditions))
    .orderBy(asc(sopDocuments.createdAt), asc(sopChunks.sequence));
}

export async function resolveDocumentCitationAvailability(
  account: CurrentAccount,
  documentId: string,
  database: AuthDatabase = getDatabase(),
): Promise<DocumentCitationAvailabilityDto> {
  return database.transaction(async (transaction) => {
    const liveAccount = await lockCurrentUser(account, transaction);
    if (!documentIdInput.safeParse(documentId).success) {
      return { available: false, documentId, reason: "UNAVAILABLE" };
    }
    const [doc] = await transaction
      .select({
        id: sopDocuments.id,
        title: sopDocuments.title,
        status: sopDocuments.status,
      })
      .from(sopDocuments)
      .where(eq(sopDocuments.id, documentId));
    if (!doc) {
      return { available: false, documentId, reason: "UNAVAILABLE" };
    }
    if (doc.status === "ACTIVE") {
      return { available: true, documentId: doc.id, title: doc.title, status: "ACTIVE" };
    }
    if (liveAccount.role === "ADMIN" && doc.status === "DELETED") {
      return { available: false, documentId: doc.id, reason: "DELETED" };
    }
    return { available: false, documentId: doc.id, reason: "UNAVAILABLE" };
  });
}
