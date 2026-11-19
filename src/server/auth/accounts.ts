import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { auditEvents, authSessions, authUsers } from "../db/schema";
import type { CurrentAccount } from "./authorization";
import { AuthFailure } from "./errors";
import type { AuthDatabase } from "./rate-limit";
import { accountAccessInput } from "./validation";

export async function updateAccountAccess(
  actor: CurrentAccount,
  targetId: string,
  changes: { role?: "ADMIN" | "STAFF"; active?: boolean },
  database: AuthDatabase = getDatabase(),
) {
  const parsed = accountAccessInput.safeParse(changes);
  if (!parsed.success) throw new AuthFailure("INVALID_INPUT", 400);
  await database.transaction(async (transaction) => {
    const users = await transaction.select().from(authUsers)
      .where(inArray(authUsers.id, [actor.id, targetId])).orderBy(asc(authUsers.id)).for("update");
    const currentActor = users.find((user) => user.id === actor.id);
    if (!currentActor?.active) throw new AuthFailure("UNAUTHENTICATED", 401);
    if (currentActor.role !== "ADMIN") throw new AuthFailure("FORBIDDEN", 403);
    const [session] = await transaction.select({ id: authSessions.id }).from(authSessions).where(and(
      eq(authSessions.id, actor.sessionId), eq(authSessions.userId, actor.id), gt(authSessions.expiresAt, sql`clock_timestamp()`),
    )).for("share");
    if (!session) throw new AuthFailure("UNAUTHENTICATED", 401);
    const target = users.find((user) => user.id === targetId);
    if (!target) throw new AuthFailure("NOT_FOUND", 404);
    if (actor.id === targetId && (parsed.data.active === false || parsed.data.role === "STAFF")) {
      throw new AuthFailure("SELF_ACCESS_CHANGE_DENIED", 409);
    }
    await transaction.update(authUsers).set({ ...parsed.data, updatedAt: new Date() }).where(eq(authUsers.id, targetId));
    await transaction.delete(authSessions).where(eq(authSessions.userId, targetId));
    await transaction.insert(auditEvents).values({ actorId: actor.id, action: "account_access_changed", targetId, outcome: "accepted" });
  });
}
