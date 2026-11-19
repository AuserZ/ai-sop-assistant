import { jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");

export const auditEvents = appSchema.table("audit_events", {
  id: uuid().defaultRandom().primaryKey(),
  actorId: text("actor_id").notNull(),
  action: text().notNull(),
  targetId: text("target_id"),
  outcome: text().notNull(),
  metadata: jsonb().$type<Record<string, string | number | boolean>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
