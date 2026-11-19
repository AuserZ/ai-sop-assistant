import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import { auditEvents } from "../../src/server/db/schema";

const runtime = postgres(databaseUrl("runtime"), { max: 1 });
const workflow = postgres(databaseUrl("workflow"), { max: 1 });

afterAll(async () => {
  await Promise.all([runtime.end(), workflow.end()]);
});

describe("migrated PostgreSQL boundaries", () => {
  it("provides pgvector and the migrated app schema under the runtime identity", async () => {
    const [row] = await runtime`
      select current_user as role, '[0,0]'::public.vector <-> '[3,4]'::public.vector as distance
    `;
    expect(row).toEqual({ role: "sop_runtime", distance: 5 });

    const db = drizzle(runtime);
    const rollback = new Error("rollback synthetic audit event");
    await expect(db.transaction(async (tx) => {
      await tx.insert(auditEvents).values({
        id: randomUUID(),
        actorId: "synthetic",
        action: "integration_check",
        outcome: "accepted",
      });
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("denies the application credential migration and audit rewrite privileges", async () => {
    await expect(runtime`select * from drizzle.__drizzle_migrations`).rejects.toMatchObject({ code: "42501" });
    await expect(runtime`delete from app.audit_events where false`).rejects.toMatchObject({ code: "42501" });
    await expect(runtime`create table app.forbidden (id integer)`).rejects.toMatchObject({ code: "42501" });
  });

  it("isolates n8n operational access from application state", async () => {
    const [row] = await workflow`select current_user as role, current_database() as db`;
    expect(row).toEqual({ role: "sop_n8n", db: "sop_n8n" });

    const url = new URL(databaseUrl("workflow"));
    url.pathname = "/sop_app";
    const forbidden = postgres(url.toString(), { max: 1 });
    try {
      await expect(forbidden`select 1`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await forbidden.end();
    }
  });
});
