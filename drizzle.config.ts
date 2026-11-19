import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./src/server/db/config";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["app"],
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  ...(process.env.MIGRATION_DB_URL || process.env.MIGRATION_DB_PASSWORD_FILE
    ? { dbCredentials: { url: databaseUrl("migrator") } }
    : {}),
});
