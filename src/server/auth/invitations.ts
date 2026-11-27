import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { auditEvents, authAccounts, authInvitations, authUsers } from "../db/schema";
import { lockCurrentAdmin, type CurrentAccount } from "./authorization";
import { authConfiguration } from "./config";
import { AuthFailure } from "./errors";
import { authLimits, consumeRateLimit, type AuthDatabase } from "./rate-limit";
import { invitationAcceptanceInput, invitationInput } from "./validation";
import type { InvitationDelivery } from "../email/invitation";

type InvitationDependencies = {
  database?: AuthDatabase;
  configuration?: ReturnType<typeof authConfiguration>;
  sendEmail?: (invitation: InvitationDelivery) => Promise<void>;
};

export function invitationTokenDigest(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueInvitation(actor: CurrentAccount, input: unknown, dependencies: InvitationDependencies = {}) {
  const parsed = invitationInput.safeParse(input);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  const database = dependencies.database ?? getDatabase();
  const configuration = dependencies.configuration ?? authConfiguration();
  await consumeRateLimit("invite-global", "all", authLimits.global, database, configuration.secret);
  await consumeRateLimit("invite-actor", actor.id, authLimits.invite, database, configuration.secret);
  const token = randomBytes(32).toString("base64url");
  const invitation = await database.transaction(async (transaction) => {
    await lockCurrentAdmin(actor, transaction);
    // Serialize concurrent invitations for the same email even when no pending row exists yet.
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${parsed.data.email}, 7480201))`,
    );
    const [existing] = await transaction.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, parsed.data.email));
    if (existing) throw new AuthFailure("ACCOUNT_EXISTS", 409);
    const [pending] = await transaction
      .select({ id: authInvitations.id })
      .from(authInvitations)
      .where(
        and(
          eq(authInvitations.email, parsed.data.email),
          isNull(authInvitations.consumedAt),
          isNull(authInvitations.revokedAt),
          gt(authInvitations.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .for("update");
    if (pending) throw new AuthFailure("INVITATION_ALREADY_PENDING", 409);
    const [created] = await transaction.insert(authInvitations).values({
      ...parsed.data,
      invitedBy: actor.id,
      tokenDigest: invitationTokenDigest(token),
      expiresAt: sql`clock_timestamp() + interval '24 hours'`,
    }).returning();
    await transaction.insert(auditEvents).values({
      actorId: actor.id,
      action: "invitation_created",
      targetId: created.id,
      outcome: "pending_delivery",
      metadata: { role: created.role },
    });
    return created;
  });

  try {
    // A fragment keeps the bearer token out of HTTP request URLs and referrers.
    const acceptUrl = `${configuration.baseURL}/accept-invitation#${token}`;
    const sendEmail = dependencies.sendEmail ?? (await import("../email/invitation")).sendInvitationEmail;
    await sendEmail({ email: invitation.email, role: invitation.role, acceptUrl, expiresAt: invitation.expiresAt, invitationId: invitation.id });
    await database.transaction(async (transaction) => {
      await lockCurrentAdmin(actor, transaction);
      const [delivered] = await transaction.update(authInvitations).set({ deliveredAt: sql`clock_timestamp()` }).where(and(
        eq(authInvitations.id, invitation.id), isNull(authInvitations.revokedAt),
        gt(authInvitations.expiresAt, sql`clock_timestamp()`),
      )).returning({ id: authInvitations.id });
      if (!delivered) throw new AuthFailure("INVITATION_DELIVERY_FAILED", 503);
      await transaction.insert(auditEvents).values({
        actorId: actor.id,
        action: "invitation_delivered",
        targetId: invitation.id,
        outcome: "accepted",
        metadata: { role: invitation.role },
      });
    });
  } catch {
    await database.update(authInvitations).set({ revokedAt: sql`clock_timestamp()` }).where(eq(authInvitations.id, invitation.id)).catch(() => undefined);
    await database.insert(auditEvents).values({
      actorId: actor.id,
      action: "invitation_delivery_failed",
      targetId: invitation.id,
      outcome: "revoked",
      metadata: { role: invitation.role },
    }).catch(() => undefined);
    throw new AuthFailure("INVITATION_DELIVERY_FAILED", 503);
  }
  return { invitationId: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt };
}

export async function acceptInvitation(input: unknown, dependencies: Omit<InvitationDependencies, "sendEmail"> = {}) {
  const parsed = invitationAcceptanceInput.safeParse(input);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  const database = dependencies.database ?? getDatabase();
  const configuration = dependencies.configuration ?? authConfiguration();
  const { token, email, name, password } = parsed.data;
  await consumeRateLimit("accept-global", "all", authLimits.global, database, configuration.secret);
  await consumeRateLimit("accept-token", token, authLimits.accept, database, configuration.secret);
  await consumeRateLimit("accept-email", email, authLimits.accept, database, configuration.secret);
  const eligible = and(
    eq(authInvitations.tokenDigest, invitationTokenDigest(token)), eq(authInvitations.email, email),
    isNull(authInvitations.consumedAt), isNull(authInvitations.revokedAt),
    sql`${authInvitations.deliveredAt} is not null`, gt(authInvitations.expiresAt, sql`clock_timestamp()`),
  );
  const [candidate] = await database.select({ id: authInvitations.id }).from(authInvitations).where(eligible);
  if (!candidate) throw new AuthFailure("INVALID_INVITATION", 400);
  const passwordHash = await hashPassword(password);
  try {
    await database.transaction(async (transaction) => {
      const [invitation] = await transaction.select().from(authInvitations).where(eligible).for("update");
      if (!invitation) throw new AuthFailure("INVALID_INVITATION", 400);
      const userId = randomUUID();
      await transaction.insert(authUsers).values({ id: userId, email, name, emailVerified: true, role: invitation.role, active: true });
      await transaction.insert(authAccounts).values({ id: randomUUID(), userId, accountId: userId, providerId: "credential", password: passwordHash });
      const [consumed] = await transaction.update(authInvitations).set({ consumedAt: sql`clock_timestamp()` })
        .where(and(eq(authInvitations.id, invitation.id), eligible)).returning({ id: authInvitations.id });
      if (!consumed) throw new AuthFailure("INVALID_INVITATION", 400);
      await transaction.insert(auditEvents).values({ actorId: userId, action: "invitation_accepted", targetId: invitation.id, outcome: "accepted" });
    });
  } catch (error) {
    if (error instanceof AuthFailure) throw error;
    if (error && typeof error === "object" && "cause" in error &&
        (error.cause as { code?: string } | undefined)?.code === "23505") {
      throw new AuthFailure("INVALID_INVITATION", 400);
    }
    throw error;
  }
  return { accepted: true };
}
