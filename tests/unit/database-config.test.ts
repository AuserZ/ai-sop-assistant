import { mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { databaseUrl } from "../../src/server/db/config";

describe("database credential boundaries", () => {
  it("never falls back to a migration or workflow credential for the runtime", () => {
    expect(() => databaseUrl("runtime", {
      MIGRATION_DB_URL: "postgresql://synthetic-migrator@localhost/sop_app",
      WORKFLOW_DB_URL: "postgresql://synthetic-worker@localhost/sop_n8n",
    })).toThrow("Missing database configuration for APP_DB.");
  });

  it("rejects two competing credential sources for a role", () => {
    expect(() => databaseUrl("migrator", {
      MIGRATION_DB_URL: "postgresql://synthetic-migrator@localhost/sop_app",
      MIGRATION_DB_PASSWORD_FILE: "unused",
    })).toThrow("Configure only one credential source for MIGRATION_DB.");
  });

  it("keeps punctuation in file credentials out of the connection URL structure", () => {
    const dir = mkdtempSync(join(tmpdir(), "sop-db-unit-"));
    try {
      const file = join(dir, "password");
      writeFileSync(file, "synthetic/@?#%:\n");
      const url = new URL(databaseUrl("runtime", { DB_HOST: "postgres", APP_DB_PASSWORD_FILE: file }));
      expect(url.username).toBe("sop_runtime");
      expect(decodeURIComponent(url.password)).toBe("synthetic/@?#%:");
      expect(url.host).toBe("postgres:5432");
      expect(url.pathname).toBe("/sop_app");
      expect(url.search).toBe("");
    } finally {
      rmSync(join(dir, "password"), { force: true });
      rmdirSync(dir);
    }
  });
});
