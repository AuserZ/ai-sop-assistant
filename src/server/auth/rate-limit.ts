import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { authRateLimits } from "../db/schema";
import { authConfiguration } from "./config";
import { AuthFailure } from "./errors";

export type AuthDatabase = ReturnType<typeof getDatabase>;

export const authLimits = {
  signIn: { maximum: 10, windowSeconds: 60 },
  accept: { maximum: 10, windowSeconds: 60 },
  invite: { maximum: 20, windowSeconds: 3600 },
  session: { maximum: 120, windowSeconds: 60 },
  global: { maximum: 120, windowSeconds: 60 },
} as const;

export async function pruneExpiredRateLimits(database: AuthDatabase = getDatabase()) {
  await database.execute(sql`
    delete from app.auth_rate_limits
    where key in (
      select key from app.auth_rate_limits where expires_at <= clock_timestamp()
      order by expires_at limit 50 for update skip locked
    ) and expires_at <= clock_timestamp()
  `);
}

export async function consumeRateLimit(
  operation: string,
  identity: string,
  limit: { maximum: number; windowSeconds: number },
  database: AuthDatabase = getDatabase(),
  secret = authConfiguration().secret,
) {
  const key = createHmac("sha256", secret).update(`${operation}:${identity}`).digest("hex");
  const expiresAt = sql`clock_timestamp() + ${limit.windowSeconds} * interval '1 second'`;
  const [counter] = await database.insert(authRateLimits).values({ key, attempts: 1, expiresAt })
    .onConflictDoUpdate({
      target: authRateLimits.key,
      set: {
        attempts: sql`case when ${authRateLimits.expiresAt} <= clock_timestamp() then 1 else ${authRateLimits.attempts} + 1 end`,
        expiresAt: sql`case when ${authRateLimits.expiresAt} <= clock_timestamp() then ${expiresAt} else ${authRateLimits.expiresAt} end`,
      },
    }).returning({ attempts: authRateLimits.attempts });
  await pruneExpiredRateLimits(database);
  if (!counter || counter.attempts > limit.maximum) throw new AuthFailure("RATE_LIMITED", 429);
}
