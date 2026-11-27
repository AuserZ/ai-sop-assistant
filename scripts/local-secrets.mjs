import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const directory = new URL("../.local-secrets/", import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });

async function existingFile(name) {
  try {
    return await readFile(new URL(name, directory), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  }
}

async function createSecret(name, value) {
  try {
    await writeFile(new URL(name, directory), value, {
      flag: "wx",
      mode: 0o444,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

const coreHexSecrets = [
  "postgres-admin",
  "app-runtime",
  "app-migrator",
  "n8n-db",
  "backup-db",
  "auth-secret",
  "n8n-encryption-key",
  "redis-password",
  "n8n-runners-token",
];

for (const name of coreHexSecrets) {
  await createSecret(name, randomBytes(32).toString("hex"));
}

const includeBackupSecrets =
  process.argv.includes("--with-backup") || process.env.SOP_INCLUDE_BACKUP_SECRETS === "1";

if (includeBackupSecrets) {
  await createSecret("backup-encryption-key", randomBytes(32).toString("hex"));
  await createSecret("backup-escrow-passphrase", randomBytes(32).toString("hex"));
  await createSecret("backup-s3-access-key-id", `s15-local-backup-access-${randomBytes(16).toString("hex")}`);
  await createSecret("backup-s3-secret-access-key", `s15-local-backup-secret-${randomBytes(32).toString("hex")}`);

  const n8nKey = (await existingFile("n8n-encryption-key"))?.trim() ?? "";
  if (!n8nKey) {
    throw new Error("Missing n8n-encryption-key; cannot derive n8n-encryption-key-fingerprint.");
  }
  const derivedFingerprint = createHash("sha256").update(n8nKey, "utf8").digest("hex");
  await createSecret("n8n-encryption-key-fingerprint", derivedFingerprint);
  const storedFingerprint = (await existingFile("n8n-encryption-key-fingerprint"))?.trim() ?? "";
  if (storedFingerprint !== derivedFingerprint) {
    throw new Error("Existing n8n-encryption-key-fingerprint does not match n8n-encryption-key; restore consistent key files.");
  }
}

for (const direction of ["dispatch", "callback"]) {
  const privateName = `workflow-${direction}-private`;
  const publicName = `workflow-${direction}-public`;
  const privateValue = await existingFile(privateName);
  const publicValue = await existingFile(publicName);
  if (!privateValue && publicValue) throw new Error(`Restore the missing private key for ${direction}; existing keys are never rotated.`);
  if (!privateValue) {
    const generated = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await createSecret(privateName, generated.privateKey);
  }
  const privateKey = createPrivateKey(await existingFile(privateName));
  if (privateKey.asymmetricKeyType !== "rsa" || privateKey.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error(`The existing ${direction} key must be an RSA key of at least 2048 bits.`);
  }
  const derivedPublic = createPublicKey(privateKey);
  await createSecret(publicName, derivedPublic.export({ type: "spki", format: "pem" }));
  const storedPublic = createPublicKey(await existingFile(publicName));
  if (!derivedPublic.export({ type: "spki", format: "der" }).equals(storedPublic.export({ type: "spki", format: "der" }))) {
    throw new Error(`The existing ${direction} key pair does not match; restore its original files.`);
  }
}

console.log("Local Compose secret files are ready.");
