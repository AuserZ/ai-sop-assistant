import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import {
  auditEvents,
  sopChunks,
  sopDocuments,
  sopExtractionPages,
  sopVerificationIssues,
  workflowJobs,
  workflowNonceReceipts,
} from "../db/schema";
import { AuthFailure } from "../auth/errors";
import { getDocumentStorage, type DocumentStorage } from "../documents/storage";
import { appendEvent, type JobDatabase, type JobTransaction, type WorkflowJob } from "../jobs/service";
import { ingestionBounds, type IngestionCallbackClaims } from "../jobs/contracts";
import { dispatchPrivateKey } from "../jobs/config";
import { signSourceRefToken, verifySourceRefToken } from "../jobs/signatures";
import { approvedEmbeddingDimensions } from "./config";
import { chunkExtractedPages } from "./chunker";
import { IngestionStageError, type ExtractedBlock, type ExtractedPageDraft } from "./contracts";
import { embedTexts } from "./embeddings";
import { extractDocumentContent } from "./extract";

type Environment = Readonly<Record<string, string | undefined>>;

export type IngestionStageOptions = {
  database?: JobDatabase;
  storage?: DocumentStorage;
  fetchImpl?: typeof fetch;
  env?: Environment;
  privateKey?: string;
  signal?: AbortSignal;
};

async function verifyAndConsumeCallback(
  transaction: JobTransaction,
  claims: IngestionCallbackClaims,
): Promise<WorkflowJob> {
  const [job] = await transaction
    .select()
    .from(workflowJobs)
    .where(eq(workflowJobs.id, claims.jobId))
    .for("update");

  if (
    !job ||
    job.kind !== "document_ingestion" ||
    job.documentId !== claims.documentId ||
    job.sourceSha256 !== claims.sourceSha256 ||
    job.pipelineVersion !== claims.pipelineVersion ||
    job.attemptId !== claims.attemptId ||
    job.attemptNumber !== claims.attemptNumber ||
    job.dispatchNonce !== claims.dispatchNonce ||
    job.dispatchCount === 0
  ) {
    throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
  }

  const [fresh] = await transaction
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(and(eq(workflowJobs.id, job.id), gt(workflowJobs.attemptDeadline, sql`clock_timestamp()`)));
  if (!fresh) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);

  const [receipt] = await transaction
    .insert(workflowNonceReceipts)
    .values({
      id: claims.jti,
      jobId: job.id,
      attemptId: job.attemptId,
      expiresAt: new Date((claims.exp + ingestionBounds.clockToleranceSeconds) * 1000),
    })
    .onConflictDoNothing()
    .returning({ id: workflowNonceReceipts.id });
  if (!receipt) throw new AuthFailure("WORKFLOW_REPLAY", 409);

  return job;
}

async function requireLiveRunLease(transaction: JobTransaction, job: WorkflowJob, executionId: string) {
  if (job.executionId !== executionId) throw new AuthFailure("INVALID_WORKFLOW_EXECUTION", 409);
  const [live] = await transaction
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(and(eq(workflowJobs.id, job.id), gt(workflowJobs.runLeaseUntil, sql`clock_timestamp()`)));
  if (!live) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
}

async function applyFailureTransition(
  transaction: JobTransaction,
  job: WorkflowJob,
  errorCode: string,
  transient: boolean,
) {
  const willRetry = transient && job.attemptNumber < ingestionBounds.maximumAttempts;
  if (willRetry) {
    await appendEvent(transaction, job, "retrying", 7);
    await transaction
      .update(workflowJobs)
      .set({
        state: "QUEUED",
        stage: null,
        errorCode,
        attemptId: randomUUID(),
        attemptNumber: job.attemptNumber + 1,
        dispatchNonce: randomUUID(),
        dispatchCount: 0,
        dispatchNextAt: sql`clock_timestamp() + interval '2 seconds'`,
        dispatchLeaseToken: null,
        dispatchLeaseUntil: null,
        dispatchAcceptedAt: null,
        executionId: null,
        runLeaseUntil: null,
        step: 0,
        attemptDeadline: sql`clock_timestamp() + ${ingestionBounds.attemptMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));
    if (job.documentId) {
      await transaction
        .update(sopDocuments)
        .set({ status: "UPLOADED", processingErrorCode: null, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(sopDocuments.id, job.documentId), ne(sopDocuments.status, "ACTIVE")));
    }
    return true;
  }

  await appendEvent(transaction, job, "failed", 8);
  await transaction
    .update(workflowJobs)
    .set({
      state: "FAILED",
      errorCode,
      runLeaseUntil: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(workflowJobs.id, job.id));
  if (job.documentId) {
    await transaction
      .update(sopDocuments)
      .set({ status: "FAILED", processingErrorCode: errorCode, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(sopDocuments.id, job.documentId), ne(sopDocuments.status, "ACTIVE")));
    await transaction.insert(auditEvents).values({
      actorId: job.ownerId,
      action: "document.ingestion_failed",
      targetId: job.documentId,
      outcome: "failed",
      metadata: { jobId: job.id, attemptNumber: job.attemptNumber, errorCode, transient },
    });
  }
  return false;
}

async function recordStageFailure(
  database: JobDatabase,
  claims: IngestionCallbackClaims,
  errorCode: string,
  transient: boolean,
) {
  await database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.id, claims.jobId))
      .for("update");
    if (
      !job ||
      job.kind !== "document_ingestion" ||
      job.attemptId !== claims.attemptId ||
      job.executionId !== claims.executionId ||
      job.state !== "RUNNING"
    ) {
      return;
    }
    await applyFailureTransition(transaction, job, errorCode, transient);
  });
}

export async function claimIngestionStage(
  claims: IngestionCallbackClaims,
  options: Pick<IngestionStageOptions, "database" | "privateKey"> = {},
) {
  const database = options.database ?? getDatabase();
  const privateKey = options.privateKey ?? dispatchPrivateKey();

  const claimed = await database.transaction(async (transaction) => {
    const job = await verifyAndConsumeCallback(transaction, claims);
    if (job.executionId) {
      if (job.executionId !== claims.executionId) throw new AuthFailure("WORKFLOW_ALREADY_CLAIMED", 409);
      if (job.state !== "RUNNING") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);
      await transaction
        .update(workflowJobs)
        .set({
          runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(workflowJobs.id, job.id));
      return { job, duplicate: true };
    }
    if (job.state !== "QUEUED") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);

    const [doc] = await transaction
      .select({ status: sopDocuments.status })
      .from(sopDocuments)
      .where(eq(sopDocuments.id, job.documentId!))
      .for("update");
    if (!doc) throw new AuthFailure("NOT_FOUND", 404);
    if (doc.status === "ACTIVE") throw new AuthFailure("DOCUMENT_ALREADY_ACTIVE", 409);

    await transaction
      .update(workflowJobs)
      .set({
        state: "RUNNING",
        stage: "claim",
        errorCode: null,
        executionId: claims.executionId,
        step: 1,
        runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    await transaction
      .update(sopDocuments)
      .set({
        status: "PROCESSING",
        latestJobId: job.id,
        processingErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(sopDocuments.id, job.documentId!));

    await appendEvent(transaction, job, "started", 1);
    await transaction.insert(auditEvents).values({
      actorId: job.ownerId,
      action: "document.ingestion_started",
      targetId: job.documentId!,
      outcome: "processing",
      metadata: { jobId: job.id, attemptNumber: job.attemptNumber },
    });

    return { job, duplicate: false };
  });

  const fileRefToken = await signSourceRefToken(
    {
      jobId: claimed.job.id,
      documentId: claimed.job.documentId!,
      sourceSha256: claimed.job.sourceSha256!,
      attemptId: claimed.job.attemptId,
      executionId: claims.executionId,
    },
    privateKey,
  );

  return { accepted: true, duplicate: claimed.duplicate, fileRefToken };
}

export async function renewSourceRefStage(
  claims: IngestionCallbackClaims,
  options: Pick<IngestionStageOptions, "database" | "privateKey"> = {},
) {
  const database = options.database ?? getDatabase();
  const privateKey = options.privateKey ?? dispatchPrivateKey();

  const active = await database.transaction(async (transaction) => {
    const job = await verifyAndConsumeCallback(transaction, claims);
    if (job.state !== "RUNNING") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);
    await requireLiveRunLease(transaction, job, claims.executionId);
    await transaction
      .update(workflowJobs)
      .set({
        runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));
    return job;
  });

  const fileRefToken = await signSourceRefToken(
    {
      jobId: active.id,
      documentId: active.documentId!,
      sourceSha256: active.sourceSha256!,
      attemptId: active.attemptId,
      executionId: claims.executionId,
    },
    privateKey,
  );

  return { accepted: true, fileRefToken };
}

export async function extractIngestionStage(
  claims: IngestionCallbackClaims,
  fileRefToken: string,
  options: IngestionStageOptions = {},
) {
  const database = options.database ?? getDatabase();
  const storage = options.storage ?? getDocumentStorage();
  const privateKey = options.privateKey ?? dispatchPrivateKey();

  const prepared = await database.transaction(async (transaction) => {
    const job = await verifyAndConsumeCallback(transaction, claims);
    await requireLiveRunLease(transaction, job, claims.executionId);
    if (job.step >= 2) return { duplicate: true as const, job };
    if (job.state !== "RUNNING" || job.step !== 1) throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);

    const [document] = await transaction.select().from(sopDocuments).where(eq(sopDocuments.id, job.documentId!));
    if (!document || document.sha256 !== job.sourceSha256) throw new AuthFailure("NOT_FOUND", 404);
    if (document.status === "ACTIVE") throw new AuthFailure("DOCUMENT_ALREADY_ACTIVE", 409);

    await transaction
      .update(workflowJobs)
      .set({
        stage: "extract",
        runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    return { duplicate: false as const, job, document };
  });

  if (prepared.duplicate) {
    return { accepted: true, duplicate: true };
  }

  // Verify the short-lived source-read token after consuming the callback nonce so failed calls cannot replay.
  const refClaims = await verifySourceRefToken(fileRefToken, privateKey);
  if (
    refClaims.jobId !== prepared.job.id ||
    refClaims.documentId !== prepared.job.documentId ||
    refClaims.sourceSha256 !== prepared.job.sourceSha256 ||
    refClaims.attemptId !== prepared.job.attemptId ||
    refClaims.executionId !== claims.executionId
  ) {
    throw new AuthFailure("INVALID_SOURCE_REF", 403);
  }

  let extracted;
  try {
    extracted = await extractDocumentContent({
      document: prepared.document,
      jobId: prepared.job.id,
      storage,
      fetchImpl: options.fetchImpl,
      env: options.env,
      signal: options.signal,
    });
  } catch (error) {
    const stageError = error instanceof IngestionStageError
      ? error
      : new IngestionStageError("EXTRACTION_UNAVAILABLE", true, 503);
    await recordStageFailure(database, claims, stageError.code, stageError.transient);
    throw new AuthFailure(stageError.code, stageError.status);
  }

  return database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.id, claims.jobId))
      .for("update");
    if (
      !job ||
      job.attemptId !== claims.attemptId ||
      job.executionId !== claims.executionId ||
      job.state !== "RUNNING" ||
      job.step !== 1
    ) {
      throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    }
    const [fresh] = await transaction
      .select({ id: workflowJobs.id })
      .from(workflowJobs)
      .where(and(eq(workflowJobs.id, job.id), gt(workflowJobs.attemptDeadline, sql`clock_timestamp()`)));
    if (!fresh) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);

    await transaction.delete(sopChunks).where(eq(sopChunks.jobId, job.id));
    await transaction.delete(sopExtractionPages).where(eq(sopExtractionPages.jobId, job.id));
    await transaction.delete(sopVerificationIssues).where(eq(sopVerificationIssues.jobId, job.id));

    if (extracted.pages.length > 0) {
      await transaction.insert(sopExtractionPages).values(
        extracted.pages.map((page) => ({
          documentId: job.documentId!,
          jobId: job.id,
          sourceSha256: job.sourceSha256!,
          pipelineVersion: job.pipelineVersion!,
          pageIndex: page.pageIndex,
          pageKind: page.pageKind,
          sourceLocationKind: page.sourceLocationKind,
          rawText: page.rawText,
          normalizedText: page.normalizedText,
          ocrConfidence: page.ocrConfidence,
          ocrModel: page.ocrModel,
          layoutMetadata: page.layoutMetadata,
          verificationStatus: "UNVERIFIED" as const,
        })),
      );
    }

    if (extracted.issues.length > 0) {
      await transaction.insert(sopVerificationIssues).values(
        extracted.issues.map((issue) => ({
          documentId: job.documentId!,
          jobId: job.id,
          pageIndex: issue.pageIndex,
          sectionPath: issue.sectionPath,
          severity: issue.severity,
          issueCode: issue.issueCode,
          summary: issue.summary,
          region: issue.region,
        })),
      );
    }

    if (extracted.previewKey) {
      await transaction
        .update(sopDocuments)
        .set({ previewKey: extracted.previewKey, updatedAt: sql`clock_timestamp()` })
        .where(eq(sopDocuments.id, job.documentId!));
    }

    await transaction
      .update(workflowJobs)
      .set({
        step: 2,
        stage: "extract",
        runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    await appendEvent(transaction, job, "processing", 2);

    return {
      accepted: true,
      duplicate: false,
      pageCount: extracted.pages.length,
      issueCount: extracted.issues.length,
      hasPreview: Boolean(extracted.previewKey),
    };
  });
}

export async function chunkIngestionStage(
  claims: IngestionCallbackClaims,
  options: Pick<IngestionStageOptions, "database"> = {},
) {
  const database = options.database ?? getDatabase();

  const outcome = await database.transaction(async (transaction) => {
    const job = await verifyAndConsumeCallback(transaction, claims);
    await requireLiveRunLease(transaction, job, claims.executionId);
    if (job.step >= 3) return { accepted: true as const, duplicate: true as const };
    if (job.state !== "RUNNING" || job.step !== 2) throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);

    const [document] = await transaction.select().from(sopDocuments).where(eq(sopDocuments.id, job.documentId!));
    if (!document) throw new AuthFailure("NOT_FOUND", 404);

    const persistedPages = await transaction
      .select()
      .from(sopExtractionPages)
      .where(eq(sopExtractionPages.jobId, job.id))
      .orderBy(asc(sopExtractionPages.pageIndex));

    const drafts: ExtractedPageDraft[] = persistedPages.map((page) => {
      const metadata = page.layoutMetadata as { blocks?: ExtractedBlock[] } | null;
      return {
        pageIndex: page.pageIndex,
        pageKind: page.pageKind,
        sourceLocationKind: page.sourceLocationKind,
        rawText: page.rawText,
        normalizedText: page.normalizedText,
        ocrConfidence: page.ocrConfidence,
        ocrModel: page.ocrModel,
        layoutMetadata: page.layoutMetadata,
        blocks: Array.isArray(metadata?.blocks) ? metadata.blocks : undefined,
      };
    });

    const chunks = chunkExtractedPages(drafts, document.mimeType);
    if (chunks.length === 0) {
      await applyFailureTransition(transaction, job, "NO_EXTRACTABLE_TEXT", false);
      return { failedCode: "NO_EXTRACTABLE_TEXT" as const };
    }

    await transaction.delete(sopChunks).where(eq(sopChunks.jobId, job.id));
    await transaction.insert(sopChunks).values(
      chunks.map((chunk) => ({
        documentId: job.documentId!,
        jobId: job.id,
        sourceSha256: job.sourceSha256!,
        pipelineVersion: job.pipelineVersion!,
        sequence: chunk.sequence,
        sectionPath: chunk.sectionPath,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        contentType: chunk.contentType,
        text: chunk.text,
        contentHash: chunk.contentHash,
        tokenEstimate: chunk.tokenEstimate,
      })),
    );

    await transaction
      .update(workflowJobs)
      .set({
        step: 3,
        stage: "chunk",
        runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    return { accepted: true as const, duplicate: false as const, chunkCount: chunks.length };
  });

  if ("failedCode" in outcome && outcome.failedCode) {
    throw new AuthFailure(outcome.failedCode, 422);
  }
  return outcome;
}

export async function embedIngestionStage(
  claims: IngestionCallbackClaims,
  options: Pick<IngestionStageOptions, "database" | "fetchImpl" | "env" | "signal"> = {},
) {
  const database = options.database ?? getDatabase();

  const prepared = await database.transaction(async (transaction) => {
    const job = await verifyAndConsumeCallback(transaction, claims);
    await requireLiveRunLease(transaction, job, claims.executionId);
    if (job.step >= 4) return { duplicate: true as const };
    if (job.state !== "RUNNING" || job.step !== 3) throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);

    const chunks = await transaction
      .select({ id: sopChunks.id, sequence: sopChunks.sequence, text: sopChunks.text })
      .from(sopChunks)
      .where(eq(sopChunks.jobId, job.id))
      .orderBy(asc(sopChunks.sequence));
    if (chunks.length === 0) throw new AuthFailure("INGESTION_INCOMPLETE_ARTIFACTS", 409);

    await transaction
      .update(workflowJobs)
      .set({
        stage: "embed",
        runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    return { duplicate: false as const, job, chunks };
  });

  if (prepared.duplicate) return { accepted: true, duplicate: true };

  let embedded;
  try {
    embedded = await embedTexts(
      prepared.chunks.map((chunk) => chunk.text),
      { env: options.env, fetchImpl: options.fetchImpl, signal: options.signal },
    );
  } catch (error) {
    const stageError = error instanceof IngestionStageError
      ? error
      : new IngestionStageError("EMBEDDING_PROVIDER_TRANSIENT", true, 503);
    await recordStageFailure(database, claims, stageError.code, stageError.transient);
    throw new AuthFailure(stageError.code, stageError.status);
  }

  return database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(workflowJobs)
      .where(eq(workflowJobs.id, claims.jobId))
      .for("update");
    if (
      !job ||
      job.attemptId !== claims.attemptId ||
      job.executionId !== claims.executionId ||
      job.state !== "RUNNING" ||
      job.step !== 3
    ) {
      throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);
    }
    const [fresh] = await transaction
      .select({ id: workflowJobs.id })
      .from(workflowJobs)
      .where(and(eq(workflowJobs.id, job.id), gt(workflowJobs.attemptDeadline, sql`clock_timestamp()`)));
    if (!fresh) throw new AuthFailure("STALE_WORKFLOW_ATTEMPT", 409);

    for (let index = 0; index < prepared.chunks.length; index++) {
      await transaction
        .update(sopChunks)
        .set({
          embedding: embedded.vectors[index],
          embeddingModel: embedded.model,
          embeddingDimensions: embedded.dimensions,
        })
        .where(and(eq(sopChunks.id, prepared.chunks[index].id), eq(sopChunks.jobId, job.id)));
    }

    await transaction
      .update(workflowJobs)
      .set({
        step: 4,
        stage: "embed",
        runLeaseUntil: sql`clock_timestamp() + ${ingestionBounds.runLeaseMilliseconds} * interval '1 millisecond'`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    return {
      accepted: true,
      duplicate: false,
      embeddedCount: prepared.chunks.length,
      embeddingModel: embedded.model,
      embeddingDimensions: embedded.dimensions,
    };
  });
}

export async function completeIngestionStage(
  claims: IngestionCallbackClaims,
  options: Pick<IngestionStageOptions, "database"> = {},
) {
  const database = options.database ?? getDatabase();

  return database.transaction(async (transaction) => {
    const job = await verifyAndConsumeCallback(transaction, claims);
    if (job.executionId !== claims.executionId) throw new AuthFailure("INVALID_WORKFLOW_EXECUTION", 409);
    if (job.state === "COMPLETED" && job.step === 5) {
      return { accepted: true, duplicate: true, status: "PENDING_VERIFICATION" as const };
    }
    await requireLiveRunLease(transaction, job, claims.executionId);
    if (job.state !== "RUNNING" || job.step !== 4) throw new AuthFailure("INVALID_WORKFLOW_ORDER", 409);

    const [pageSummary] = await transaction
      .select({ total: count() })
      .from(sopExtractionPages)
      .where(eq(sopExtractionPages.jobId, job.id));
    const [chunkSummary] = await transaction
      .select({ total: count() })
      .from(sopChunks)
      .where(eq(sopChunks.jobId, job.id));
    const [missingEmbeddings] = await transaction
      .select({ total: count() })
      .from(sopChunks)
      .where(
        and(
          eq(sopChunks.jobId, job.id),
          or(isNull(sopChunks.embedding), ne(sopChunks.embeddingDimensions, approvedEmbeddingDimensions)),
        ),
      );
    const [issueSummary] = await transaction
      .select({ total: count() })
      .from(sopVerificationIssues)
      .where(eq(sopVerificationIssues.jobId, job.id));

    if (pageSummary.total === 0 || chunkSummary.total === 0 || missingEmbeddings.total > 0) {
      throw new AuthFailure("INGESTION_INCOMPLETE_ARTIFACTS", 409);
    }

    const [doc] = await transaction
      .select({ status: sopDocuments.status })
      .from(sopDocuments)
      .where(eq(sopDocuments.id, job.documentId!))
      .for("update");
    if (!doc) throw new AuthFailure("NOT_FOUND", 404);
    if (doc.status === "ACTIVE") throw new AuthFailure("DOCUMENT_ALREADY_ACTIVE", 409);

    await transaction
      .update(workflowJobs)
      .set({
        state: "COMPLETED",
        stage: "complete",
        step: 5,
        errorCode: null,
        runLeaseUntil: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(workflowJobs.id, job.id));

    // Ingestion never activates a document; manual Admin verification happens in S06.
    await transaction
      .update(sopDocuments)
      .set({
        status: "PENDING_VERIFICATION",
        processedJobId: job.id,
        processedPipelineVersion: job.pipelineVersion,
        processedAttemptId: job.attemptId,
        processingErrorCode: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(and(eq(sopDocuments.id, job.documentId!), ne(sopDocuments.status, "ACTIVE")));

    await transaction.insert(auditEvents).values({
      actorId: job.ownerId,
      action: "document.ingestion_completed",
      targetId: job.documentId!,
      outcome: "pending_verification",
      metadata: {
        jobId: job.id,
        pageCount: pageSummary.total,
        chunkCount: chunkSummary.total,
        issueCount: issueSummary.total,
      },
    });

    return {
      accepted: true,
      duplicate: false,
      status: "PENDING_VERIFICATION" as const,
      pageCount: pageSummary.total,
      chunkCount: chunkSummary.total,
      issueCount: issueSummary.total,
    };
  });
}

export async function failIngestionStage(
  claims: IngestionCallbackClaims,
  input: { errorCode: string; transient: boolean },
  options: Pick<IngestionStageOptions, "database"> = {},
) {
  const database = options.database ?? getDatabase();

  return database.transaction(async (transaction) => {
    const job = await verifyAndConsumeCallback(transaction, claims);
    if (job.state === "FAILED") return { accepted: true, duplicate: true, retrying: false };
    if (job.state === "COMPLETED") throw new AuthFailure("INVALID_WORKFLOW_STATE", 409);
    if (job.executionId && job.executionId !== claims.executionId) {
      throw new AuthFailure("INVALID_WORKFLOW_EXECUTION", 409);
    }

    const retrying = await applyFailureTransition(transaction, job, input.errorCode, input.transient);
    return { accepted: true, duplicate: false, retrying };
  });
}
