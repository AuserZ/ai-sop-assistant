import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { authConfiguration, readServerSecret } from "../src/server/auth/config";
import { databaseUrl } from "../src/server/db/config";
import { authAccounts, authUsers } from "../src/server/db/schema";

async function seedSyntheticAdmin() {
  const configuration = authConfiguration();
  const base = new URL(configuration.baseURL);
  if (process.env.SOP_SYNTHETIC_AUTH !== "1" || process.env.NODE_ENV === "production" ||
      base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) {
    throw new Error("Synthetic fixtures require explicit nonproduction loopback configuration.");
  }
  const password = readServerSecret("SYNTHETIC_ADMIN_PASSWORD");
  if (password.length < 12 || password.length > 128) throw new Error("Synthetic password must contain 12 to 128 characters.");
  const passwordHash = await hashPassword(password);
  const connection = postgres(databaseUrl("runtime"), { max: 1 });
  try {
    const database = drizzle(connection);
    const id = randomUUID();
    await database.transaction(async (transaction) => {
      const [created] = await transaction.insert(authUsers).values({
        id, name: "Synthetic Admin", email: "synthetic-admin@example.invalid", emailVerified: true, role: "ADMIN", active: true,
      }).onConflictDoNothing({ target: authUsers.email }).returning({ id: authUsers.id });
      if (!created) return;
      await transaction.insert(authAccounts).values({ id: randomUUID(), userId: id, accountId: id, providerId: "credential", password: passwordHash });
    });
    process.stdout.write("Synthetic Admin fixture ready. Existing accounts are preserved.\n");
  } finally {
    await connection.end();
  }
}

seedSyntheticAdmin().catch(() => {
  process.stderr.write("Synthetic Admin fixture failed. Check local-only configuration.\n");
  process.exitCode = 1;
});
