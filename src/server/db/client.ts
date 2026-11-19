import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "./config";
import * as schema from "./schema";

function createDatabase() {
  const connection = postgres(databaseUrl("runtime"), {
    connect_timeout: 3,
    connection: { statement_timeout: 3000 },
  });
  return drizzle(connection, { schema });
}

const registry = globalThis as typeof globalThis & {
  sopDatabase?: ReturnType<typeof createDatabase>;
};

export function getDatabase() {
  return (registry.sopDatabase ??= createDatabase());
}
