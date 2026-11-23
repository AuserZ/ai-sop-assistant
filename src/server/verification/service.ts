import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import {
  auditEvents,
  authUsers,
  sopChunks,
  sopDocuments,
  sopExtractionPages,
  sopVerificationIssues,
  sopVerificationRecords,
  workflowJobs,
  type VerificationIssueSummary,
} from "../db/schema";
import { lockCurrentAdmin, type CurrentAccount } from "../auth/authorization";
import { AuthFailure } from "../auth/errors";
import type { AuthDatabase } from "../auth/rate-limit";
import { documentBounds, ingestionPipelineVersion } from "../documents/contracts";
import { getDocumentStorage, type DocumentStorage } from "../documents/storage";
import { approvedEmbeddingDimensions } from "../ingestion/config";
import { ingestionLimits } from "../ingestion/contracts";
import { ingestionBounds } from "../jobs/contracts";
import { appendEvent } from "../jobs/service";
import {
  reprocessDocumentInput,
  verifyDocumentInput,
  type DocumentReviewDto,
  type VerificationMutationResponse,
  type VerificationRecordDto,
} from "./contracts";

type Transaction = Parameters<Parameters<AuthDatabase["transaction"]>[0]>[0];

function isPdfHeader(bytes: Buffer) {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

function summarizeIssues(
  issues: Array<{ severity: "info" | "warning" | "error"; resolvedAt: Date | null }>,
): VerificationIssueSummary {
  const bySeverity = { error: 0, warning: 0, info: 0 };
  let resolved = 0;
  for (const issue of issues) {
    bySeverity[issue.severity]++;
    if (issue.resolvedAt) resolved++;
  }
  return {
    total: issues.length,
    resolved,
    unresolved: issues.length - resolved,
    bySeverity,
  };
}

async function loadDocumentReview(transaction: Transaction, documentId: string): Promise<DocumentReviewDto> {
  const [doc] = await transaction.select().from(sopDocuments).where(eq(sopDocuments.id, documentId));
  if (!doc) throw new AuthFailure("NOT_FOUND", 404);

  const [verifier] = doc.verifiedBy
    ? await transaction.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, doc.verifiedBy))
    : [];

  const snapshotJobId = doc.activeJobId ?? doc.processedJobId ?? doc.latestJobId;

  const pages = snapshotJobId
    ? await transaction
        .select({
          id: sopExtractionPages.id,
          pageIndex: sopExtractionPages.pageIndex,
          pageKind: sopExtractionPages.pageKind,
          sourceLocationKind: sopExtractionPages.sourceLocationKind,
          normalizedText: sopExtractionPages.normalizedText,
          ocrConfidence: sopExtractionPages.ocrConfidence,
          ocrModel: sopExtractionPages.ocrModel,
          verificationStatus: sopExtractionPages.verificationStatus,
        })
        .from(sopExtractionPages)
        .where(and(eq(sopExtractionPages.documentId, doc.id), eq(sopExtractionPages.jobId, snapshotJobId)))
        .orderBy(asc(sopExtractionPages.pageIndex))
    : [];

  const chunks = snapshotJobId
    ? await transaction
        .select({
          id: sopChunks.id,
          sequence: sopChunks.sequence,
          sectionPath: sopChunks.sectionPath,
          pageStart: sopChunks.pageStart,
          pageEnd: sopChunks.pageEnd,
          contentType: sopChunks.contentType,
          text: sopChunks.text,
          contentHash: sopChunks.contentHash,
          tokenEstimate: sopChunks.tokenEstimate,
          hasEmbedding: sql<boolean>`${sopChunks.embedding} is not null and ${sopChunks.embeddingDimensions} = ${approvedEmbeddingDimensions}`,
          embeddingModel: sopChunks.embeddingModel,
        })
        .from(sopChunks)
        .where(and(eq(sopChunks.documentId, doc.id), eq(sopChunks.jobId, snapshotJobId)))
        .orderBy(asc(sopChunks.sequence))
    : [];

  const issues = snapshotJobId
    ? await transaction
        .select({
          id: sopVerificationIssues.id,
          pageIndex: sopVerificationIssues.pageIndex,
          sectionPath: sopVerificationIssues.sectionPath,
          severity: sopVerificationIssues.severity,
          issueCode: sopVerificationIssues.issueCode,
          summary: sopVerificationIssues.summary,
          resolvedAt: sopVerificationIssues.resolvedAt,
          resolvedBy: sopVerificationIssues.resolvedBy,
        })
        .from(sopVerificationIssues)
        .where(and(eq(sopVerificationIssues.documentId, doc.id), eq(sopVerificationIssues.jobId, snapshotJobId)))
        .orderBy(asc(sopVerificationIssues.pageIndex), asc(sopVerificationIssues.createdAt))
    : [];

  const historyRows = await transaction
    .select({
      id: sopVerificationRecords.id,
      documentId: sopVerificationRecords.documentId,
      sourceSha256: sopVerificationRecords.sourceSha256,
      jobId: sopVerificationRecords.jobId,
      pipelineVersion: sopVerificationRecords.pipelineVersion,
      attemptId: sopVerificationRecords.attemptId,
      reviewerId: sopVerificationRecords.reviewerId,
      reviewerName: authUsers.name,
      decision: sopVerificationRecords.decision,
      notes: sopVerificationRecords.notes,
      issueSummary: sopVerificationRecords.issueSummary,
      beforeStatus: sopVerificationRecords.beforeStatus,
      afterStatus: sopVerificationRecords.afterStatus,
      createdAt: sopVerificationRecords.createdAt,
    })
    .from(sopVerificationRecords)
    .innerJoin(authUsers, eq(sopVerificationRecords.reviewerId, authUsers.id))
    .where(eq(sopVerificationRecords.documentId, doc.id))
    .orderBy(desc(sopVerificationRecords.createdAt));

  const hasPreview = doc.mimeType === "application/pdf" || Boolean(doc.previewKey);
  const previewVersion = doc.processedAttemptId ?? doc.updatedAt.toISOString();
  const verificationHistory: VerificationRecordDto[] = historyRows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));

  return {
    document: {
      id: doc.id,
      title: doc.title,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      sha256: doc.sha256,
      status: doc.status,
      latestJobId: doc.latestJobId,
      processedJobId: doc.processedJobId,
      processedPipelineVersion: doc.processedPipelineVersion,
      processedAttemptId: doc.processedAttemptId,
      activeJobId: doc.activeJobId,
      activePipelineVersion: doc.activePipelineVersion,
      activeAttemptId: doc.activeAttemptId,
      verifiedBy: doc.verifiedBy,
      verifiedByName: verifier?.name ?? null,
      verifiedAt: doc.verifiedAt ? doc.verifiedAt.toISOString() : null,
      rejectionReason: doc.rejectionReason,
      processingErrorCode: doc.processingErrorCode,
      hasPreview,
      previewUrl: hasPreview ? `/api/documents/${doc.id}/preview?v=${encodeURIComponent(previewVersion)}` : null,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    },
    pages,
    chunks,
    issues: issues.map((issue) => ({
      ...issue,
      resolvedAt: issue.resolvedAt ? issue.resolvedAt.toISOString() : null,
    })),
    verificationHistory,
  };
}

export async function getDocumentReview(
  account: CurrentAccount,
  documentId: string,
  database: AuthDatabase = getDatabase(),
): Promise<DocumentReviewDto> {
  return database.transaction(async (transaction) => {
    await lockCurrentAdmin(account, transaction);
    return loadDocumentReview(transaction, documentId);
  });
}

export async function readDocumentPreview(
  account: CurrentAccount,
  documentId: string,
  database: AuthDatabase = getDatabase(),
  storage: DocumentStorage = getDocumentStorage(),
  signal: AbortSignal = new AbortController().signal,
): Promise<{ bytes: Buffer; fileName: string }> {
  const target = await database.transaction(async (transaction) => {
    await lockCurrentAdmin(account, transaction);
    const [doc] = await transaction
      .select({
        mimeType: sopDocuments.mimeType,
        sizeBytes: sopDocuments.sizeBytes,
        fileName: sopDocuments.fileName,
        originalKey: sopDocuments.originalKey,
        previewKey: sopDocuments.previewKey,
      })
      .from(sopDocuments)
      .where(eq(sopDocuments.id, documentId));
    if (!doc) throw new AuthFailure("NOT_FOUND", 404);
    const isPdf = doc.mimeType === "application/pdf";
    const storageKey = isPdf ? doc.originalKey : doc.previewKey;
    if (!storageKey) throw new AuthFailure("PREVIEW_NOT_AVAILABLE", 404);
    return {
      storageKey,
      maximumBytes: isPdf ? doc.sizeBytes : ingestionLimits.maxPreviewBytes,
      fileName: isPdf ? doc.fileName : `${doc.fileName.replace(/\.docx$/i, "")}.pdf`,
    };
  });

  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(documentBounds.storageTimeoutMilliseconds)]);
  const object = await storage.read(target.storageKey, target.maximumBytes, boundedSignal);
  if (!object || !isPdfHeader(object.bytes)) {
    throw new AuthFailure("PREVIEW_NOT_AVAILABLE", 404);
  }
  return { bytes: object.bytes, fileName: target.fileName };
}

export async function verifyDocument(
  account: CurrentAccount,
  documentId: string,
  input: unknown,
  database: AuthDatabase = getDatabase(),
  hooks?: { beforeDocumentCommit?: () => Promise<void> | void },
): Promise<VerificationMutationResponse> {
  const parsed = verifyDocumentInput.safeParse(input);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  const request = parsed.data;
  const trimmedNotes = request.notes?.trim() || null;

  return database.transaction(async (transaction) => {
    await lockCurrentAdmin(account, transaction);

    const [doc] = await transaction
      .select()
      .from(sopDocuments)
      .where(eq(sopDocuments.id, documentId))
      .for("update");
    if (!doc) throw new AuthFailure("NOT_FOUND", 404);
    if (doc.status === "ACTIVE") throw new AuthFailure("DOCUMENT_ALREADY_ACTIVE", 409);
    if (doc.status !== "PENDING_VERIFICATION") throw new AuthFailure("VERIFICATION_STATE_CONFLICT", 409);

    if (
      doc.sha256 !== request.expectedSha256 ||
      doc.processedJobId !== request.expectedJobId ||
      doc.processedPipelineVersion !== request.expectedPipelineVersion ||
      doc.processedAttemptId !== request.expectedAttemptId
    ) {
      throw new AuthFailure("VERIFICATION_STALE_SNAPSHOT", 409);
    }

    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.id, request.expectedJobId))
      .for("update");
    if (
      !job ||
      job.kind !== "document_ingestion" ||
      job.state !== "COMPLETED" ||
      job.documentId !== doc.id ||
      job.sourceSha256 !== doc.sha256 ||
      job.pipelineVersion !== doc.processedPipelineVersion
    ) {
      throw new AuthFailure("VERIFICATION_INCOMPLETE_ARTIFACTS", 409);
    }
    if (job.attemptId !== request.expectedAttemptId) {
      throw new AuthFailure("VERIFICATION_STALE_SNAPSHOT", 409);
    }

    const [pageSummary] = await transaction
      .select({ total: count() })
      .from(sopExtractionPages)
      .where(and(eq(sopExtractionPages.documentId, doc.id), eq(sopExtractionPages.jobId, job.id)));
    const [chunkSummary] = await transaction
      .select({ total: count() })
      .from(sopChunks)
      .where(
        and(
          eq(sopChunks.documentId, doc.id),
          eq(sopChunks.jobId, job.id),
          eq(sopChunks.sourceSha256, doc.sha256),
          eq(sopChunks.pipelineVersion, job.pipelineVersion!),
        ),
      );
    const [invalidEmbeddings] = await transaction
      .select({ total: count() })
      .from(sopChunks)
      .where(
        and(
          eq(sopChunks.documentId, doc.id),
          eq(sopChunks.jobId, job.id),
          or(isNull(sopChunks.embedding), ne(sopChunks.embeddingDimensions, approvedEmbeddingDimensions)),
        ),
      );

    if (pageSummary.total < 1 || chunkSummary.total < 1 || invalidEmbeddings.total > 0) {
      throw new AuthFailure("VERIFICATION_INCOMPLETE_ARTIFACTS", 409);
    }

    const uniqueResolvedIds = Array.from(new Set(request.resolvedIssueIds ?? []));
    if (uniqueResolvedIds.length > 0) {
      const [matchedIssues] = await transaction
        .select({ total: count() })
        .from(sopVerificationIssues)
        .where(
          and(
            eq(sopVerificationIssues.documentId, doc.id),
            eq(sopVerificationIssues.jobId, job.id),
            inArray(sopVerificationIssues.id, uniqueResolvedIds),
          ),
        );
      if (matchedIssues.total !== uniqueResolvedIds.length) {
        throw new AuthFailure("VERIFICATION_STALE_SNAPSHOT", 409);
      }
      await transaction
        .update(sopVerificationIssues)
        .set({ resolvedAt: sql`clock_timestamp()`, resolvedBy: account.id })
        .where(
          and(
            eq(sopVerificationIssues.documentId, doc.id),
            eq(sopVerificationIssues.jobId, job.id),
            inArray(sopVerificationIssues.id, uniqueResolvedIds),
            isNull(sopVerificationIssues.resolvedAt),
          ),
        );
    }

    const jobIssues = await transaction
      .select({ severity: sopVerificationIssues.severity, resolvedAt: sopVerificationIssues.resolvedAt })
      .from(sopVerificationIssues)
      .where(and(eq(sopVerificationIssues.documentId, doc.id), eq(sopVerificationIssues.jobId, job.id)));
    const issueSummary = summarizeIssues(jobIssues);

    const decision = request.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    const afterStatus = request.decision === "APPROVE" ? "ACTIVE" : "REJECTED";

    const [insertedRecord] = await transaction
      .insert(sopVerificationRecords)
      .values({
        documentId: doc.id,
        sourceSha256: doc.sha256,
        jobId: job.id,
        pipelineVersion: job.pipelineVersion!,
        attemptId: job.attemptId,
        reviewerId: account.id,
        decision,
        notes: trimmedNotes,
        issueSummary,
        beforeStatus: "PENDING_VERIFICATION",
        afterStatus,
        createdAt: sql`clock_timestamp()`,
      })
      .returning();

    if (hooks?.beforeDocumentCommit) {
      await hooks.beforeDocumentCommit();
    }

    await transaction
      .update(sopExtractionPages)
      .set({ verificationStatus: decision })
      .where(and(eq(sopExtractionPages.documentId, doc.id), eq(sopExtractionPages.jobId, job.id)));

    await transaction
      .update(sopDocuments)
      .set(
        request.decision === "APPROVE"
          ? {
              status: "ACTIVE",
              activeJobId: job.id,
              activePipelineVersion: job.pipelineVersion!,
              activeAttemptId: job.attemptId,
              verifiedBy: account.id,
              verifiedAt: insertedRecord.createdAt,
              rejectionReason: null,
              updatedAt: sql`clock_timestamp()`,
            }
          : {
              status: "REJECTED",
              activeJobId: null,
              activePipelineVersion: null,
              activeAttemptId: null,
              verifiedBy: account.id,
              verifiedAt: insertedRecord.createdAt,
              rejectionReason: trimmedNotes!,
              updatedAt: sql`clock_timestamp()`,
            },
      )
      .where(eq(sopDocuments.id, doc.id));

    await transaction.insert(auditEvents).values({
      actorId: account.id,
      action: request.decision === "APPROVE" ? "document.verification_approved" : "document.verification_rejected",
      targetId: doc.id,
      outcome: afterStatus.toLowerCase(),
      metadata: {
        jobId: job.id,
        recordId: insertedRecord.id,
        decision,
        issueTotal: issueSummary.total,
        issueResolved: issueSummary.resolved,
        issueUnresolved: issueSummary.unresolved,
      },
    });

    const review = await loadDocumentReview(transaction, doc.id);
    const matchingRecord = review.verificationHistory.find((entry) => entry.id === insertedRecord.id);
    if (!matchingRecord) throw new Error("Persisted verification record missing.");
    return { ...review, record: matchingRecord };
  });
}

export async function reprocessDocument(
  account: CurrentAccount,
  documentId: string,
  input: unknown,
  database: AuthDatabase = getDatabase(),
): Promise<DocumentReviewDto> {
  const parsed = reprocessDocumentInput.safeParse(input);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  const request = parsed.data;

  return database.transaction(async (transaction) => {
    await lockCurrentAdmin(account, transaction);

    const [doc] = await transaction
      .select()
      .from(sopDocuments)
      .where(eq(sopDocuments.id, documentId))
      .for("update");
    if (!doc) throw new AuthFailure("NOT_FOUND", 404);
    if (doc.status === "ACTIVE") throw new AuthFailure("DOCUMENT_ALREADY_ACTIVE", 409);
    if (doc.status === "UPLOADED" || doc.status === "PROCESSING") {
      throw new AuthFailure("DOCUMENT_ALREADY_PROCESSING", 409);
    }
    if (doc.sha256 !== request.expectedSha256) {
      throw new AuthFailure("VERIFICATION_STALE_SNAPSHOT", 409);
    }

    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(
        and(
          eq(workflowJobs.documentId, doc.id),
          eq(workflowJobs.kind, "document_ingestion"),
          eq(workflowJobs.sourceSha256, doc.sha256),
          eq(workflowJobs.pipelineVersion, ingestionPipelineVersion),
        ),
      )
      .for("update");
    if (!job) throw new AuthFailure("VERIFICATION_STATE_CONFLICT", 409);

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
        processedJobId: null,
        processedPipelineVersion: null,
        processedAttemptId: null,
        activeJobId: null,
        activePipelineVersion: null,
        activeAttemptId: null,
        verifiedBy: null,
        verifiedAt: null,
        rejectionReason: null,
        processingErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(sopDocuments.id, doc.id));

    await transaction.insert(auditEvents).values({
      actorId: account.id,
      action: "document.reprocess_requested",
      targetId: doc.id,
      outcome: "queued",
      metadata: {
        jobId: job.id,
        previousStatus: doc.status,
        hasNotes: Boolean(request.notes?.trim()),
      },
    });

    return loadDocumentReview(transaction, doc.id);
  });
}
