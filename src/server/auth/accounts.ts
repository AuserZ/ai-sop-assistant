import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { auditEvents, authInvitations, authSessions, authUsers } from "../db/schema";
import { lockCurrentAdmin, type AuthTransaction, type CurrentAccount } from "./authorization";
import { AuthFailure } from "./errors";
import type { AuthDatabase } from "./rate-limit";
import {
  accountAccessInput,
  escapeIlikePattern,
  listUsersQueryInput,
  targetUserIdInput,
  type UserRole,
  type UserStatus,
} from "./validation";

export type DirectoryUserDto = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
};

export type PendingInvitationDto = {
  id: string;
  email: string;
  role: UserRole;
  invitedBy: string;
  expiresAt: string;
  createdAt: string;
};

export type UserDirectorySummaryDto = {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  activeAdmins: number;
  pendingInvitations: number;
};

export type UserDirectoryResponse = {
  users: DirectoryUserDto[];
  pendingInvitations: PendingInvitationDto[];
  summary: UserDirectorySummaryDto;
};

export function toDirectoryUserDto(
  user: Pick<
    typeof authUsers.$inferSelect,
    "id" | "name" | "email" | "role" | "active" | "createdAt" | "updatedAt"
  >,
): DirectoryUserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    status: user.active ? "ACTIVE" : "INACTIVE",
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function assertNotLastActiveAdmin(
  transaction: AuthTransaction,
  target: Pick<typeof authUsers.$inferSelect, "id" | "role" | "active">,
  changes: { role?: UserRole; active?: boolean },
) {
  if (
    target.role === "ADMIN" &&
    target.active &&
    (changes.active === false || changes.role === "STAFF")
  ) {
    const [otherAdmin] = await transaction
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(
        and(
          eq(authUsers.role, "ADMIN"),
          eq(authUsers.active, true),
          ne(authUsers.id, target.id),
        ),
      )
      .limit(1)
      .for("share");
    if (!otherAdmin) {
      throw new AuthFailure("LAST_ADMIN_REQUIRED", 409);
    }
  }
}

export async function listDirectoryUsers(
  actor: CurrentAccount,
  rawQuery: unknown = {},
  database: AuthDatabase = getDatabase(),
): Promise<UserDirectoryResponse> {
  const parsed = listUsersQueryInput.safeParse(rawQuery ?? {});
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);

  return database.transaction(async (transaction) => {
    await lockCurrentAdmin(actor, transaction);

    const conditions: SQL[] = [];
    if (parsed.data.role !== undefined) {
      conditions.push(eq(authUsers.role, parsed.data.role));
    }
    if (parsed.data.status !== undefined) {
      conditions.push(eq(authUsers.active, parsed.data.status === "ACTIVE"));
    }
    if (parsed.data.q.length > 0) {
      const pattern = `%${escapeIlikePattern(parsed.data.q)}%`;
      conditions.push(
        sql`(${authUsers.name} ilike ${pattern} escape '\\' or ${authUsers.email} ilike ${pattern} escape '\\')`,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await transaction
      .select({
        id: authUsers.id,
        name: authUsers.name,
        email: authUsers.email,
        role: authUsers.role,
        active: authUsers.active,
        createdAt: authUsers.createdAt,
        updatedAt: authUsers.updatedAt,
      })
      .from(authUsers)
      .where(whereClause)
      .orderBy(desc(authUsers.createdAt), asc(authUsers.id))
      .limit(parsed.data.limit);

    const pendingCondition = and(
      isNotNull(authInvitations.deliveredAt),
      isNull(authInvitations.consumedAt),
      isNull(authInvitations.revokedAt),
      gt(authInvitations.expiresAt, sql`clock_timestamp()`),
    );

    const pendingRows = await transaction
      .select({
        id: authInvitations.id,
        email: authInvitations.email,
        role: authInvitations.role,
        invitedBy: authInvitations.invitedBy,
        expiresAt: authInvitations.expiresAt,
        createdAt: authInvitations.createdAt,
      })
      .from(authInvitations)
      .where(pendingCondition)
      .orderBy(desc(authInvitations.createdAt), asc(authInvitations.id))
      .limit(100);

    const [userCounts] = await transaction
      .select({
        totalUsers: sql<number>`count(*)::int`,
        activeUsers: sql<number>`count(*) filter (where ${authUsers.active} = true)::int`,
        inactiveUsers: sql<number>`count(*) filter (where ${authUsers.active} = false)::int`,
        activeAdmins: sql<number>`count(*) filter (where ${authUsers.active} = true and ${authUsers.role} = 'ADMIN')::int`,
      })
      .from(authUsers);

    const [invitationCount] = await transaction
      .select({
        pendingInvitations: sql<number>`count(*)::int`,
      })
      .from(authInvitations)
      .where(pendingCondition);

    return {
      users: rows.map(toDirectoryUserDto),
      pendingInvitations: pendingRows.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
        expiresAt: invitation.expiresAt.toISOString(),
        createdAt: invitation.createdAt.toISOString(),
      })),
      summary: {
        totalUsers: Number(userCounts?.totalUsers ?? 0),
        activeUsers: Number(userCounts?.activeUsers ?? 0),
        inactiveUsers: Number(userCounts?.inactiveUsers ?? 0),
        activeAdmins: Number(userCounts?.activeAdmins ?? 0),
        pendingInvitations: Number(invitationCount?.pendingInvitations ?? 0),
      },
    };
  });
}

export async function updateAccountAccess(
  actor: CurrentAccount,
  targetId: string,
  changes: { role?: "ADMIN" | "STAFF"; active?: boolean },
  database: AuthDatabase = getDatabase(),
  options: { allowSelfTarget?: boolean } = {},
): Promise<{ user: DirectoryUserDto }> {
  const parsedId = targetUserIdInput.safeParse(targetId);
  if (!parsedId.success) throw new AuthFailure("NOT_FOUND", 404);
  const normalizedTargetId = parsedId.data;

  const parsed = accountAccessInput.safeParse(changes);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);

  return database.transaction(async (transaction) => {
    const users = await transaction
      .select()
      .from(authUsers)
      .where(inArray(authUsers.id, [actor.id, normalizedTargetId]))
      .orderBy(asc(authUsers.id))
      .for("update");
    const currentActor = users.find((user) => user.id === actor.id);
    if (!currentActor?.active) throw new AuthFailure("UNAUTHENTICATED", 401);
    if (currentActor.role !== "ADMIN") throw new AuthFailure("FORBIDDEN", 403);
    const [session] = await transaction
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, actor.sessionId),
          eq(authSessions.userId, actor.id),
          gt(authSessions.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .for("share");
    if (!session) throw new AuthFailure("UNAUTHENTICATED", 401);
    const target = users.find((user) => user.id === normalizedTargetId);
    if (!target) throw new AuthFailure("NOT_FOUND", 404);

    if (
      !options.allowSelfTarget &&
      actor.id === normalizedTargetId &&
      (parsed.data.active === false || parsed.data.role === "STAFF")
    ) {
      throw new AuthFailure("SELF_ACCESS_CHANGE_DENIED", 409);
    }

    await assertNotLastActiveAdmin(transaction, target, parsed.data);

    const nextRole = parsed.data.role ?? target.role;
    const nextActive = parsed.data.active ?? target.active;
    const updatedAt = new Date();

    const [updated] = await transaction
      .update(authUsers)
      .set({ role: nextRole, active: nextActive, updatedAt })
      .where(eq(authUsers.id, normalizedTargetId))
      .returning();

    await transaction.delete(authSessions).where(eq(authSessions.userId, normalizedTargetId));
    await transaction.insert(auditEvents).values({
      actorId: actor.id,
      action: "account_access_changed",
      targetId: normalizedTargetId,
      outcome: "accepted",
      metadata: {
        previousRole: target.role,
        role: nextRole,
        previousActive: target.active,
        active: nextActive,
      },
    });

    return { user: toDirectoryUserDto(updated ?? { ...target, role: nextRole, active: nextActive, updatedAt }) };
  });
}
