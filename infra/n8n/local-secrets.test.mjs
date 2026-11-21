import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

test("S03 secret generation preserves credentials and independent RSA identities", () => {
  const parent = realpathSync(tmpdir());
  const workspace = mkdtempSync(join(parent, "ai-sop-s03-secrets-"));
  const secretsDirectory = join(workspace, ".local-secrets");
  try {
    mkdirSync(join(workspace, "scripts"));
    mkdirSync(secretsDirectory, { mode: 0o700 });
    const script = join(workspace, "scripts", "local-secrets.mjs");
    copyFileSync(new URL("../../scripts/local-secrets.mjs", import.meta.url), script);
    const original = new Map();
    for (const name of ["postgres-admin", "app-runtime", "app-migrator", "n8n-db", "auth-secret"]) {
      const value = randomBytes(32).toString("hex");
      original.set(name, value);
      writeFileSync(join(secretsDirectory, name), value, { mode: 0o444 });
    }
    const run = () => spawnSync(process.execPath, [script], { encoding: "utf8" });
    const first = run();
    assert.ok(first.status === 0, "Fresh generation must succeed.");
    for (const [name, value] of original) assert.ok(readFileSync(join(secretsDirectory, name), "utf8") === value, "Existing credentials must be preserved.");
    const snapshot = new Map(readdirSync(secretsDirectory).map(name => [name, readFileSync(join(secretsDirectory, name), "utf8")]));
    assert.equal(snapshot.size, 12);
    const second = run();
    assert.ok(second.status === 0, "Repeated generation must succeed.");
    for (const [name, value] of snapshot) {
      assert.ok(readFileSync(join(secretsDirectory, name), "utf8") === value, "Repeated generation must preserve every file.");
      assert.ok(!`${first.stdout}${first.stderr}${second.stdout}${second.stderr}`.includes(value), "Secrets must not reach output.");
    }
    const publicKeys = [];
    for (const direction of ["dispatch", "callback"]) {
      const privateKey = createPrivateKey(snapshot.get(`workflow-${direction}-private`));
      assert.ok(privateKey.asymmetricKeyType === "rsa" && privateKey.asymmetricKeyDetails.modulusLength >= 3072);
      const derived = createPublicKey(privateKey).export({ type: "spki", format: "der" });
      const stored = createPublicKey(snapshot.get(`workflow-${direction}-public`)).export({ type: "spki", format: "der" });
      assert.ok(derived.equals(stored), "Each public key must match its private key.");
      publicKeys.push(stored);
    }
    assert.ok(!publicKeys[0].equals(publicKeys[1]), "Directions must use independent keys.");
    if (process.platform !== "win32") {
      assert.equal(statSync(secretsDirectory).mode & 0o777, 0o700);
      assert.equal(statSync(join(secretsDirectory, "workflow-dispatch-private")).mode & 0o777, 0o444);
    }
    chmodSync(join(secretsDirectory, "workflow-dispatch-private"), 0o600);
    unlinkSync(join(secretsDirectory, "workflow-dispatch-private"));
    assert.ok(run().status !== 0, "A lost private key must fail closed.");
    assert.ok(readFileSync(join(secretsDirectory, "workflow-dispatch-public"), "utf8") === snapshot.get("workflow-dispatch-public"), "A surviving public key must not rotate.");
  } finally {
    const target = realpathSync(workspace);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith("ai-sop-s03-secrets-"));
    for (const name of readdirSync(secretsDirectory)) chmodSync(join(secretsDirectory, name), 0o600);
    rmSync(target, { recursive: true, force: true });
  }
});
