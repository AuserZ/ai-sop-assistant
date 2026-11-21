import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { z } from "zod";
import { updateAccountAccess } from "../../src/server/auth/accounts";
import { authConfiguration } from "../../src/server/auth/config";
import { databaseUrl } from "../../src/server/db/config";
import * as schema from "../../src/server/db/schema";

async function controlWorkflowFixture() {
  const base = new URL(authConfiguration().baseURL);
  const fixtureDirectory = process.env.BROWSER_FIXTURE_DIRECTORY;
  if (process.env.SOP_SYNTHETIC_AUTH !== "1" || process.env.NODE_ENV === "production" || !fixtureDirectory ||
      base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new Error("Explicit local synthetic configuration is required.");
  }
  const fixture = z.object({
    staff: z.object({ id: z.uuid(), email: z.email() }),
    admin: z.object({ id: z.uuid(), email: z.email() }),
    workflowRevocationUser: z.object({ id: z.uuid(), email: z.email() }),
    workflowAdmin: z.object({
      id: z.uuid(), name: z.string(), email: z.email(), role: z.literal("ADMIN"),
      sessionId: z.uuid(), sessionExpiresAt: z.coerce.date(),
    }),
  }).parse(JSON.parse(readFileSync(join(fixtureDirectory, "s02-browser-fixture.json"), "utf8")));
  if (![fixture.staff.email, fixture.admin.email, fixture.workflowRevocationUser.email, fixture.workflowAdmin.email].every((email) => email.endsWith("@example.invalid"))) {
    throw new Error("Only synthetic fixture accounts may be changed.");
  }
  const connection = postgres(databaseUrl("runtime"), { max: 1 });
  try {
    const database = drizzle(connection, { schema });
    if (process.argv[2] === "status") {
      const jobId = z.uuid().parse(process.argv[3]);
      const [job] = await database.select({
        ownerId: schema.workflowJobs.ownerId, state: schema.workflowJobs.state,
        step: schema.workflowJobs.step, attemptNumber: schema.workflowJobs.attemptNumber,
        dispatchCount: schema.workflowJobs.dispatchCount, dispatchAcceptedAt: schema.workflowJobs.dispatchAcceptedAt,
      }).from(schema.workflowJobs).where(eq(schema.workflowJobs.id, jobId));
      if (!job || ![fixture.staff.id, fixture.admin.id, fixture.workflowRevocationUser.id].includes(job.ownerId)) {
        throw new Error("Only fixture-owned jobs may be inspected.");
      }
      const expectedOwner = [fixture.staff, fixture.admin, fixture.workflowRevocationUser].find((user) => user.id === job.ownerId);
      const [owner] = await database.select({ email: schema.authUsers.email }).from(schema.authUsers).where(eq(schema.authUsers.id, job.ownerId));
      if (!owner || owner.email !== expectedOwner?.email || !owner.email.endsWith("@example.invalid")) {
        throw new Error("Stored ownership must match the synthetic fixture.");
      }
      process.stdout.write(`${JSON.stringify({ state: job.state, step: job.step, attemptNumber: job.attemptNumber,
        dispatchCount: job.dispatchCount, dispatchAccepted: Boolean(job.dispatchAcceptedAt) })}\n`);
    } else if (process.argv[2] === "deactivate") {
      const [target] = await database.select({ email: schema.authUsers.email }).from(schema.authUsers).where(eq(schema.authUsers.id, fixture.workflowRevocationUser.id));
      const [actor] = await database.select({ email: schema.authUsers.email }).from(schema.authUsers).where(eq(schema.authUsers.id, fixture.workflowAdmin.id));
      if (!target || !actor || target.email !== fixture.workflowRevocationUser.email || actor.email !== fixture.workflowAdmin.email ||
          ![target.email, actor.email].every((email) => email.endsWith("@example.invalid"))) {
        throw new Error("Stored identities must match the synthetic fixture.");
      }
      await updateAccountAccess(fixture.workflowAdmin, fixture.workflowRevocationUser.id, { active: false }, database);
      process.stdout.write("Synthetic stream-revocation account deactivated; its sessions were revoked.\n");
    } else {
      throw new Error("Unsupported synthetic control action.");
    }
  } finally {
    await connection.end();
  }
}

controlWorkflowFixture().catch(() => {
  process.stderr.write("Synthetic stream-revocation control failed; no personal account was targeted.\n");
  process.exitCode = 1;
});
