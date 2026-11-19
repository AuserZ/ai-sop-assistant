import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const directory = new URL("../.local-secrets/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });

for (const name of ["postgres-admin", "app-runtime", "app-migrator", "n8n-db"]) {
  try {
    await writeFile(new URL(name, directory), randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o444,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

console.log("Local Compose secret files are ready.");
