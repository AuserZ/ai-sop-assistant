import { randomBytes, randomUUID } from "node:crypto";
import { count, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import { getDatabase } from "../../src/server/db/client";
import * as schema from "../../src/server/db/schema";
import { updateAccountAccess } from "../../src/server/auth/accounts";
import { createAuthentication } from "../../src/server/auth/authentication";
import { requireCurrentAccount, requireOwner, requireRole, type CurrentAccount } from "../../src/server/auth/authorization";
import { authConfiguration } from "../../src/server/auth/config";
import { handleAuthentication } from "../../src/server/auth/handler";
import { acceptInvitation, invitationTokenDigest, issueInvitation } from "../../src/server/auth/invitations";
import { consumeRateLimit, pruneExpiredRateLimits } from "../../src/server/auth/rate-limit";
import type { InvitationDelivery } from "../../src/server/email/invitation";
import { seedSyntheticAccount, seedSyntheticSession, syntheticPassword } from "../fixtures/auth";

const connection = postgres(databaseUrl("runtime"), { max: 6 });
const database = drizzle(connection, { schema });
const configuration = authConfiguration();
const authentication = createAuthentication(database, configuration);
const userIds: string[] = [];
const invitedEmails: string[] = [];
let admin: CurrentAccount;
let staff: CurrentAccount;

async function account(role: "ADMIN" | "STAFF" = "STAFF") {
  const user = await seedSyntheticAccount(database, role);
  userIds.push(user.id);
  return seedSyntheticSession(database, user);
}

async function invite(role: "ADMIN" | "STAFF" = "STAFF", actor = admin) {
  const email = `${randomUUID()}@example.invalid`;
  invitedEmails.push(email);
  let delivery: InvitationDelivery | undefined;
  const result = await issueInvitation(actor, { email, role }, {
    database, configuration,
    sendEmail: async (value) => { delivery = value; },
  });
  if (!delivery) throw new Error("Synthetic delivery missing.");
  const token = new URL(delivery.acceptUrl).hash.slice(1);
  return { email, token, delivery, result, input: { email, token, name: "Invited synthetic user", password: syntheticPassword } };
}

function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${configuration.baseURL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: new URL(configuration.baseURL).host, origin: configuration.baseURL, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function cookies(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

beforeAll(async () => {
  admin = await account("ADMIN");
  staff = await account("STAFF");
});

afterAll(async () => {
  if (userIds.length) {
    await database.delete(schema.authInvitations).where(inArray(schema.authInvitations.invitedBy, userIds));
    await database.delete(schema.authUsers).where(inArray(schema.authUsers.id, userIds));
  }
  if (invitedEmails.length) await database.delete(schema.authUsers).where(inArray(schema.authUsers.email, invitedEmails));
  await Promise.all([connection.end(), getDatabase().$client.end()]);
});

describe("U2/U4 invitation-only identity with real PostgreSQL and Better Auth", () => {
  it("accepts intended normalized email and bound role, then logs in through Better Auth without bearer JSON", async () => {
    const invitation = await invite("ADMIN");
    expect(JSON.stringify(invitation.result)).not.toContain(invitation.token);
    expect(invitation.delivery).not.toHaveProperty("password");
    expect(new URL(invitation.delivery.acceptUrl).search).toBe("");
    const accepted = await handleAuthentication(request("/api/auth/invitations/accept", { ...invitation.input, email: invitation.email.toUpperCase() }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });
    expect(accepted.headers.getSetCookie()).toHaveLength(0);
    const signedIn = await handleAuthentication(request("/api/auth/sign-in/email", { email: invitation.email, password: syntheticPassword }));
    expect(signedIn.status).toBe(200);
    const body = await signedIn.json();
    expect(Object.keys(body)).toEqual(["user"]);
    expect(body.user).toEqual({ id: expect.any(String), email: invitation.email, name: "Invited synthetic user", role: "ADMIN" });
    expect(JSON.stringify(body)).not.toMatch(/token|password|credential/i);
    expect(signedIn.headers.getSetCookie().join(";")).toMatch(/HttpOnly/i);
    expect(signedIn.headers.getSetCookie().join(";")).toMatch(/SameSite=Lax/i);
    const session = await handleAuthentication(request("/api/auth/get-session", undefined, { cookie: cookies(signedIn) }));
    expect(session.status).toBe(200);
    expect(JSON.stringify(await session.json())).not.toMatch(/token|password|credential/i);
    const logout = await handleAuthentication(request("/api/auth/sign-out", {}, { cookie: cookies(signedIn) }));
    expect(logout.status).toBe(200);
    expect((await handleAuthentication(request("/api/auth/get-session", undefined, { cookie: cookies(signedIn) }))).status).toBe(401);
  });

  it("rejects forged, wrong-email, expired, reused, undelivered, revoked and role-overridden invitations", async () => {
    const invitation = await invite();
    await expect(acceptInvitation({ ...invitation.input, token: randomBytes(32).toString("base64url") }, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    await expect(acceptInvitation({ ...invitation.input, email: "wrong@example.invalid" }, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    await expect(acceptInvitation({ ...invitation.input, role: "ADMIN" }, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await database.update(schema.authInvitations).set({ deliveredAt: null }).where(eq(schema.authInvitations.id, invitation.result.invitationId));
    await expect(acceptInvitation(invitation.input, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    await database.update(schema.authInvitations).set({ deliveredAt: new Date(), expiresAt: new Date(0) }).where(eq(schema.authInvitations.id, invitation.result.invitationId));
    await expect(acceptInvitation(invitation.input, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    await database.update(schema.authInvitations).set({ expiresAt: new Date(Date.now() + 60000), revokedAt: new Date() }).where(eq(schema.authInvitations.id, invitation.result.invitationId));
    await expect(acceptInvitation(invitation.input, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    const usable = await invite();
    await acceptInvitation(usable.input, { database, configuration });
    await expect(acceptInvitation(usable.input, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
  });

  it("serializes racing acceptance into one user, one credential and one consumption", async () => {
    const invitation = await invite();
    const outcomes = await Promise.allSettled([
      acceptInvitation(invitation.input, { database, configuration }),
      acceptInvitation(invitation.input, { database, configuration }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [user] = await database.select().from(schema.authUsers).where(eq(schema.authUsers.email, invitation.email));
    const [credentials] = await database.select({ total: count() }).from(schema.authAccounts).where(eq(schema.authAccounts.userId, user.id));
    expect(credentials.total).toBe(1);
    const [saved] = await database.select().from(schema.authInvitations).where(eq(schema.authInvitations.id, invitation.result.invitationId));
    expect(saved.consumedAt).toBeInstanceOf(Date);
    expect(saved.tokenDigest).toBe(invitationTokenDigest(invitation.token));
    expect(saved.tokenDigest).not.toContain(invitation.token);
  });

  it("rejects expiry while waiting for an invitation lock and rolls back user/credential creation", async () => {
    const invitation = await invite();
    let releaseLock!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const blocker = database.transaction(async (transaction) => {
      await transaction.update(schema.authInvitations).set({ expiresAt: sql`clock_timestamp() + interval '800 milliseconds'` })
        .where(eq(schema.authInvitations.id, invitation.result.invitationId));
      signalLocked();
      await release;
    });
    await locked;
    const acceptance = acceptInvitation(invitation.input, { database, configuration }).then(() => null, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    releaseLock();
    await blocker;
    expect(await acceptance).toMatchObject({ code: "INVALID_INVITATION" });
    const [users] = await database.select({ total: count() }).from(schema.authUsers).where(eq(schema.authUsers.email, invitation.email));
    expect(users.total).toBe(0);
    const [saved] = await database.select().from(schema.authInvitations).where(eq(schema.authInvitations.id, invitation.result.invitationId));
    expect(saved.consumedAt).toBeNull();
  });

  it("rolls back existing-account conflicts without consuming invitation or changing password/status/role", async () => {
    const invitation = await invite("ADMIN");
    const existing = await seedSyntheticAccount(database, "STAFF", invitation.email);
    userIds.push(existing.id);
    await database.update(schema.authUsers).set({ active: false }).where(eq(schema.authUsers.id, existing.id));
    const [before] = await database.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, existing.id));
    await expect(acceptInvitation(invitation.input, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    const [saved] = await database.select().from(schema.authInvitations).where(eq(schema.authInvitations.id, invitation.result.invitationId));
    expect(saved.consumedAt).toBeNull();
    const [user] = await database.select().from(schema.authUsers).where(eq(schema.authUsers.id, existing.id));
    expect(user).toMatchObject({ role: "STAFF", active: false });
    const [after] = await database.select().from(schema.authAccounts).where(eq(schema.authAccounts.userId, existing.id));
    expect(after.password).toBe(before.password);
  });

  it("keeps failed email deliveries ineligible and rechecks issuer privileges after send", async () => {
    const issuer = await account("ADMIN");
    for (const demoteDuringSend of [false, true]) {
      const email = `${randomUUID()}@example.invalid`;
      invitedEmails.push(email);
      let token = "";
      await expect(issueInvitation(issuer, { email, role: "STAFF" }, {
        database, configuration,
        sendEmail: async (delivery) => {
          token = new URL(delivery.acceptUrl).hash.slice(1);
          if (!demoteDuringSend) throw new Error("Synthetic provider failure with sensitive fields");
          await updateAccountAccess(admin, issuer.id, { role: "STAFF" }, database);
        },
      })).rejects.toMatchObject({ code: "INVITATION_DELIVERY_FAILED" });
      const [saved] = await database.select().from(schema.authInvitations).where(eq(schema.authInvitations.email, email));
      expect(saved.deliveredAt).toBeNull();
      expect(saved.revokedAt).toBeInstanceOf(Date);
      await expect(acceptInvitation({ email, token, name: "Test", password: syntheticPassword }, { database, configuration })).rejects.toMatchObject({ code: "INVALID_INVITATION" });
    }
  });

  it("blocks direct Better Auth signup and raw/encoded/variant browser paths and unexpected methods", async () => {
    await expect(authentication.api.signUpEmail({ body: { name: "Uninvited", email: "uninvited@example.invalid", password: syntheticPassword } })).rejects.toMatchObject({ status: "BAD_REQUEST" });
    for (const path of ["/api/auth/sign-up/email", "/api/auth/sign-up/email/", "/api/auth/%73ign-up/email", "/api/auth/sign-in/social", "/api/auth/request-password-reset", "/api/auth/update-user"]) {
      const response = await handleAuthentication(request(path, { email: "uninvited@example.invalid", password: syntheticPassword, role: "ADMIN", active: true }));
      expect(response.status).toBe(404);
    }
    const unexpected = new Request(`${configuration.baseURL}/api/auth/sign-in/email`, { method: "PUT" });
    expect((await handleAuthentication(unexpected)).status).toBe(404);
    const [found] = await database.select({ total: count() }).from(schema.authUsers).where(eq(schema.authUsers.email, "uninvited@example.invalid"));
    expect(found.total).toBe(0);
  });

  it("sets Secure, HttpOnly and SameSite on canonical HTTPS auth cookies", async () => {
    const secureAuthentication = createAuthentication(database, { ...configuration, baseURL: "https://sop.example.invalid", secureCookies: true });
    const response = await secureAuthentication.handler(new Request("https://sop.example.invalid/api/auth/sign-in/email", {
      method: "POST", headers: { origin: "https://sop.example.invalid", "content-type": "application/json" },
      body: JSON.stringify({ email: staff.email, password: syntheticPassword }),
    }));
    expect(response.status).toBe(200);
    const cookieHeaders = response.headers.getSetCookie().join(";");
    expect(cookieHeaders).toMatch(/; Secure/i);
    expect(cookieHeaders).toMatch(/; HttpOnly/i);
    expect(cookieHeaders).toMatch(/; SameSite=Lax/i);
  });

  it("denies Staff/anonymous Admin actions and cross-user ownership even for Admin", async () => {
    await expect(issueInvitation(staff, { email: "no-access@example.invalid", role: "ADMIN" }, { database, configuration, sendEmail: async () => undefined })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(requireCurrentAccount(new Headers(), database, authentication)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(() => requireOwner(admin, staff.id)).toThrow();
    expect(() => requireOwner(staff, admin.id)).toThrow();
    await expect(updateAccountAccess(staff, admin.id, { active: false }, database)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateAccountAccess(admin, staff.id, { active: true, id: "forged-user-id" } as { active: boolean }, database)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("U3 current-account state and session race enforcement", () => {
  it("revokes stale cookies after role/status changes, blocks login, and never revives old sessions on reactivation", async () => {
    const target = await account("ADMIN");
    const login = await handleAuthentication(request("/api/auth/sign-in/email", { email: target.email, password: syntheticPassword }));
    expect(login.status).toBe(200);
    const headers = new Headers({ cookie: cookies(login) });
    requireRole(await requireCurrentAccount(headers), "ADMIN");
    await updateAccountAccess(admin, target.id, { role: "STAFF" }, database);
    await expect(requireCurrentAccount(headers)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const staffLogin = await handleAuthentication(request("/api/auth/sign-in/email", { email: target.email, password: syntheticPassword }));
    expect(staffLogin.status).toBe(200);
    const staffHeaders = new Headers({ cookie: cookies(staffLogin) });
    expect((await requireCurrentAccount(staffHeaders)).role).toBe("STAFF");
    await updateAccountAccess(admin, target.id, { active: false }, database);
    await expect(requireCurrentAccount(staffHeaders)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await handleAuthentication(request("/api/auth/sign-in/email", { email: target.email, password: syntheticPassword }))).status).toBe(401);
    await updateAccountAccess(admin, target.id, { active: true }, database);
    await expect(requireCurrentAccount(staffHeaders)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect((await handleAuthentication(request("/api/auth/sign-in/email", { email: target.email, password: syntheticPassword }))).status).toBe(200);
  });

  it("serializes an in-flight session insert before deactivation and revokes it in the same committed change", async () => {
    const target = await account();
    let releaseInsert!: () => void;
    let signalInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { signalInserted = resolve; });
    const release = new Promise<void>((resolve) => { releaseInsert = resolve; });
    const insertion = database.transaction(async (transaction) => {
      await transaction.insert(schema.authSessions).values({ id: randomUUID(), userId: target.id, token: randomUUID(), expiresAt: new Date(Date.now() + 60000) });
      signalInserted();
      await release;
    });
    await inserted;
    const deactivation = updateAccountAccess(admin, target.id, { active: false }, database);
    releaseInsert();
    await Promise.all([insertion, deactivation]);
    const [sessions] = await database.select({ total: count() }).from(schema.authSessions).where(eq(schema.authSessions.userId, target.id));
    expect(sessions.total).toBe(0);
    await expect(seedSyntheticSession(database, target)).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("denies a session insert queued behind a deactivation and keeps it revoked after reactivation", async () => {
    const target = await account();
    let releaseUpdate!: () => void;
    let signalUpdated!: () => void;
    const updated = new Promise<void>((resolve) => { signalUpdated = resolve; });
    const release = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const deactivation = database.transaction(async (transaction) => {
      await transaction.update(schema.authUsers).set({ active: false }).where(eq(schema.authUsers.id, target.id));
      signalUpdated();
      await release;
    });
    await updated;
    const insertion = seedSyntheticSession(database, target);
    releaseUpdate();
    await deactivation;
    await expect(insertion).rejects.toMatchObject({ cause: { code: "23514" } });
    await updateAccountAccess(admin, target.id, { active: true }, database);
    const [sessions] = await database.select({ total: count() }).from(schema.authSessions).where(eq(schema.authSessions.userId, target.id));
    expect(sessions.total).toBe(0);
  });
});

describe("U4 shared durable limits and HTTP protection", () => {
  it("atomically limits concurrent consumers across independent database clients", async () => {
    const operation = randomUUID();
    const otherConnection = postgres(databaseUrl("runtime"), { max: 4 });
    try {
      const otherDatabase = drizzle(otherConnection, { schema });
      const outcomes = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => consumeRateLimit(operation, "synthetic", { maximum: 5, windowSeconds: 60 }, index % 2 ? database : otherDatabase, configuration.secret)));
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(15);
    } finally {
      await otherConnection.end();
    }
  });

  it("prunes a bounded expired batch without resetting active concurrent counters", async () => {
    const prefix = randomUUID();
    await database.insert(schema.authRateLimits).values(Array.from({ length: 70 }, (_, index) => ({ key: `${prefix}-${index}`, attempts: 1, expiresAt: new Date(0) })));
    const operation = randomUUID();
    await consumeRateLimit(operation, "active", { maximum: 1, windowSeconds: 60 }, database, configuration.secret);
    const [remaining] = await database.select({ total: count() }).from(schema.authRateLimits).where(sql`${schema.authRateLimits.key} like ${`${prefix}-%`}`);
    expect(remaining.total).toBe(20);
    const results = await Promise.allSettled([
      pruneExpiredRateLimits(database),
      consumeRateLimit(operation, "active", { maximum: 1, windowSeconds: 60 }, database, configuration.secret),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    const [left] = await database.select({ total: count() }).from(schema.authRateLimits).where(sql`${schema.authRateLimits.key} like ${`${prefix}-%`}`);
    expect(left.total).toBe(0);
  });

  it("enforces CSRF, byte bounds and persistent login limits despite changing forged forwarding headers", async () => {
    const email = `${randomUUID()}@example.invalid`;
    for (const origin of ["https://evil.invalid", "null", ""]) {
      const response = await handleAuthentication(request("/api/auth/sign-in/email", { email, password: syntheticPassword }, { origin }));
      expect(response.status).toBe(403);
    }
    const oversized = new Request(`${configuration.baseURL}/api/auth/sign-in/email`, { method: "POST", headers: { host: new URL(configuration.baseURL).host, origin: configuration.baseURL, "content-type": "application/json" }, body: "x".repeat(5000) });
    expect((await handleAuthentication(oversized)).status).toBe(413);
    for (let index = 0; index < 10; index++) {
      const response = await handleAuthentication(request("/api/auth/sign-in/email", { email, password: syntheticPassword }, { "x-forwarded-for": `192.0.2.${index}`, "x-forwarded-host": "evil.invalid", "x-forwarded-proto": "https" }));
      expect(response.status).toBe(401);
    }
    const limited = await handleAuthentication(request("/api/auth/sign-in/email", { email, password: syntheticPassword }, { "x-forwarded-for": "198.51.100.1" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(JSON.stringify(await limited.json())).not.toContain(email);
  });
});
