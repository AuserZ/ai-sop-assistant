import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");

export const authUsers = appSchema.table("auth_users", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text(),
  role: text().$type<"ADMIN" | "STAFF">().default("STAFF").notNull(),
  active: boolean().default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("auth_users_role", sql`${table.role} in ('ADMIN', 'STAFF')`),
  check("auth_users_email_normalized", sql`${table.email} = lower(btrim(${table.email}))`),
]);

export const authSessions = appSchema.table("auth_sessions", {
  id: text().primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("auth_sessions_user_id").on(table.userId)]);

export const authAccounts = appSchema.table("auth_accounts", {
  id: text().primaryKey(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text(),
  password: text(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_accounts_provider_identity").on(table.providerId, table.accountId),
  index("auth_accounts_user_id").on(table.userId),
]);

export const authVerifications = appSchema.table("auth_verifications", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("auth_verifications_identifier").on(table.identifier)]);

export const authInvitations = appSchema.table("auth_invitations", {
  id: uuid().defaultRandom().primaryKey(),
  email: text().notNull(),
  role: text().$type<"ADMIN" | "STAFF">().notNull(),
  tokenDigest: text("token_digest").notNull().unique(),
  invitedBy: text("invited_by").notNull().references(() => authUsers.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("auth_invitations_role", sql`${table.role} in ('ADMIN', 'STAFF')`),
  check("auth_invitations_email_normalized", sql`${table.email} = lower(btrim(${table.email}))`),
]);

export const authRateLimits = appSchema.table("auth_rate_limits", {
  key: text().primaryKey(),
  attempts: integer().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("auth_rate_limits_expiry").on(table.expiresAt)]);

export const auditEvents = appSchema.table("audit_events", {
  id: uuid().defaultRandom().primaryKey(),
  actorId: text("actor_id").notNull(),
  action: text().notNull(),
  targetId: text("target_id"),
  outcome: text().notNull(),
  metadata: jsonb().$type<Record<string, string | number | boolean>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
