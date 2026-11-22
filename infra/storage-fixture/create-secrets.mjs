import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function createFixtureSecrets(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error("Fixture credentials require a private directory, not a symbolic link.");
  for (const [name, prefix, bytes] of [["access-key-id", "s04-fixture-access-", 16], ["secret-access-key", "s04-fixture-secret-", 32]]) {
    const file = new URL(name, directory);
    try { await writeFile(file, prefix + randomBytes(bytes).toString("hex"), { flag: "wx", mode: 0o444 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error("Fixture credential files cannot be symbolic links.");
    const value = await readFile(file, "utf8");
    if (!new RegExp(`^${prefix}[a-f0-9]{${bytes * 2}}$`).test(value)) throw new Error("Existing fixture credentials are invalid; files were not replaced.");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await createFixtureSecrets(new URL("../../.local-secrets/storage-fixtures/", import.meta.url));
  console.log("Synthetic storage credential files are ready; no provider credentials were generated.");
}
