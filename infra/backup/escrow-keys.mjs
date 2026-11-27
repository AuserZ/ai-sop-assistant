import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  decryptKeyEscrowBundle,
  encryptKeyEscrowBundle,
  keyFingerprint,
  parseBackupKey,
} from "./crypto.mjs";
import { readMigrationHead, readWorkflowVersions, sanitizeAlertMessage } from "./run-backup.mjs";

export const DEFAULT_SECRET_BINDINGS = Object.freeze([
  "postgres-admin",
  "app-runtime",
  "app-migrator",
  "n8n-db",
  "auth-secret",
  "n8n-encryption-key",
  "redis-password",
  "n8n-runners-token",
  "workflow-dispatch-private",
  "workflow-dispatch-public",
  "workflow-callback-private",
  "workflow-callback-public",
  "backup-encryption-key",
  "backup-s3-access-key-id",
  "backup-s3-secret-access-key",
]);

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

function readTrimmedFile(filePath, label) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error(`${label} path is required.`);
  }
  const value = readFileSync(filePath, "utf8").trim();
  if (!value) {
    throw new Error(`${label} file is empty.`);
  }
  return value;
}

export function createEscrowReceipt(options = {}) {
  const {
    n8nEncryptionKey,
    passphrase,
    backupKey = null,
    storageBucket = "",
    storagePrefix = "",
    secretBindings = DEFAULT_SECRET_BINDINGS,
    rootDir = process.cwd(),
    outputFile = null,
    createdAt = new Date().toISOString(),
  } = options;

  let backupKeyFp = null;
  if (backupKey) {
    const parsed = parseBackupKey(backupKey);
    backupKeyFp = keyFingerprint(parsed.toString("hex"));
  }

  const metadata = {
    migrationHead: readMigrationHead(rootDir),
    workflowVersions: readWorkflowVersions(rootDir),
    storageBucket,
    storagePrefix,
    backupKeyFingerprint: backupKeyFp,
    secretBindings: [...secretBindings],
  };

  const bundle = encryptKeyEscrowBundle({
    n8nEncryptionKey,
    passphrase,
    metadata,
    createdAt,
  });

  if (outputFile) {
    const resolvedOutput = resolve(outputFile);
    mkdirSync(dirname(resolvedOutput), { recursive: true, mode: 0o700 });
    writeFileSync(resolvedOutput, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  }

  return {
    ok: true,
    mode: "create",
    formatVersion: bundle.formatVersion,
    createdAt: bundle.createdAt,
    n8nKeyFingerprint: bundle.n8nKeyFingerprint,
    backupKeyFingerprint: bundle.metadata.backupKeyFingerprint,
    migrationHead: bundle.metadata.migrationHead,
    workflowCount: Object.keys(bundle.metadata.workflowVersions).length,
    secretBindingsCount: bundle.metadata.secretBindings.length,
    outputFile: outputFile ? resolve(outputFile) : null,
    bundle,
  };
}

export function verifyEscrowReceipt(options = {}) {
  const {
    bundle,
    passphrase,
    expectedN8nKey = null,
    expectedN8nKeyFingerprint = undefined,
  } = options;

  const expectedFp =
    expectedN8nKey !== null && expectedN8nKey !== undefined
      ? keyFingerprint(expectedN8nKey)
      : expectedN8nKeyFingerprint;

  const decrypted = decryptKeyEscrowBundle(bundle, {
    passphrase,
    expectedN8nKeyFingerprint: expectedFp,
  });

  let keyMatchesExpected = expectedN8nKey === null && expectedN8nKeyFingerprint === undefined ? null : true;
  if (expectedN8nKey !== null && expectedN8nKey !== undefined) {
    const actualBuf = Buffer.from(decrypted.n8nEncryptionKey, "utf8");
    const expectedBuf = Buffer.from(String(expectedN8nKey).trim(), "utf8");
    if (actualBuf.byteLength !== expectedBuf.byteLength || !timingSafeEqual(actualBuf, expectedBuf)) {
      throw new Error("Escrowed N8N_ENCRYPTION_KEY does not match expected key.");
    }
    keyMatchesExpected = true;
  }

  return {
    ok: true,
    mode: "verify",
    n8nKeyFingerprint: decrypted.n8nKeyFingerprint,
    backupKeyFingerprint: decrypted.metadata.backupKeyFingerprint,
    migrationHead: decrypted.metadata.migrationHead,
    workflowVersions: decrypted.metadata.workflowVersions,
    secretBindings: decrypted.metadata.secretBindings,
    storageBucket: decrypted.metadata.storageBucket,
    storagePrefix: decrypted.metadata.storagePrefix,
    keyMatchesExpected,
    createdAt: decrypted.createdAt,
  };
}

export function recoverEscrowKeyToFile(options = {}) {
  const {
    bundle,
    passphrase,
    outputKeyFile,
    expectedN8nKeyFingerprint = undefined,
    force = false,
  } = options;

  if (typeof outputKeyFile !== "string" || !outputKeyFile.trim()) {
    throw new Error("--recover requires --output-key-file <dest>.");
  }

  const decrypted = decryptKeyEscrowBundle(bundle, {
    passphrase,
    expectedN8nKeyFingerprint,
  });

  const resolvedOutput = resolve(outputKeyFile);
  mkdirSync(dirname(resolvedOutput), { recursive: true, mode: 0o700 });
  writeFileSync(resolvedOutput, decrypted.n8nEncryptionKey, {
    flag: force ? "w" : "wx",
    mode: 0o600,
  });

  return {
    ok: true,
    mode: "recover",
    outputKeyFile: resolvedOutput,
    n8nKeyFingerprint: decrypted.n8nKeyFingerprint,
    migrationHead: decrypted.metadata.migrationHead,
    createdAt: decrypted.createdAt,
  };
}

export function parseEscrowCliArgs(argv, env) {
  const resolvedEnv = env ?? process.env;
  const options = {
    mode: null,
    n8nKeyFile: "",
    passphraseFile: resolvedEnv.BACKUP_ESCROW_PASSPHRASE_FILE ?? ".local-secrets/backup-escrow-passphrase",
    backupKeyFile: resolvedEnv.BACKUP_ENCRYPTION_KEY_FILE ?? "",
    outputFile: "",
    outputKeyFile: "",
    inputFile: "",
    storageBucket: resolvedEnv.BACKUP_S3_BUCKET ?? "",
    storagePrefix: resolvedEnv.BACKUP_S3_PREFIX ?? "backups/postgres",
    expectedFingerprint: undefined,
    force: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--create") options.mode = "create";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--recover") options.mode = "recover";
    else if (arg === "--force") options.force = true;
    else if (arg === "--n8n-key-file" && next) {
      options.n8nKeyFile = next;
      index += 1;
    } else if (arg === "--passphrase-file" && next) {
      options.passphraseFile = next;
      index += 1;
    } else if (arg === "--backup-key-file" && next) {
      options.backupKeyFile = next;
      index += 1;
    } else if (arg === "--output" && next) {
      options.outputFile = next;
      index += 1;
    } else if (arg === "--output-key-file" && next) {
      options.outputKeyFile = next;
      index += 1;
    } else if (arg === "--input" && next) {
      options.inputFile = next;
      index += 1;
    } else if (arg === "--bucket" && next) {
      options.storageBucket = next;
      index += 1;
    } else if (arg === "--prefix" && next) {
      options.storagePrefix = next;
      index += 1;
    } else if (arg === "--expected-fingerprint" && next) {
      options.expectedFingerprint = next;
      index += 1;
    }
  }
  return options;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const cli = parseEscrowCliArgs(process.argv.slice(2));
    if (cli.mode === "create") {
      if (!cli.outputFile) {
        throw new Error("--create requires --output <path>.");
      }
      const n8nKeyPath = cli.n8nKeyFile || process.env.N8N_ENCRYPTION_KEY_FILE || ".local-secrets/n8n-encryption-key";
      const n8nEncryptionKey = readTrimmedFile(n8nKeyPath, "N8N_ENCRYPTION_KEY");
      const passphrase = readTrimmedFile(cli.passphraseFile, "Escrow passphrase");
      const backupKey = cli.backupKeyFile ? readTrimmedFile(cli.backupKeyFile, "Backup encryption key") : null;
      const result = createEscrowReceipt({
        n8nEncryptionKey,
        passphrase,
        backupKey,
        storageBucket: cli.storageBucket,
        storagePrefix: cli.storagePrefix,
        outputFile: cli.outputFile,
      });
      const { bundle: _omittedBundle, ...redactedReceipt } = result;
      void _omittedBundle;
      console.log(JSON.stringify(redactedReceipt, null, 2));
    } else if (cli.mode === "verify") {
      if (!cli.inputFile) {
        throw new Error("--verify requires --input <path>.");
      }
      const bundle = JSON.parse(readFileSync(cli.inputFile, "utf8"));
      const passphrase = readTrimmedFile(cli.passphraseFile, "Escrow passphrase");
      const expectedN8nKey = cli.n8nKeyFile ? readTrimmedFile(cli.n8nKeyFile, "N8N_ENCRYPTION_KEY") : null;
      const receipt = verifyEscrowReceipt({
        bundle,
        passphrase,
        expectedN8nKey,
        expectedN8nKeyFingerprint: cli.expectedFingerprint,
      });
      console.log(JSON.stringify(receipt, null, 2));
    } else if (cli.mode === "recover") {
      if (!cli.inputFile) {
        throw new Error("--recover requires --input <path>.");
      }
      if (!cli.outputKeyFile) {
        throw new Error("--recover requires --output-key-file <dest>.");
      }
      const bundle = JSON.parse(readFileSync(cli.inputFile, "utf8"));
      const passphrase = readTrimmedFile(cli.passphraseFile, "Escrow passphrase");
      const receipt = recoverEscrowKeyToFile({
        bundle,
        passphrase,
        outputKeyFile: cli.outputKeyFile,
        expectedN8nKeyFingerprint: cli.expectedFingerprint,
        force: cli.force,
      });
      console.log(JSON.stringify(receipt, null, 2));
    } else {
      throw new Error("Specify --create, --verify, or --recover.");
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        error: sanitizeAlertMessage(error?.message ?? "Key escrow command failed."),
      }),
    );
    process.exitCode = 1;
  }
}
