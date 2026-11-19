import { and, eq, gt, sql } from "drizzle-orm";
import { authSessions, authUsers } from "../db/schema";
import { getDatabase } from "../db/client";
import { getAuthentication } from "./authentication";
import { AuthFailure } from "./errors";
import type { AuthDatabase } from "./rate-limit";
import type { UserRole } from "./validation";

export type CurrentAccount = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  sessionId: string;
  sessionExpiresAt: Date;
};

export type AuthTransaction = Parameters<Parameters<AuthDatabase["transaction"]>[0]>[0];

export async function requireCurrentAccount(
  headers: Headers,
  database: AuthDatabase = getDatabase(),
  authentication = getAuthentication(),
): Promise<CurrentAccount> {
  const session = await authentication.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session) throw new AuthFailure("UNAUTHENTICATED", 401);
  const [account] = await database.select({
    id: authUsers.id,
    name: authUsers.name,
    email: authUsers.email,
    role: authUsers.role,
    sessionId: authSessions.id,
    sessionExpiresAt: authSessions.expiresAt,
  }).from(authUsers).innerJoin(authSessions, eq(authSessions.userId, authUsers.id)).where(and(
    eq(authUsers.id, session.user.id), eq(authUsers.active, true),
    eq(authSessions.id, session.session.id), gt(authSessions.expiresAt, sql`clock_timestamp()`),
  ));
  if (!account) throw new AuthFailure("UNAUTHENTICATED", 401);
  return account;
}

export function requireRole(account: CurrentAccount, role: UserRole) {
  if (account.role !== role) throw new AuthFailure("FORBIDDEN", 403);
}

export function requireOwner(account: CurrentAccount, ownerId: string) {
  if (account.id !== ownerId) throw new AuthFailure("NOT_FOUND", 404);
}

export async function lockCurrentAdmin(account: CurrentAccount, transaction: AuthTransaction) {
  const [user] = await transaction.select().from(authUsers).where(eq(authUsers.id, account.id)).for("share");
  if (!user?.active) throw new AuthFailure("UNAUTHENTICATED", 401);
  if (user.role !== "ADMIN") throw new AuthFailure("FORBIDDEN", 403);
  const [session] = await transaction.select({ id: authSessions.id }).from(authSessions).where(and(
    eq(authSessions.id, account.sessionId), eq(authSessions.userId, account.id),
    gt(authSessions.expiresAt, sql`clock_timestamp()`),
  )).for("share");
  if (!session) throw new AuthFailure("UNAUTHENTICATED", 401);
}

export function publicAccount(account: Pick<CurrentAccount, "id" | "name" | "email" | "role">) {
  return { id: account.id, name: account.name, email: account.email, role: account.role };
}
