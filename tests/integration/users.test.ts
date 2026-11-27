import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PATCH as patchUserRoute } from "../../src/app/api/users/[id]/route";
import { POST as inviteUserRoute } from "../../src/app/api/users/invite/route";
import { GET as getUsersRoute } from "../../src/app/api/users/route";
import {
  assertNotLastActiveAdmin,
  listDirectoryUsers,
  updateAccountAccess,
} from "../../src/server/auth/accounts";
import {
  requireCurrentAccount,
  requireRole,
  type CurrentAccount,
} from "../../src/server/auth/authorization";
import { authConfiguration } from "../../src/server/auth/config";
import { AuthFailure } from "../../src/server/auth/errors";
import { handleAuthentication } from "../../src/server/auth/handler";
import { acceptInvitation, issueInvitation } from "../../src/server/auth/invitations";
import { createChatEventStream, createChatTurn } from "../../src/server/chat";
import { getDatabase } from "../../src/server/db/client";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import {
  authorizeDocumentSource,
  deleteDocument,
  finalizeDocumentUpload,
  initializeDocumentUpload,
  readDocumentSourceContent,
} from "../../src/server/documents/service";
import type { DocumentStorage, StoredObject } from "../../src/server/documents/storage";
import type { InvitationDelivery } from "../../src/server/email/invitation";
import {
  chunkIngestionStage,
  claimIngestionStage,
  completeIngestionStage,
  embedIngestionStage,
  extractIngestionStage,
} from "../../src/server/ingestion/service";
import {
  ingestionWorkflowVersion,
  type IngestionCallbackClaims,
  type IngestionCallbackPurpose,
} from "../../src/server/jobs/contracts";
import { verifyDocument } from "../../src/server/verification/service";
import { seedSyntheticAccount, seedSyntheticSession, syntheticPassword } from "../fixtures/auth";
import { syntheticPdf } from "../fixtures/document-files";

const connection = postgres(databaseUrl("runtime"), { max: 8 });
const database = drizzle(connection, { schema });
const configuration = authConfiguration();

const workerEnv = {
  CONVERSION_URL: "http://convert-worker:8092",
  PADDLEOCR_URL: "http://paddleocr:8091",
  SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED: "1",
  AUTH_BASE_URL: "http://127.0.0.1:3000",
};

const dispatchKeys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const seededUserIds: string[] = [];
const seededEmails: string[] = [];
const seededDocumentIds: string[] = [];
const seededConversationIds: string[] = [];

let primaryAdmin: CurrentAccount;
let secondaryAdmin: CurrentAccount;
let baseStaff: CurrentAccount;

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

async function createAccountWithSession(
  role: "ADMIN" | "STAFF" = "STAFF",
  email?: string,
  name?: string,
): Promise<CurrentAccount> {
  const user = await seedSyntheticAccount(database, role, email);
  if (name) {
    await database
      .update(schema.authUsers)
      .set({ name })
      .where(eq(schema.authUsers.id, user.id));
  }
  seededUserIds.push(user.id);
  seededEmails.push(user.email);
  const session = await seedSyntheticSession(database, user);
  return name ? { ...session, name } : session;
}

function makeAuthRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  return new Request(`${configuration.baseURL}${path}`, {
    method,
    headers: {
      host: new URL(configuration.baseURL).host,
      origin: options.origin ?? configuration.baseURL,
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

function extractCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function signInAndGetCookies(email: string, password = syntheticPassword): Promise<string> {
  const response = await handleAuthentication(
    makeAuthRequest("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password },
    }),
  );
  expect(response.status).toBe(200);
  return extractCookies(response);
}

function makeIngestionClaims(
  job: typeof schema.workflowJobs.$inferSelect,
  purpose: IngestionCallbackPurpose,
  executionId = "exec-s12-doc",
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

async function seedActivePdfDocument(storage: MemoryStorage, title: string) {
  const bytes = syntheticPdf();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const initialized = await initializeDocumentUpload(
    primaryAdmin,
    {
      requestKey: randomUUID(),
      title,
      fileName: "s12-active-procedure.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256,
    },
    database,
    storage,
  );
  seededDocumentIds.push(initialized.document.id);

  const [intent] = await database
    .select()
    .from(schema.documentUploadIntents)
    .where(eq(schema.documentUploadIntents.id, initialized.document.id));
  await storage.create(intent.stagingKey, { bytes, contentType: "application/pdf" });
  await finalizeDocumentUpload(primaryAdmin, intent.id, database, storage);

  await database
    .update(schema.workflowJobs)
    .set({
      dispatchCount: 1,
      dispatchNextAt: new Date(Date.now() + 60_000),
    })
    .where(eq(schema.workflowJobs.documentId, intent.id));

  const [job] = await database
    .select()
    .from(schema.workflowJobs)
    .where(eq(schema.workflowJobs.documentId, intent.id));

  const executionId = `exec-${randomUUID().slice(0, 8)}`;
  const claimed = await claimIngestionStage(makeIngestionClaims(job, "claim", executionId), {
    database,
    privateKey: dispatchKeys.privateKey,
  });

  const workerFetch = vi.fn<typeof fetch>(async () =>
    Response.json({
      result: "PASS",
      pageCount: 1,
      pages: [
        {
          pageIndex: 1,
          nativeText: "Section 1 Valve Isolation\n1. Close main valve V-101 to 0 bar.",
          imageCount: 0,
          maxImagePixels: 0,
        },
      ],
    }),
  );

  await extractIngestionStage(
    makeIngestionClaims(job, "extract", executionId),
    claimed.fileRefToken,
    {
      database,
      storage,
      fetchImpl: workerFetch,
      env: workerEnv,
      privateKey: dispatchKeys.privateKey,
    },
  );
  await chunkIngestionStage(makeIngestionClaims(job, "chunk", executionId), { database });
  await embedIngestionStage(makeIngestionClaims(job, "embed", executionId), {
    database,
    env: workerEnv,
  });
  await completeIngestionStage(makeIngestionClaims(job, "complete", executionId), { database });

  const [pendingDoc] = await database
    .select()
    .from(schema.sopDocuments)
    .where(eq(schema.sopDocuments.id, intent.id));

  await verifyDocument(
    secondaryAdmin,
    intent.id,
    {
      decision: "APPROVE",
      expectedSha256: pendingDoc.sha256,
      expectedJobId: job.id,
      expectedPipelineVersion: pendingDoc.processedPipelineVersion!,
      expectedAttemptId: pendingDoc.processedAttemptId!,
      explicitConfirmation: true,
      notes: "Approved synthetic SOP for S12 revocation check.",
    },
    database,
  );

  return { documentId: intent.id, bytes, sha256 };
}

beforeAll(async () => {
  process.env.DOCUMENT_UPLOAD_QUOTA_BYTES ??= String(500 * 1024 * 1024);
  primaryAdmin = await createAccountWithSession(
    "ADMIN",
    `s12-admin-primary-${randomUUID()}@example.invalid`,
    "S12 Primary Admin",
  );
  secondaryAdmin = await createAccountWithSession(
    "ADMIN",
    `s12-admin-secondary-${randomUUID()}@example.invalid`,
    "S12 Secondary Admin",
  );
  baseStaff = await createAccountWithSession(
    "STAFF",
    `s12-staff-base-${randomUUID()}@example.invalid`,
    "S12 Base Staff",
  );
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
    for (const documentId of seededDocumentIds) {
      await deleteDocument(primaryAdmin, documentId, database).catch(() => undefined);
      await database
        .delete(schema.sopChunks)
        .where(eq(schema.sopChunks.documentId, documentId))
        .catch(() => undefined);
      await database
        .delete(schema.sopExtractionPages)
        .where(eq(schema.sopExtractionPages.documentId, documentId))
        .catch(() => undefined);
      await database
        .delete(schema.sopVerificationIssues)
        .where(eq(schema.sopVerificationIssues.documentId, documentId))
        .catch(() => undefined);
    }
    if (seededEmails.length > 0) {
      await database
        .delete(schema.authInvitations)
        .where(inArray(schema.authInvitations.email, seededEmails))
        .catch(() => undefined);
    }
    if (seededUserIds.length > 0) {
      await database
        .delete(schema.authInvitations)
        .where(inArray(schema.authInvitations.invitedBy, seededUserIds))
        .catch(() => undefined);
      await database
        .delete(schema.authSessions)
        .where(inArray(schema.authSessions.userId, seededUserIds))
        .catch(() => undefined);
    }
  } finally {
    await Promise.all([connection.end(), getDatabase().$client.end()]);
  }
});

describe("S12 U1/U2/U3/U4 Admin user directory and account management with real PostgreSQL", () => {
  it("lists users with search, role/status filters, escaped ILIKE wildcards, and sanitized pending invitations", async () => {
    const tag = `s12dir-${randomUUID().slice(0, 8)}`;
    const activeAdmin = await createAccountWithSession(
      "ADMIN",
      `${tag}-admin@example.invalid`,
      `${tag} Directory Admin`,
    );
    const activeStaff = await createAccountWithSession(
      "STAFF",
      `${tag}-staff_100%@example.invalid`,
      `${tag} Operations_100% Staff`,
    );
    const inactiveStaff = await createAccountWithSession(
      "STAFF",
      `${tag}-inactive@example.invalid`,
      `${tag} Inactive Operator`,
    );
    await updateAccountAccess(primaryAdmin, inactiveStaff.id, { active: false }, database);

    const pendingEmail = `${tag}-pending@example.invalid`;
    seededEmails.push(pendingEmail);
    let capturedDelivery: InvitationDelivery | undefined;
    const issued = await issueInvitation(
      primaryAdmin,
      { email: pendingEmail, role: "STAFF" },
      {
        database,
        configuration,
        sendEmail: async (delivery) => {
          capturedDelivery = delivery;
        },
      },
    );
    expect(capturedDelivery).toBeDefined();

    // HTTP route GET /api/users with Admin cookie
    const adminCookie = await signInAndGetCookies(primaryAdmin.email);
    const httpRes = await getUsersRoute(
      makeAuthRequest(`/api/users?q=${encodeURIComponent(tag)}`, { cookie: adminCookie }),
    );
    expect(httpRes.status).toBe(200);
    expect(httpRes.headers.get("cache-control")).toBe("no-store");
    const directory = await httpRes.json();

    expect(directory.users.map((u: { id: string }) => u.id)).toEqual(
      expect.arrayContaining([activeAdmin.id, activeStaff.id, inactiveStaff.id]),
    );
    expect(directory.users).toHaveLength(3);
    expect(JSON.stringify(directory)).not.toMatch(/password|tokenDigest|token_digest|session/i);

    const pendingFound = directory.pendingInvitations.find(
      (item: { id: string }) => item.id === issued.invitationId,
    );
    expect(pendingFound).toMatchObject({
      id: issued.invitationId,
      email: pendingEmail,
      role: "STAFF",
      invitedBy: primaryAdmin.id,
    });
    expect(pendingFound).not.toHaveProperty("tokenDigest");

    expect(directory.summary.totalUsers).toBeGreaterThanOrEqual(3);
    expect(directory.summary.activeAdmins).toBeGreaterThanOrEqual(2);
    expect(directory.summary.pendingInvitations).toBeGreaterThanOrEqual(1);

    // Filter by role=ADMIN and status=ACTIVE
    const onlyAdmins = await listDirectoryUsers(
      primaryAdmin,
      { q: tag, role: "ADMIN", status: "ACTIVE" },
      database,
    );
    expect(onlyAdmins.users.map((u) => u.id)).toEqual([activeAdmin.id]);

    // Filter by status=INACTIVE
    const onlyInactive = await listDirectoryUsers(
      primaryAdmin,
      { q: tag, status: "INACTIVE" },
      database,
    );
    expect(onlyInactive.users.map((u) => u.id)).toEqual([inactiveStaff.id]);
    expect(onlyInactive.users[0].status).toBe("INACTIVE");
    expect(onlyInactive.users[0].active).toBe(false);

    // Escaped wildcard search "_100%" matches only the literal "_100%" user
    const wildcardSearch = await listDirectoryUsers(
      primaryAdmin,
      { q: `${tag} Operations_100%` },
      database,
    );
    expect(wildcardSearch.users.map((u) => u.id)).toEqual([activeStaff.id]);

    // Duplicate query parameters rejected with 400 INVALID_INPUT
    const duplicateParamRes = await getUsersRoute(
      makeAuthRequest("/api/users?role=ADMIN&role=STAFF", { cookie: adminCookie }),
    );
    expect(duplicateParamRes.status).toBe(400);
    expect(await duplicateParamRes.json()).toEqual({ error: { code: "INVALID_INPUT" } });
  });

  it("denies Staff and anonymous callers across GET /api/users, POST /api/users/invite, and PATCH /api/users/[id], and enforces CSRF origin", async () => {
    const staffCookie = await signInAndGetCookies(baseStaff.email);
    const adminCookie = await signInAndGetCookies(primaryAdmin.email);

    // Anonymous -> 401
    expect((await getUsersRoute(makeAuthRequest("/api/users"))).status).toBe(401);
    expect(
      (
        await inviteUserRoute(
          makeAuthRequest("/api/users/invite", {
            method: "POST",
            body: { email: "anon@example.invalid", role: "STAFF" },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await patchUserRoute(
          makeAuthRequest(`/api/users/${baseStaff.id}`, {
            method: "PATCH",
            body: { role: "ADMIN" },
          }),
          { params: Promise.resolve({ id: baseStaff.id }) },
        )
      ).status,
    ).toBe(401);

    // Staff -> 403 FORBIDDEN
    const staffListRes = await getUsersRoute(
      makeAuthRequest("/api/users", { cookie: staffCookie }),
    );
    expect(staffListRes.status).toBe(403);
    expect(await staffListRes.json()).toEqual({ error: { code: "FORBIDDEN" } });

    const staffInviteRes = await inviteUserRoute(
      makeAuthRequest("/api/users/invite", {
        method: "POST",
        cookie: staffCookie,
        body: { email: "forbidden-invite@example.invalid", role: "STAFF" },
      }),
    );
    expect(staffInviteRes.status).toBe(403);

    const staffPatchRes = await patchUserRoute(
      makeAuthRequest(`/api/users/${baseStaff.id}`, {
        method: "PATCH",
        cookie: staffCookie,
        body: { role: "ADMIN" },
      }),
      { params: Promise.resolve({ id: baseStaff.id }) },
    );
    expect(staffPatchRes.status).toBe(403);

    // Cross-origin CSRF attempt on PATCH /api/users/[id] with Admin cookie -> 403 INVALID_ORIGIN
    const csrfRes = await patchUserRoute(
      makeAuthRequest(`/api/users/${baseStaff.id}`, {
        method: "PATCH",
        cookie: adminCookie,
        origin: "https://evil.example.invalid",
        body: { role: "ADMIN" },
      }),
      { params: Promise.resolve({ id: baseStaff.id }) },
    );
    expect(csrfRes.status).toBe(403);
    expect(await csrfRes.json()).toEqual({ error: { code: "INVALID_ORIGIN" } });

    // Non-existent user ID on PATCH /api/users/[id] -> 404 NOT_FOUND
    const missingRes = await patchUserRoute(
      makeAuthRequest(`/api/users/${randomUUID()}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { active: false },
      }),
      { params: Promise.resolve({ id: randomUUID() }) },
    );
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toEqual({ error: { code: "NOT_FOUND" } });
  });

  it("blocks duplicate active pending invitations (409), permits re-invitation after expiry or revocation, and transitions accepted invite into active user", async () => {
    const email = `s12-invite-${randomUUID()}@example.invalid`;
    seededEmails.push(email);

    let latestDelivery: InvitationDelivery | undefined;
    const first = await issueInvitation(
      primaryAdmin,
      { email, role: "STAFF" },
      {
        database,
        configuration,
        sendEmail: async (delivery) => {
          latestDelivery = delivery;
        },
      },
    );
    expect(first.email).toBe(email);

    // Duplicate active pending invitation -> 409 INVITATION_ALREADY_PENDING
    await expect(
      issueInvitation(
        primaryAdmin,
        { email: email.toUpperCase(), role: "ADMIN" },
        {
          database,
          configuration,
          sendEmail: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: "INVITATION_ALREADY_PENDING",
      status: 409,
    });

    // Expire the first invitation -> re-invitation succeeds
    await database
      .update(schema.authInvitations)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.authInvitations.id, first.invitationId));

    const second = await issueInvitation(
      primaryAdmin,
      { email, role: "STAFF" },
      {
        database,
        configuration,
        sendEmail: async (delivery) => {
          latestDelivery = delivery;
        },
      },
    );
    expect(second.invitationId).not.toBe(first.invitationId);

    // Revoke the second invitation -> re-invitation succeeds
    await database
      .update(schema.authInvitations)
      .set({ revokedAt: new Date() })
      .where(eq(schema.authInvitations.id, second.invitationId));

    const third = await issueInvitation(
      primaryAdmin,
      { email, role: "STAFF" },
      {
        database,
        configuration,
        sendEmail: async (delivery) => {
          latestDelivery = delivery;
        },
      },
    );
    expect(third.invitationId).not.toBe(second.invitationId);
    expect(latestDelivery).toBeDefined();

    // Accept the third invitation -> transitions from pendingInvitations to active directory user
    const token = new URL(latestDelivery!.acceptUrl).hash.slice(1);
    const accepted = await acceptInvitation(
      {
        email,
        token,
        name: "S12 Accepted Member",
        password: syntheticPassword,
      },
      { database, configuration },
    );
    expect(accepted).toEqual({ accepted: true });

    const postAcceptDirectory = await listDirectoryUsers(primaryAdmin, { q: email }, database);
    expect(postAcceptDirectory.users).toHaveLength(1);
    expect(postAcceptDirectory.users[0]).toMatchObject({
      email,
      name: "S12 Accepted Member",
      role: "STAFF",
      active: true,
      status: "ACTIVE",
    });
    expect(
      postAcceptDirectory.pendingInvitations.some((item) => item.email === email),
    ).toBe(false);

    // Trying to invite an already-registered email -> 409 ACCOUNT_EXISTS
    await expect(
      issueInvitation(
        primaryAdmin,
        { email, role: "STAFF" },
        {
          database,
          configuration,
          sendEmail: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: "ACCOUNT_EXISTS",
      status: 409,
    });
  });

  it("serializes concurrent issueInvitation calls for the same fresh email via advisory lock (SEC-S12-01)", async () => {
    const email = `s12-race-invite-${randomUUID()}@example.invalid`;
    seededEmails.push(email);

    const attempts = await Promise.all(
      [
        { actor: primaryAdmin, inputEmail: email },
        { actor: secondaryAdmin, inputEmail: email.toUpperCase() },
      ].map(({ actor, inputEmail }) =>
        issueInvitation(
          actor,
          { email: inputEmail, role: "STAFF" },
          {
            database,
            configuration,
            sendEmail: async () => undefined,
          },
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        ),
      ),
    );

    const succeeded = attempts.filter((entry) => entry.ok);
    const failed = attempts.filter((entry) => !entry.ok);
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(succeeded[0].value.email).toBe(email);
    expect(failed[0].error).toBeInstanceOf(AuthFailure);
    expect(failed[0].error).toMatchObject({
      code: "INVITATION_ALREADY_PENDING",
      status: 409,
    });

    const liveInvitations = await database
      .select({ id: schema.authInvitations.id })
      .from(schema.authInvitations)
      .where(
        and(
          eq(schema.authInvitations.email, email),
          isNull(schema.authInvitations.consumedAt),
          isNull(schema.authInvitations.revokedAt),
          gt(schema.authInvitations.expiresAt, sql`clock_timestamp()`),
        ),
      );
    expect(liveInvitations).toHaveLength(1);
    expect(liveInvitations[0].id).toBe(succeeded[0].value.invitationId);
  });

  it("enforces self-lockout (409 SELF_ACCESS_CHANGE_DENIED) and last-active-Admin (409 LAST_ADMIN_REQUIRED) safeguards", async () => {
    const adminCookie = await signInAndGetCookies(primaryAdmin.email);
    const refreshedPrimary = await requireCurrentAccount(
      new Headers({ cookie: adminCookie }),
      database,
    );

    // Self-demotion and self-deactivation via HTTP PATCH /api/users/[id] -> 409 SELF_ACCESS_CHANGE_DENIED
    for (const selfChange of [{ role: "STAFF" as const }, { active: false }]) {
      const res = await patchUserRoute(
        makeAuthRequest(`/api/users/${refreshedPrimary.id}`, {
          method: "PATCH",
          cookie: adminCookie,
          body: selfChange,
        }),
        { params: Promise.resolve({ id: refreshedPrimary.id }) },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: { code: "SELF_ACCESS_CHANGE_DENIED" } });
    }

    // Last-active-Admin safeguard against real PostgreSQL inside a rolled-back transaction
    await expect(
      database.transaction(async (transaction) => {
        await transaction
          .update(schema.authUsers)
          .set({ active: false })
          .where(
            and(
              eq(schema.authUsers.role, "ADMIN"),
              eq(schema.authUsers.active, true),
            ),
          );
        await transaction
          .update(schema.authUsers)
          .set({ active: true, role: "ADMIN" })
          .where(eq(schema.authUsers.id, refreshedPrimary.id));

        await assertNotLastActiveAdmin(
          transaction,
          { id: refreshedPrimary.id, role: "ADMIN", active: true },
          { role: "STAFF" },
        );
      }),
    ).rejects.toMatchObject({
      code: "LAST_ADMIN_REQUIRED",
      status: 409,
    });
  });

  it("immediately revokes stale Admin privileges on role change (STAFF -> ADMIN -> STAFF)", async () => {
    const member = await createAccountWithSession(
      "STAFF",
      `s12-role-${randomUUID()}@example.invalid`,
      "S12 Role Transition User",
    );
    const adminCookie = await signInAndGetCookies(primaryAdmin.email);

    // Promote STAFF -> ADMIN via PATCH /api/users/[id]
    const promoteRes = await patchUserRoute(
      makeAuthRequest(`/api/users/${member.id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { role: "ADMIN" },
      }),
      { params: Promise.resolve({ id: member.id }) },
    );
    expect(promoteRes.status).toBe(200);
    const promotedBody = await promoteRes.json();
    expect(promotedBody.user).toMatchObject({
      id: member.id,
      role: "ADMIN",
      active: true,
      status: "ACTIVE",
    });

    // Old pre-promotion session was revoked by trigger + delete
    await expect(
      requireCurrentAccount(new Headers(), database),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    // Member signs in as ADMIN and can access GET /api/users
    const memberAdminCookie = await signInAndGetCookies(member.email);
    const asAdminList = await getUsersRoute(
      makeAuthRequest("/api/users?limit=5", { cookie: memberAdminCookie }),
    );
    expect(asAdminList.status).toBe(200);

    // Primary Admin demotes member ADMIN -> STAFF
    const demoteRes = await patchUserRoute(
      makeAuthRequest(`/api/users/${member.id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { role: "STAFF" },
      }),
      { params: Promise.resolve({ id: member.id }) },
    );
    expect(demoteRes.status).toBe(200);
    expect((await demoteRes.json()).user.role).toBe("STAFF");

    // Stale Admin cookie is immediately revoked (401 UNAUTHENTICATED)
    const staleAdminAttempt = await getUsersRoute(
      makeAuthRequest("/api/users", { cookie: memberAdminCookie }),
    );
    expect(staleAdminAttempt.status).toBe(401);

    // Fresh sign-in yields STAFF role only and is denied 403 FORBIDDEN on GET /api/users
    const memberStaffCookie = await signInAndGetCookies(member.email);
    const freshAccount = await requireCurrentAccount(
      new Headers({ cookie: memberStaffCookie }),
      database,
    );
    expect(freshAccount.role).toBe("STAFF");
    expect(() => requireRole(freshAccount, "ADMIN")).toThrow();

    const deniedAfterDemotion = await getUsersRoute(
      makeAuthRequest("/api/users", { cookie: memberStaffCookie }),
    );
    expect(deniedAfterDemotion.status).toBe(403);
  });

  it("revokes ongoing session, active chat SSE stream, chat message creation, and 60s signed SOP source download immediately upon deactivation, and restores only current role on reactivation with redacted audit metadata", async () => {
    const storage = new MemoryStorage();
    const activeSop = await seedActivePdfDocument(
      storage,
      `S12-Active-SOP-${randomUUID().slice(0, 8)}`,
    );

    const targetStaff = await createAccountWithSession(
      "STAFF",
      `s12-active-revoke-${randomUUID()}@example.invalid`,
      "S12 Active Session Staff",
    );
    const oldStaffCookie = await signInAndGetCookies(targetStaff.email);
    const liveStaff = await requireCurrentAccount(
      new Headers({ cookie: oldStaffCookie }),
      database,
    );

    // 1. Staff starts a chat turn and obtains a 60s signed SOP source download link while ACTIVE
    const chatTurn = await createChatTurn(
      liveStaff,
      {
        requestKey: randomUUID(),
        question: "What are the valve V-101 isolation steps?",
      },
      { database, dispatchDelaySeconds: 60 },
    );
    seededConversationIds.push(chatTurn.conversationId);

    const issuedSource = await authorizeDocumentSource(
      liveStaff,
      activeSop.documentId,
      { disposition: "inline", page: 1, section: "Section 1 Valve Isolation" },
      database,
    );
    const sourceToken = new URL(
      issuedSource.source.url,
      "http://127.0.0.1:3000",
    ).searchParams.get("token")!;

    // Verify source token works before deactivation
    const preDeactivateDownload = await readDocumentSourceContent(
      liveStaff,
      activeSop.documentId,
      { token: sourceToken },
      database,
      storage,
    );
    expect(preDeactivateDownload.bytes).toEqual(activeSop.bytes);

    // 2. Admin deactivates targetStaff via PATCH /api/users/[id]
    const adminCookie = await signInAndGetCookies(primaryAdmin.email);
    const deactivateRes = await patchUserRoute(
      makeAuthRequest(`/api/users/${liveStaff.id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { active: false },
      }),
      { params: Promise.resolve({ id: liveStaff.id }) },
    );
    expect(deactivateRes.status).toBe(200);
    expect((await deactivateRes.json()).user).toMatchObject({
      id: liveStaff.id,
      active: false,
      status: "INACTIVE",
    });

    // 3. Ongoing session is immediately rejected (401 UNAUTHENTICATED)
    await expect(
      requireCurrentAccount(new Headers({ cookie: oldStaffCookie }), database),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    // 4. Ongoing/reconnecting chat SSE stream is immediately rejected (401 UNAUTHENTICATED)
    await expect(
      createChatEventStream(
        new Request(`http://127.0.0.1:3000/api/chat/jobs/${chatTurn.jobId}/events`),
        chatTurn.jobId,
        { account: liveStaff, database, pollMilliseconds: 15 },
      ),
    ).rejects.toBeInstanceOf(AuthFailure);

    // 5. Chat message submission is immediately rejected (401 UNAUTHENTICATED)
    await expect(
      createChatTurn(
        liveStaff,
        {
          conversationId: chatTurn.conversationId,
          requestKey: randomUUID(),
          question: "Follow-up after deactivation",
        },
        { database, dispatchDelaySeconds: 60 },
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    // 6. Previously issued 60s signed source token is immediately rejected before bytes stream (401 UNAUTHENTICATED)
    await expect(
      readDocumentSourceContent(
        liveStaff,
        activeSop.documentId,
        { token: sourceToken },
        database,
        storage,
      ),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    // 7. Sign-in while deactivated fails with 401
    const blockedSignIn = await handleAuthentication(
      makeAuthRequest("/api/auth/sign-in/email", {
        method: "POST",
        body: { email: liveStaff.email, password: syntheticPassword },
      }),
    );
    expect(blockedSignIn.status).toBe(401);

    // 8. Admin reactivates targetStaff
    const reactivateRes = await patchUserRoute(
      makeAuthRequest(`/api/users/${liveStaff.id}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { active: true },
      }),
      { params: Promise.resolve({ id: liveStaff.id }) },
    );
    expect(reactivateRes.status).toBe(200);
    expect((await reactivateRes.json()).user).toMatchObject({
      id: liveStaff.id,
      active: true,
      status: "ACTIVE",
      role: "STAFF",
    });

    // Old pre-deactivation cookie remains dead after reactivation
    await expect(
      requireCurrentAccount(new Headers({ cookie: oldStaffCookie }), database),
    ).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });

    // Fresh sign-in works and restores only STAFF capabilities (still denied Admin endpoints)
    const freshStaffCookie = await signInAndGetCookies(liveStaff.email);
    const reactivatedAccount = await requireCurrentAccount(
      new Headers({ cookie: freshStaffCookie }),
      database,
    );
    expect(reactivatedAccount.role).toBe("STAFF");
    expect(
      (await getUsersRoute(makeAuthRequest("/api/users", { cookie: freshStaffCookie }))).status,
    ).toBe(403);

    // 9. Audit events record transitions without passwords, tokens, or emails in metadata
    const audits = await database
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.targetId, liveStaff.id),
          eq(schema.auditEvents.action, "account_access_changed"),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const serializedAudits = JSON.stringify(audits);
    expect(serializedAudits).not.toContain(syntheticPassword);
    expect(serializedAudits).not.toContain(liveStaff.email);
    expect(serializedAudits).not.toContain(sourceToken);
    expect(audits[0].metadata).toMatchObject({
      previousRole: "STAFF",
      role: "STAFF",
    });
  });
});
