import { readFileSync } from "node:fs";

type DatabaseRole = "runtime" | "migrator" | "workflow";

const connections = {
  runtime: { prefix: "APP_DB", user: "sop_runtime", database: "sop_app" },
  migrator: { prefix: "MIGRATION_DB", user: "sop_migrator", database: "sop_app" },
  workflow: { prefix: "WORKFLOW_DB", user: "sop_n8n", database: "sop_n8n" },
} as const;

export function databaseUrl(role: DatabaseRole, env: Readonly<Record<string, string | undefined>> = process.env) {
  const { prefix, user, database } = connections[role];
  const explicitUrl = env[`${prefix}_URL`];
  const secretPath = env[`${prefix}_PASSWORD_FILE`];

  if (explicitUrl && secretPath) {
    throw new Error(`Configure only one credential source for ${prefix}.`);
  }
  if (explicitUrl) return explicitUrl;
  if (!secretPath || !env.DB_HOST) {
    throw new Error(`Missing database configuration for ${prefix}.`);
  }

  const password = readFileSync(secretPath, "utf8").trimEnd();
  if (!password) throw new Error(`Empty database credential for ${prefix}.`);

  const url = new URL(`postgresql://${env.DB_HOST}:${env.DB_PORT ?? "5432"}/${database}`);
  return `postgresql://${user}:${encodeURIComponent(password)}@${url.host}${url.pathname}`;
}
