import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { databaseUrl } from "../../src/server/db/config";
import { auditEvents } from "../../src/server/db/schema";

function backupDatabaseUrl(database: "sop_app" | "sop_n8n") {
  if (process.env.BACKUP_DB_URL) {
    const url = new URL(process.env.BACKUP_DB_URL);
    url.pathname = `/${database}`;
    return url.toString();
  }
  const secretPath = process.env.BACKUP_DB_PASSWORD_FILE;
  if (!secretPath || !process.env.DB_HOST) {
    throw new Error("Missing database configuration for BACKUP_DB.");
  }
  const password = readFileSync(secretPath, "utf8").trimEnd();
  if (!password) throw new Error("Empty database credential for BACKUP_DB.");
  const url = new URL(`postgresql://${process.env.DB_HOST}:${process.env.DB_PORT ?? "5432"}/${database}`);
  return `postgresql://sop_backup:${encodeURIComponent(password)}@${url.host}${url.pathname}`;
}

const runtime = postgres(databaseUrl("runtime"), { max: 1 });
const workflow = postgres(databaseUrl("workflow"), { max: 1 });
const backupApp = postgres(backupDatabaseUrl("sop_app"), { max: 1 });
const backupN8n = postgres(backupDatabaseUrl("sop_n8n"), { max: 1 });

afterAll(async () => {
  await Promise.all([runtime.end(), workflow.end(), backupApp.end(), backupN8n.end()]);
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

  it("restricts sop_backup to read-only access across sop_app and sop_n8n (SEC-S15-01)", async () => {
    const [roleInfo] = await backupApp`
      select current_user as role, current_database() as db,
             r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication
        from pg_roles r
       where r.rolname = current_user
    `;
    expect(roleInfo).toEqual({
      role: "sop_backup",
      db: "sop_app",
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
    });

    const [docCount] = await backupApp`select count(*)::int as count from app.sop_documents`;
    expect(docCount?.count).toBeGreaterThanOrEqual(0);

    await expect(backupApp`insert into app.sop_documents default values`).rejects.toMatchObject({ code: "42501" });
    await expect(backupApp`update app.sop_documents set title = title where false`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(backupApp`delete from app.sop_documents where false`).rejects.toMatchObject({ code: "42501" });

    await expect(backupApp`insert into app.auth_users default values`).rejects.toMatchObject({ code: "42501" });
    await expect(backupApp`update app.auth_users set email = email where false`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(backupApp`delete from app.auth_users where false`).rejects.toMatchObject({ code: "42501" });

    await expect(
      backupApp`
        insert into app.audit_events (id, actor_id, action, outcome)
        values (${randomUUID()}, 'backup-role-test', 'write_denied', 'denied')
      `,
    ).rejects.toMatchObject({ code: "42501" });
    await expect(backupApp`update app.audit_events set outcome = outcome where false`).rejects.toMatchObject({
      code: "42501",
    });
    await expect(backupApp`delete from app.audit_events where false`).rejects.toMatchObject({ code: "42501" });

    await expect(backupApp`create table app.backup_forbidden (id integer)`).rejects.toMatchObject({ code: "42501" });
    await expect(backupApp`create table public.backup_forbidden (id integer)`).rejects.toMatchObject({ code: "42501" });

    const [n8nRow] = await backupN8n`select current_user as role, current_database() as db`;
    expect(n8nRow).toEqual({ role: "sop_backup", db: "sop_n8n" });
    await expect(backupN8n`create table public.backup_forbidden_n8n (id integer)`).rejects.toMatchObject({
      code: "42501",
    });
  });
});
