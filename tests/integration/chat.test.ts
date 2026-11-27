import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRawSseFrame } from "../../src/components/chat/client";
import { AnswerStageError } from "../../src/server/answers/contracts";
import type { CurrentAccount } from "../../src/server/auth/authorization";
import { AuthFailure } from "../../src/server/auth/errors";
import {
  claimChatStage,
  createChatEventStream,
  createChatTurn,
  generateChatStage,
  getOwnedConversation,
  listOwnedConversations,
  noEvidenceFallbackMessage,
  retrieveChatStage,
  validateChatStage,
} from "../../src/server/chat";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import {
  deleteDocument,
  finalizeDocumentUpload,
  initializeDocumentUpload,
} from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import { approvedEmbeddingDimensions } from "../../src/server/ingestion/config";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
} from "../../src/server/ingestion/service";
import {
  chatWorkflowVersion,
  ingestionWorkflowVersion,
  type ChatCallbackClaims,
  type ChatCallbackPurpose,
  type IngestionCallbackClaims,
  type IngestionCallbackPurpose,
} from "../../src/server/jobs/contracts";
import { verifyDocument } from "../../src/server/verification/service";
import { seedSyntheticAccount, seedSyntheticSession } from "../fixtures/auth";
import { syntheticPdf } from "../fixtures/document-files";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });

const workerEnv = {
  CONVERSION_URL: "http://convert-worker:8092",
  PADDLEOCR_URL: "http://paddleocr:8091",
  SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
  SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED: "1",
  SOP_LOCAL_ANSWER_FIXTURE_ENABLED: "1",
  AUTH_BASE_URL: "http://127.0.0.1:3000",
};

const dispatchKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const seededDocumentIds: string[] = [];
const seededConversationIds: string[] = [];
const seededUserIds: string[] = [];

let adminAccount: CurrentAccount;
let staffAccount: CurrentAccount;
let otherStaffAccount: CurrentAccount;

class MemoryStorage implements DocumentStorage {
  objects = new Map<string, StoredObject>();
  async authorizeUpload(object: { mimeType: string; sizeBytes: number; uploadExpiresAt: Date }) {
    return {
      url: "http://127.0.0.1/synthetic-only",
      method: "PUT" as const,
      headers: { "Content-Type": object.mimeType, "If-None-Match": "*" as const },
      sizeBytes: object.sizeBytes,
      expiresAt: object.uploadExpiresAt.toISOString(),
    };
  }
  async read(key: string) {
    return this.objects.get(key) ?? null;
  }
  async create(key: string, object: StoredObject) {
    if (this.objects.has(key)) throw new Error("PreconditionFailed");
    this.objects.set(key, { bytes: Buffer.from(object.bytes), contentType: object.contentType });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function makeBasisVector(primaryIndex: number, secondaryIndex?: number, secondaryWeight = 0.25): number[] {
  const vector = new Array<number>(approvedEmbeddingDimensions).fill(0);
  vector[primaryIndex % approvedEmbeddingDimensions] = 1;
  if (secondaryIndex !== undefined) {
    vector[secondaryIndex % approvedEmbeddingDimensions] = secondaryWeight;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => Number((value / norm).toFixed(7)));
}

function makeIngestionClaims(
  job: typeof schema.workflowJobs.$inferSelect,
  purpose: IngestionCallbackPurpose,
  executionId = "exec-s11-ing",
): IngestionCallbackClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    workflow: ingestionWorkflowVersion,
    jobId: job.id,
    documentId: job.documentId!,
    sourceSha256: job.sourceSha256!,
    pipelineVersion: job.pipelineVersion!,
    attemptId: job.attemptId,
    attemptNumber: job.attemptNumber,
    dispatchNonce: job.dispatchNonce,
    jti: `${job.attemptId}:${executionId}:${purpose}:${randomUUID().slice(0, 8)}`,
    iat: now,
    nbf: now,
    exp: now + 30,
    iss: "sop-n8n",
    aud: "sop-app",
    purpose,
    method: "POST",
    path: `/api/internal/ingestion/${job.id}/${purpose}`,
    executionId,
  };
}

function makeChatClaims(
  job: typeof schema.workflowJobs.$inferSelect,
  purpose: ChatCallbackPurpose,
  executionId = "exec-s11-chat",
  jtiOverride?: string,
): ChatCallbackClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    workflow: chatWorkflowVersion,
    jobId: job.id,
    conversationId: job.conversationId!,
    requestKey: job.requestKey,
    attemptId: job.attemptId,
    attemptNumber: job.attemptNumber,
    dispatchNonce: job.dispatchNonce,
    jti: jtiOverride ?? `${job.attemptId}:${executionId}:${purpose}:${randomUUID().slice(0, 8)}`,
    iat: now,
    nbf: now,
    exp: now + 30,
    iss: "sop-n8n",
    aud: "sop-app",
    purpose,
    method: "POST",
    path: `/api/internal/chat/${job.id}/${purpose}`,
    executionId,
  };
}

function pdfWorkerFetch(extractedText: string): typeof fetch {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/pdf/inspect-and-extract")) {
      return Response.json({
        result: "PASS",
        pageCount: 1,
        pages: [{ pageIndex: 1, nativeText: extractedText, imageCount: 0, maxImagePixels: 0 }],
      });
    }
    throw new Error(`Unexpected PDF worker URL: ${url}`);
  });
}

async function seedActiveSop(options: {
  title: string;
  extractedText: string;
  vectorIndex: number;
}): Promise<{ documentId: string; chunkIds: string[] }> {
  const storage = new MemoryStorage();
  const bytes = syntheticPdf();
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const init = await initializeDocumentUpload(
    adminAccount,
    {
      requestKey: randomUUID(),
      title: options.title,
      fileName: `${options.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: bytes.length,
      sha256,
    },
    database,
    storage,
  );
  const documentId = init.document.id;
  seededDocumentIds.push(documentId);

  const [intent] = await database
    .select()
    .from(schema.documentUploadIntents)
    .where(eq(schema.documentUploadIntents.id, documentId));
  storage.objects.set(intent.stagingKey, { bytes, contentType: "application/pdf" });

  await finalizeDocumentUpload(adminAccount, documentId, database, storage);

  const [job] = await database
    .select()
    .from(schema.workflowJobs)
    .where(
      and(
        eq(schema.workflowJobs.documentId, documentId),
        eq(schema.workflowJobs.kind, "document_ingestion"),
      ),
    );

  await database
    .update(schema.workflowJobs)
    .set({
      dispatchCount: 1,
      dispatchNextAt: sql`clock_timestamp() + interval '60 seconds'`,
    })
    .where(eq(schema.workflowJobs.id, job.id));

  const stageOpts = {
    database,
    storage,
    env: workerEnv,
    privateKey: dispatchKeys.privateKey,
    fetchImpl: pdfWorkerFetch(options.extractedText),
  };

  const claimed = await claimIngestionStage(makeIngestionClaims(job, "claim"), stageOpts);
  await extractIngestionStage(makeIngestionClaims(job, "extract"), claimed.fileRefToken!, stageOpts);
  await chunkIngestionStage(makeIngestionClaims(job, "chunk"), stageOpts);
  await embedIngestionStage(makeIngestionClaims(job, "embed"), stageOpts);
  await completeIngestionStage(makeIngestionClaims(job, "complete"), stageOpts);

  const chunks = await database
    .select({ id: schema.sopChunks.id })
    .from(schema.sopChunks)
    .where(eq(schema.sopChunks.documentId, documentId));
  const basisVector = makeBasisVector(options.vectorIndex);
  await database
    .update(schema.sopChunks)
    .set({ embedding: basisVector })
    .where(eq(schema.sopChunks.documentId, documentId));

  await verifyDocument(
    adminAccount,
    documentId,
    {
      decision: "APPROVE",
      expectedSha256: job.sourceSha256!,
      expectedJobId: job.id,
      expectedPipelineVersion: job.pipelineVersion!,
      expectedAttemptId: job.attemptId,
      explicitConfirmation: true,
      notes: "Verified synthetic SOP for S11 chat integration tests",
    },
    database,
  );

  return { documentId, chunkIds: chunks.map((row) => row.id) };
}

async function markChatJobDispatched(jobId: string) {
  const [job] = await database
    .update(schema.workflowJobs)
    .set({
      dispatchCount: 1,
      dispatchNextAt: sql`clock_timestamp() + interval '60 seconds'`,
    })
    .where(eq(schema.workflowJobs.id, jobId))
    .returning();
  return job;
}

describe("S11 safe chat SSE, staged n8n callbacks, and persistence (PostgreSQL + pgvector)", () => {
  const tag = `S11TAG${randomUUID().slice(0, 6).toUpperCase()}`;
  let autoclaveDocId = "";
  let purgeDocId = "";
  const autoclaveVectorIndex = 110;
  const purgeVectorIndex = 111;

  beforeAll(async () => {
    process.env.DOCUMENT_UPLOAD_QUOTA_BYTES ??= String(500 * 1024 * 1024);
    adminAccount = await seedSyntheticSession(
      database,
      await seedSyntheticAccount(database, "ADMIN"),
    );
    staffAccount = await seedSyntheticSession(
      database,
      await seedSyntheticAccount(database, "STAFF"),
    );
    otherStaffAccount = await seedSyntheticSession(
      database,
      await seedSyntheticAccount(database, "STAFF"),
    );
    seededUserIds.push(adminAccount.id, staffAccount.id, otherStaffAccount.id);

    const autoclave = await seedActiveSop({
      title: `${tag} SOP-901 Autoclave Sterilization`,
      vectorIndex: autoclaveVectorIndex,
      extractedText: [
        `Section 4.1 ${tag} Autoclave Sterilization Procedure`,
        `1. Verify chamber temperature reaches 121.0 °C minimum for ${tag} autoclave cycle.`,
        `2. Maintain 15 psi steam pressure for 20 minutes continuously.`,
        `3. Do not open chamber door until internal pressure drops below 0.2 bar.`,
      ].join("\n"),
    });
    autoclaveDocId = autoclave.documentId;

    const purge = await seedActiveSop({
      title: `${tag} SOP-902 Nitrogen Line Purge`,
      vectorIndex: purgeVectorIndex,
      extractedText: [
        `Section 2.1 ${tag} Nitrogen Line Purge Procedure`,
        `1. Close feed valve V-401 before starting ${tag} nitrogen purge.`,
        `2. Flush manifold at 45 L/min for 12 minutes until oxygen reads below 0.5 %.`,
      ].join("\n"),
    });
    purgeDocId = purge.documentId;
  });

  afterAll(async () => {
    try {
      if (seededConversationIds.length > 0) {
        await database
          .delete(schema.workflowJobs)
          .where(inArray(schema.workflowJobs.conversationId, seededConversationIds))
          .catch(() => undefined);
        await database
          .delete(schema.chatConversations)
          .where(inArray(schema.chatConversations.id, seededConversationIds))
          .catch(() => undefined);
      }
      for (const docId of seededDocumentIds) {
        await deleteDocument(adminAccount, docId, database).catch(() => undefined);
        await database
          .delete(schema.sopChunks)
          .where(eq(schema.sopChunks.documentId, docId))
          .catch(() => undefined);
        await database
          .delete(schema.sopExtractionPages)
          .where(eq(schema.sopExtractionPages.documentId, docId))
          .catch(() => undefined);
        await database
          .delete(schema.sopVerificationIssues)
          .where(eq(schema.sopVerificationIssues.documentId, docId))
          .catch(() => undefined);
      }
      if (seededUserIds.length > 0) {
        await database
          .delete(schema.authSessions)
          .where(inArray(schema.authSessions.userId, seededUserIds))
          .catch(() => undefined);
      }
    } finally {
      await connection.end();
    }
  });

  it("streams allowlisted progress ONLY before deterministic+judge PASS, then emits verified answer and deletes draft artifacts", async () => {
    const requestKey = randomUUID();
    const created = await createChatTurn(
      staffAccount,
      {
        requestKey,
        question: `What are the ${tag} autoclave sterilization steps and pressure limits?`,
      },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(created.conversationId);
    const job = await markChatJobDispatched(created.jobId);

    const stageOptions = {
      database,
      env: workerEnv,
      retrievalOptions: {
        embedTextsImpl: async () => ({
          model: "text-embedding-3-small",
          dimensions: approvedEmbeddingDimensions,
          vectors: [makeBasisVector(autoclaveVectorIndex)],
        }),
      },
    };

    expect(await claimChatStage(makeChatClaims(job, "claim"), stageOptions)).toEqual({
      ok: true,
      terminal: false,
    });
    expect(await retrieveChatStage(makeChatClaims(job, "retrieve"), stageOptions)).toEqual({
      ok: true,
      terminal: false,
    });
    expect(await generateChatStage(makeChatClaims(job, "generate"), stageOptions)).toEqual({
      ok: true,
      terminal: false,
    });

    // Private candidate draft exists in chat_turn_artifacts right now, BEFORE validation passes.
    const [artifactBeforeValidate] = await database
      .select()
      .from(schema.chatTurnArtifacts)
      .where(eq(schema.chatTurnArtifacts.jobId, job.id));
    expect(artifactBeforeValidate?.candidatePayload?.claims.length).toBeGreaterThanOrEqual(3);

    // Capture raw SSE bytes right now (while job is at validating stage) — ZERO procedural draft text may cross the wire!
    const preValidationStream = await createChatEventStream(
      new Request(`http://127.0.0.1:3000/api/chat/jobs/${job.id}/events`),
      job.id,
      {
        account: staffAccount,
        database,
        streamMilliseconds: 120,
        pollMilliseconds: 20,
        heartbeatMilliseconds: 60,
      },
    );
    const preValidationBytes = await preValidationStream.text();
    expect(preValidationBytes).toContain("event: accepted\n");
    expect(preValidationBytes).toContain("event: retrieving\n");
    expect(preValidationBytes).toContain("event: reranking\n");
    expect(preValidationBytes).toContain("event: generating\n");
    expect(preValidationBytes).toContain("event: validating\n");
    expect(preValidationBytes).not.toContain("121.0");
    expect(preValidationBytes).not.toContain("15 psi");
    expect(preValidationBytes).not.toContain("0.2 bar");
    expect(preValidationBytes).not.toContain("event: completed\n");

    // Extract last event id before validation to test Last-Event-ID reconnect resume!
    const preEventIds = Array.from(preValidationBytes.matchAll(/^id:\s*(.+)$/gm)).map((m) => m[1]);
    expect(preEventIds.length).toBe(5);
    const resumeCursor = preEventIds[preEventIds.length - 1];

    // Now run validate stage (deterministic + independent judge + live ACTIVE citation check)
    expect(await validateChatStage(makeChatClaims(job, "validate"), stageOptions)).toEqual({
      ok: true,
      terminal: true,
    });

    // Private staging artifacts MUST be deleted immediately on commit
    const remainingArtifacts = await database
      .select()
      .from(schema.chatTurnArtifacts)
      .where(eq(schema.chatTurnArtifacts.jobId, job.id));
    expect(remainingArtifacts).toHaveLength(0);

    // Reconnect with Last-Event-ID -> receives ONLY the newly emitted completed event!
    const resumedStream = await createChatEventStream(
      new Request(`http://127.0.0.1:3000/api/chat/jobs/${job.id}/events`, {
        headers: { "Last-Event-ID": resumeCursor },
      }),
      job.id,
      { account: staffAccount, database, pollMilliseconds: 20 },
    );
    const resumedBytes = await resumedStream.text();
    expect(resumedBytes).not.toContain("event: accepted\n");
    expect(resumedBytes).toContain("event: completed\n");

    const parsed = parseRawSseFrame(resumedBytes.trim());
    expect(parsed?.type).toBe("completed");
    if (parsed?.type === "completed") {
      expect(parsed.data.isProcedural).toBe(true);
      expect(parsed.data.answer).toContain("121.0 °C");
      expect(parsed.data.answer).toContain("15 psi");
      expect(parsed.data.sources).toHaveLength(1);
      expect(parsed.data.sources[0].documentId).toBe(autoclaveDocId);
      expect(parsed.data.sources[0].sourcePath).toContain(`/api/documents/${autoclaveDocId}/source`);
    }

    // Follow-up turn in the same conversation uses persisted history for rewriting and fresh ACTIVE retrieval
    const followUp = await createChatTurn(
      staffAccount,
      {
        conversationId: created.conversationId,
        requestKey: randomUUID(),
        question: `What pressure must ${tag} chamber drop below before opening the door?`,
      },
      { database, dispatchDelaySeconds: 60 },
    );
    const followUpJob = await markChatJobDispatched(followUp.jobId);
    expect(await claimChatStage(makeChatClaims(followUpJob, "claim"), stageOptions)).toEqual({
      ok: true,
      terminal: false,
    });
    expect(await retrieveChatStage(makeChatClaims(followUpJob, "retrieve"), stageOptions)).toEqual({
      ok: true,
      terminal: false,
    });
    expect(await generateChatStage(makeChatClaims(followUpJob, "generate"), stageOptions)).toEqual({
      ok: true,
      terminal: false,
    });
    expect(await validateChatStage(makeChatClaims(followUpJob, "validate"), stageOptions)).toEqual({
      ok: true,
      terminal: true,
    });

    const detail = await getOwnedConversation(staffAccount, created.conversationId, database);
    expect(detail.messages).toHaveLength(4);
    expect(detail.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(detail.messages[1].sources[0].available).toBe(true);
    expect(detail.messages[3].sources[0].documentId).toBe(autoclaveDocId);

    const listed = await listOwnedConversations(staffAccount, { database });
    expect(listed.conversations.some((c) => c.id === created.conversationId)).toBe(true);
  });

  it("enforces request idempotency, callback replay protection, DB owner/PASSED triggers, and cross-user denial", async () => {
    const requestKey = randomUUID();
    const first = await createChatTurn(
      staffAccount,
      { requestKey, question: `Explain ${tag} autoclave temperature check` },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(first.conversationId);

    // Exact duplicate retry -> same jobId, created: false, single user message
    const duplicate = await createChatTurn(
      staffAccount,
      { requestKey, question: `Explain ${tag} autoclave temperature check` },
      { database, dispatchDelaySeconds: 60 },
    );
    expect(duplicate.created).toBe(false);
    expect(duplicate.jobId).toBe(first.jobId);

    // Different input with same requestKey -> 409 IDEMPOTENCY_CONFLICT
    await expect(
      createChatTurn(
        staffAccount,
        { requestKey, question: "Different question on same key" },
        { database, dispatchDelaySeconds: 60 },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });

    // Cross-user conversation/SSE/turn denial (404)
    await expect(
      getOwnedConversation(otherStaffAccount, first.conversationId, database),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      createChatTurn(
        otherStaffAccount,
        { conversationId: first.conversationId, requestKey: randomUUID(), question: "Injected" },
        { database, dispatchDelaySeconds: 60 },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(
      createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${first.jobId}/events`),
        first.jobId,
        { account: otherStaffAccount, database },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    // Callback JWT replay fails with 409 WORKFLOW_REPLAY
    const job = await markChatJobDispatched(first.jobId);
    const replayJti = `${job.attemptId}:exec-replay:claim`;
    await claimChatStage(makeChatClaims(job, "claim", "exec-replay", replayJti), {
      database,
      env: workerEnv,
    });
    await expect(
      claimChatStage(makeChatClaims(job, "claim", "exec-replay", replayJti), {
        database,
        env: workerEnv,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_REPLAY", status: 409 });

    // DB trigger: cross-user message injection blocked (23514)
    await expect(
      database.insert(schema.chatMessages).values({
        conversationId: first.conversationId,
        ownerId: otherStaffAccount.id,
        role: "user",
        content: "Cross user injection",
        requestKey: randomUUID(),
        validationStatus: "USER_INPUT",
        isProcedural: false,
      }),
    ).rejects.toThrow();

    // DB CHECK: NO_EVIDENCE with altered fallback text blocked (23514)
    await expect(
      database.insert(schema.chatMessages).values({
        conversationId: first.conversationId,
        ownerId: staffAccount.id,
        role: "assistant",
        content: "Altered fallback text",
        requestKey: randomUUID(),
        validationStatus: "NO_EVIDENCE",
        isProcedural: false,
      }),
    ).rejects.toThrow();

    // DB trigger: attaching source to NO_EVIDENCE message blocked (23514)
    const [noEvidenceMsg] = await database
      .insert(schema.chatMessages)
      .values({
        conversationId: first.conversationId,
        ownerId: staffAccount.id,
        role: "assistant",
        content: noEvidenceFallbackMessage,
        requestKey: randomUUID(),
        validationStatus: "NO_EVIDENCE",
        isProcedural: false,
      })
      .returning();
    await expect(
      database.insert(schema.chatMessageSources).values({
        messageId: noEvidenceMsg.id,
        documentId: autoclaveDocId,
        chunkId: randomUUID(),
        sopTitle: "Fake",
        sectionPath: "Section 1",
        citationOrder: 0,
      }),
    ).rejects.toThrow();
  });

  it("blocks release on mid-flight user deactivation, judge rejection, provider failure, and unsupported questions", async () => {
    // 1. Mid-flight user deactivation stops validation commit and SSE
    const ephemeralUser = await seedSyntheticSession(
      database,
      await seedSyntheticAccount(database, "STAFF"),
    );
    seededUserIds.push(ephemeralUser.id);

    const turn = await createChatTurn(
      ephemeralUser,
      { requestKey: randomUUID(), question: `Steps for ${tag} autoclave sterilization` },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(turn.conversationId);
    const job = await markChatJobDispatched(turn.jobId);
    const opts = {
      database,
      env: workerEnv,
      retrievalOptions: {
        embedTextsImpl: async () => ({
          model: "text-embedding-3-small",
          dimensions: approvedEmbeddingDimensions,
          vectors: [makeBasisVector(autoclaveVectorIndex)],
        }),
      },
    };
    await claimChatStage(makeChatClaims(job, "claim"), opts);
    await retrieveChatStage(makeChatClaims(job, "retrieve"), opts);
    await generateChatStage(makeChatClaims(job, "generate"), opts);

    // Deactivate user mid-flight (trigger also revokes sessions)
    await database
      .update(schema.authUsers)
      .set({ active: false })
      .where(eq(schema.authUsers.id, ephemeralUser.id));

    const postDeactivate = await validateChatStage(makeChatClaims(job, "validate"), opts);
    expect(postDeactivate).toEqual({ ok: true, terminal: true });

    const [failedJob] = await database
      .select()
      .from(schema.workflowJobs)
      .where(eq(schema.workflowJobs.id, job.id));
    expect(failedJob.state).toBe("FAILED");
    expect(failedJob.errorCode).toBe("CHAT_ACCOUNT_REVOKED");
    expect(failedJob.assistantMessageId).toBeNull();

    // SSE rejects deactivated user (401)
    await expect(
      createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${job.id}/events`),
        job.id,
        { account: ephemeralUser, database },
      ),
    ).rejects.toBeInstanceOf(AuthFailure);

    // 2. Judge rejection emits safe failed SSE with zero draft text (never No SOP found)
    const judgeFailTurn = await createChatTurn(
      staffAccount,
      { requestKey: randomUUID(), question: `Steps for ${tag} autoclave sterilization` },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(judgeFailTurn.conversationId);
    const judgeFailJob = await markChatJobDispatched(judgeFailTurn.jobId);
    await claimChatStage(makeChatClaims(judgeFailJob, "claim"), opts);
    await retrieveChatStage(makeChatClaims(judgeFailJob, "retrieve"), opts);
    await generateChatStage(makeChatClaims(judgeFailJob, "generate"), opts);
    await validateChatStage(makeChatClaims(judgeFailJob, "validate"), {
      ...opts,
      judgeCandidateImpl: async () => ({
        passed: false,
        overallVerdict: "FAIL",
        claimVerdicts: [{ claimIndex: 0, verdict: "UNSUPPORTED", reasonCode: "TEST_REJECT" }],
      }),
    });

    const judgeFailWire = await (
      await createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${judgeFailJob.id}/events`),
        judgeFailJob.id,
        { account: staffAccount, database, pollMilliseconds: 15 },
      )
    ).text();
    expect(judgeFailWire).toContain("event: failed\n");
    expect(judgeFailWire).toContain('"errorCode":"ANSWER_JUDGE_REJECTED"');
    expect(judgeFailWire).not.toContain("121.0");
    expect(judgeFailWire).not.toContain(noEvidenceFallbackMessage);

    // 3. Provider failure during generate emits safe retryable failed SSE
    const providerFailTurn = await createChatTurn(
      staffAccount,
      { requestKey: randomUUID(), question: `Steps for ${tag} autoclave sterilization` },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(providerFailTurn.conversationId);
    const providerFailJob = await markChatJobDispatched(providerFailTurn.jobId);
    await claimChatStage(makeChatClaims(providerFailJob, "claim"), opts);
    await retrieveChatStage(makeChatClaims(providerFailJob, "retrieve"), opts);
    await generateChatStage(makeChatClaims(providerFailJob, "generate"), {
      ...opts,
      generateCandidateImpl: async () => {
        throw new AnswerStageError("ANSWER_PROVIDER_TRANSIENT", true, 503);
      },
    });
    const providerFailWire = await (
      await createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${providerFailJob.id}/events`),
        providerFailJob.id,
        { account: staffAccount, database, pollMilliseconds: 15 },
      )
    ).text();
    expect(providerFailWire).toContain("event: failed\n");
    expect(providerFailWire).toContain('"errorCode":"ANSWER_PROVIDER_TRANSIENT"');
    expect(providerFailWire).toContain('"retryable":true');
    expect(providerFailWire).not.toContain(noEvidenceFallbackMessage);

    // 4. Unsupported question emits exact No SOP found for this question with sources: []
    const unsupportedTurn = await createChatTurn(
      staffAccount,
      {
        requestKey: randomUUID(),
        question: "What is the parking garage validation schedule for external contractors?",
      },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(unsupportedTurn.conversationId);
    const unsupportedJob = await markChatJobDispatched(unsupportedTurn.jobId);
    await claimChatStage(makeChatClaims(unsupportedJob, "claim"), opts);
    const retrieveRes = await retrieveChatStage(makeChatClaims(unsupportedJob, "retrieve"), {
      database,
      env: workerEnv,
      retrievalOptions: {
        embedTextsImpl: async () => ({
          model: "text-embedding-3-small",
          dimensions: approvedEmbeddingDimensions,
          vectors: [makeBasisVector(999)],
        }),
      },
    });
    if (!retrieveRes.terminal) {
      await generateChatStage(makeChatClaims(unsupportedJob, "generate"), opts);
    }

    const unsupportedWire = await (
      await createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${unsupportedJob.id}/events`),
        unsupportedJob.id,
        { account: staffAccount, database, pollMilliseconds: 15 },
      )
    ).text();
    expect(unsupportedWire).toContain("event: no_evidence\n");
    expect(unsupportedWire).toContain(noEvidenceFallbackMessage);
    expect(unsupportedWire).toContain('"sources":[]');
  });

  it("revokes answer delivery on mid-flight SOP deletion and marks historical citations unavailable after deletion", async () => {
    const purgeOpts = {
      database,
      env: workerEnv,
      retrievalOptions: {
        embedTextsImpl: async () => ({
          model: "text-embedding-3-small",
          dimensions: approvedEmbeddingDimensions,
          vectors: [makeBasisVector(purgeVectorIndex)],
        }),
      },
    };

    // Turn 1 completes while purge SOP is ACTIVE
    const completedTurn = await createChatTurn(
      staffAccount,
      { requestKey: randomUUID(), question: `What are the ${tag} nitrogen line purge steps?` },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(completedTurn.conversationId);
    const completedJob = await markChatJobDispatched(completedTurn.jobId);
    await claimChatStage(makeChatClaims(completedJob, "claim"), purgeOpts);
    await retrieveChatStage(makeChatClaims(completedJob, "retrieve"), purgeOpts);
    await generateChatStage(makeChatClaims(completedJob, "generate"), purgeOpts);
    await validateChatStage(makeChatClaims(completedJob, "validate"), purgeOpts);

    // Turn 2 reaches validating stage BEFORE Admin deletes the purge SOP
    const racingTurn = await createChatTurn(
      staffAccount,
      {
        conversationId: completedTurn.conversationId,
        requestKey: randomUUID(),
        question: `Confirm ${tag} nitrogen purge flow rate and valve V-401`,
      },
      { database, dispatchDelaySeconds: 60 },
    );
    const racingJob = await markChatJobDispatched(racingTurn.jobId);
    await claimChatStage(makeChatClaims(racingJob, "claim"), purgeOpts);
    await retrieveChatStage(makeChatClaims(racingJob, "retrieve"), purgeOpts);
    await generateChatStage(makeChatClaims(racingJob, "generate"), purgeOpts);

    // Admin deletes the purge SOP right now
    await deleteDocument(adminAccount, purgeDocId, database);

    // Turn 2 validate MUST fail closed to NO_EVIDENCE (SOURCE_ELIGIBILITY_REVOKED)
    expect(await validateChatStage(makeChatClaims(racingJob, "validate"), purgeOpts)).toEqual({
      ok: true,
      terminal: true,
    });
    const racingWire = await (
      await createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${racingJob.id}/events`),
        racingJob.id,
        { account: staffAccount, database, pollMilliseconds: 15 },
      )
    ).text();
    expect(racingWire).toContain("event: no_evidence\n");
    expect(racingWire).not.toContain("V-401");
    expect(racingWire).not.toContain("45 L/min");

    // Turn 1 SSE replay right after SOP deletion ALSO withholds revoked answer and emits no_evidence!
    const replayedWire = await (
      await createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${completedJob.id}/events`),
        completedJob.id,
        { account: staffAccount, database, pollMilliseconds: 15 },
      )
    ).text();
    expect(replayedWire).toContain("event: no_evidence\n");
    expect(replayedWire).not.toContain("event: completed\n");
    expect(replayedWire).not.toContain("45 L/min");

    // Historical conversation detail preserves message history while marking deleted SOP citation unavailable
    const history = await getOwnedConversation(staffAccount, completedTurn.conversationId, database);
    const firstAssistant = history.messages.find(
      (msg) => msg.role === "assistant" && msg.validationStatus === "PASSED",
    );
    expect(firstAssistant?.sources).toHaveLength(1);
    expect(firstAssistant?.sources[0].available).toBe(false);
    expect(firstAssistant?.sources[0].reason).toBe("UNAVAILABLE");
    expect(firstAssistant?.sources[0].sourcePath).toBeUndefined();
  });
});
