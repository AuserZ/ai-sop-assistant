import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
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

for (const name of ["postgres-admin", "app-runtime", "app-migrator", "n8n-db", "auth-secret", "n8n-encryption-key", "redis-password", "n8n-runners-token"]) {
  await createSecret(name, randomBytes(32).toString("hex"));
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
