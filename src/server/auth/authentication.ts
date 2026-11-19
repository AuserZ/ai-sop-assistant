import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { getDatabase } from "../db/client";
import { authAccounts, authSessions, authUsers, authVerifications } from "../db/schema";
import { authConfiguration } from "./config";
import type { AuthDatabase } from "./rate-limit";

export function createAuthentication(
  database: AuthDatabase = getDatabase(),
  configuration = authConfiguration(),
) {
  return betterAuth({
    appName: "AI SOP Assistant",
    baseURL: configuration.baseURL,
    basePath: "/api/auth",
    secret: configuration.secret,
    trustedOrigins: [configuration.baseURL],
    database: drizzleAdapter(database, {
      provider: "pg",
      transaction: true,
      schema: { user: authUsers, account: authAccounts, session: authSessions, verification: authVerifications },
    }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
    user: {
      additionalFields: {
        role: { type: ["ADMIN", "STAFF"], required: true, defaultValue: "STAFF", input: false },
        active: { type: "boolean", required: true, defaultValue: true, input: false },
      },
    },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: false },
    advanced: {
      useSecureCookies: configuration.secureCookies,
      ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: configuration.secureCookies },
    },
    logger: { disabled: true },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const [user] = await database.select({ active: authUsers.active }).from(authUsers).where(eq(authUsers.id, session.userId));
            if (!user?.active) throw new APIError("UNAUTHORIZED", { message: "Invalid credentials." });
          },
        },
      },
    },
  });
}

let authentication: ReturnType<typeof createAuthentication> | undefined;

export function getAuthentication() {
  return (authentication ??= createAuthentication());
}
