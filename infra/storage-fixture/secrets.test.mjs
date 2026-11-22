import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createFixtureSecrets } from "./create-secrets.mjs";

test("fixture credentials stay synthetic and unchanged across retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "s04-storage-secrets-"));
  const url = pathToFileURL(directory + "/");
  try {
    await createFixtureSecrets(url);
    const names = await readdir(directory);
    assert.deepEqual(names.sort(), ["access-key-id", "secret-access-key"]);
    const before = await Promise.all(names.map(name => readFile(join(directory, name), "utf8")));
    await createFixtureSecrets(url);
    assert.deepEqual(await Promise.all(names.map(name => readFile(join(directory, name), "utf8"))), before);
    await chmod(join(directory, "access-key-id"), 0o600);
    await writeFile(join(directory, "access-key-id"), "not-a-synthetic-credential");
    await assert.rejects(createFixtureSecrets(url), /not replaced/);
    assert.equal(await readFile(join(directory, "access-key-id"), "utf8"), "not-a-synthetic-credential");
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(directory, { recursive: true, force: true });
  }
});
