import { createPrivateKey, createPublicKey } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";

const temporaryFile = "/tmp/sop-import/credentials.json";
const managedWorkflows = [
  { id: "sop-s03-probe-v1", path: "/opt/sop/workflows/s03-probe.v1.json" },
  { id: "sop-s05-ingestion-v1", path: "/opt/sop/workflows/s05-ingestion.v1.json" },
];
const dispatchPublic = createPublicKey(await readFile("/run/secrets/workflow-dispatch-public", "utf8"));
const callbackPrivate = createPrivateKey(await readFile("/run/secrets/workflow-callback-private", "utf8"));
for (const key of [dispatchPublic, callbackPrivate]) {
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) {
    throw new Error("Workflow credentials require RSA keys of at least 2048 bits.");
  }
}

function runCommand(arguments_) {
  const result = spawnSync("n8n", arguments_, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    process.stderr.write(`n8n ${arguments_[0]} failed; credential values and command output were withheld.\n`);
    process.exitCode = 1;
    return false;
  }
  process.stdout.write(`n8n ${arguments_[0]} passed.\n`);
  return true;
}

await mkdir("/tmp/sop-import", { mode: 0o700, recursive: true });
try {
  await writeFile(temporaryFile, JSON.stringify([
    {
      id: "sop-s03-dispatch-v1", name: "S03 dispatch verification", type: "jwtAuth",
      data: { keyType: "pemKey", algorithm: "RS256", publicKey: dispatchPublic.export({ type: "spki", format: "pem" }) },
    },
    {
      id: "sop-s03-callback-v1", name: "S03 callback signing", type: "jwtAuth",
      data: {
        keyType: "pemKey", algorithm: "RS256",
        privateKey: callbackPrivate.export({ type: "pkcs8", format: "pem" }),
        publicKey: createPublicKey(callbackPrivate).export({ type: "spki", format: "pem" }),
      },
    },
  ]), { flag: "wx", mode: 0o600 });
  if (runCommand(["import:credentials", `--input=${temporaryFile}`]) && !process.argv.includes("--credentials-only")) {
    for (const { id, path } of managedWorkflows) {
      const workflow = JSON.parse(await readFile(path, "utf8"));
      if (workflow.id !== id) throw new Error(`Unexpected workflow identity for ${id}.`);
      if (!runCommand(["import:workflow", `--input=${path}`])) break;
      if (!runCommand(["publish:workflow", `--id=${id}`])) break;
    }
  }
} finally {
  await unlink(temporaryFile).catch(error => { if (error.code !== "ENOENT") throw error; });
}
