import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { authConfiguration } from "../../src/server/auth/config";
import { issueInvitation } from "../../src/server/auth/invitations";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";
import { seedSyntheticAccount, seedSyntheticSession, syntheticPassword } from "../fixtures/auth";

async function seedBrowserFixtures() {
  const configuration = authConfiguration();
  const base = new URL(configuration.baseURL);
  const outputDirectory = process.env.BROWSER_FIXTURE_DIRECTORY;
  if (process.env.SOP_SYNTHETIC_AUTH !== "1" || process.env.NODE_ENV === "production" ||
      base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !outputDirectory) {
    throw new Error("Browser fixtures require explicit nonproduction loopback configuration and an output directory.");
  }
  const connection = postgres(databaseUrl("runtime"), { max: 1 });
  try {
    const database = drizzle(connection, { schema });
    const admin = await seedSyntheticAccount(database, "ADMIN");
    const staff = await seedSyntheticAccount(database);
    const actor = await seedSyntheticSession(database, admin);
    const workflowRevocationUser = await seedSyntheticAccount(database);
    const invitations: Array<{ email: string; acceptUrl: string }> = [];
    for (let index = 0; index < 2; index++) {
      const email = `${randomUUID()}@example.invalid`;
      await issueInvitation(actor, { email, role: "STAFF" }, {
        database,
        configuration,
        sendEmail: async ({ acceptUrl }) => { invitations.push({ email, acceptUrl }); },
      });
    }
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, "s02-browser-fixture.json"), JSON.stringify({
      version: 1, baseURL: configuration.baseURL, admin, staff, password: syntheticPassword, invitations,
      workflowRevocationUser, workflowAdmin: actor,
    }), { mode: 0o600 });
    process.stdout.write("Synthetic browser fixtures ready. Delivery was injected; no email provider was called.\n");
  } finally {
    await connection.end();
  }
}

seedBrowserFixtures().catch(() => {
  process.stderr.write("Synthetic browser fixture preparation failed. Check the isolated test configuration.\n");
  process.exitCode = 1;
});
