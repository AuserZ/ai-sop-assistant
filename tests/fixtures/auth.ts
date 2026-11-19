import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { authAccounts, authSessions, authUsers } from "../../src/server/db/schema";
import type { AuthDatabase } from "../../src/server/auth/rate-limit";
import type { CurrentAccount } from "../../src/server/auth/authorization";

export const syntheticPassword = "Synthetic-only-Password-482!";

export async function seedSyntheticAccount(database: AuthDatabase, role: "ADMIN" | "STAFF" = "STAFF", email = `${randomUUID()}@example.invalid`) {
  if (!email.endsWith("@example.invalid")) throw new Error("Only synthetic accounts are allowed.");
  const id = randomUUID();
  const password = await hashPassword(syntheticPassword);
  await database.transaction(async (transaction) => {
    await transaction.insert(authUsers).values({ id, name: "Synthetic account", email, emailVerified: true, role, active: true });
    await transaction.insert(authAccounts).values({ id: randomUUID(), userId: id, accountId: id, providerId: "credential", password });
  });
  return { id, email, role };
}

export async function seedSyntheticSession(database: AuthDatabase, user: { id: string; email: string; role: "ADMIN" | "STAFF" }): Promise<CurrentAccount> {
  const sessionId = randomUUID();
  const sessionExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await database.insert(authSessions).values({ id: sessionId, userId: user.id, token: randomBytes(32).toString("hex"), expiresAt: sessionExpiresAt });
  return { ...user, name: "Synthetic account", sessionId, sessionExpiresAt };
}
