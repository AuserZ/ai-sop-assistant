import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  computeSha256,
  createBackupManifest,
  encryptBackupPayload,
  keyFingerprint,
  parseBackupKey,
} from "./crypto.mjs";
import { createBackupStorageClient, loadBackupStorageConfig } from "./storage.mjs";

export const BACKUP_DATABASES = Object.freeze(["sop_app", "sop_n8n"]);

export const BACKUP_ALERT_CODES = Object.freeze({
  CONFIG_INVALID: "BACKUP_CONFIG_INVALID",
  DUMP_FAILED: "BACKUP_DUMP_FAILED",
  ENCRYPTION_FAILED: "BACKUP_ENCRYPTION_FAILED",
  UPLOAD_FAILED: "BACKUP_UPLOAD_FAILED",
  VERIFY_FAILED: "BACKUP_VERIFY_FAILED",
});

const ALERT_TIMEOUT_MS = 10_000;
const DEFAULT_DUMP_TIMEOUT_MS = 300_000;
const MAX_ALERT_MESSAGE_LENGTH = 240;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const HEX_64_PATTERN = /^[a-f0-9]{64}$/i;
const VALID_ALERT_CODES = new Set(Object.values(BACKUP_ALERT_CODES));

function isPrivateOrLocalHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "::" ||
    normalized === "0.0.0.0"
  ) {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  if (normalized.includes(":")) {
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("::ffff:")
    ) {
      return true;
    }
  }

  return false;
}

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function defaultReadSecretFile(filePath) {
  return readFileSync(filePath, "utf8").trim();
}

export function sanitizeAlertMessage(rawMessage, sensitiveValues = []) {
  let text = String(rawMessage ?? "Backup operation failed.")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const secret of sensitiveValues) {
    if (typeof secret === "string" && secret.trim().length >= 4) {
      text = text.split(secret.trim()).join("[REDACTED]");
    }
  }

  text = text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_KEY]")
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "[REDACTED_DB_URL]")
    .replace(/X-Amz-Signature=[A-Za-z0-9%._-]+/gi, "X-Amz-Signature=[REDACTED]")
    .replace(/\b(?:sk-(?:proj|live)-[A-Za-z0-9_-]{8,}|re_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:PGPASSWORD|PASSWORD|SECRET|PASSPHRASE|TOKEN)\s*=\s*[^\s;,]+/gi, (match) => `${match.split("=")[0]}=[REDACTED]`)
    .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED_HEX64]")
    .replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COPY)\b[\s\S]*/i, "[REDACTED_SQL]");

  if (text.length > MAX_ALERT_MESSAGE_LENGTH) {
    text = `${text.slice(0, MAX_ALERT_MESSAGE_LENGTH - 3)}...`;
  }
  return text || "Backup operation failed.";
}

export function validateAlertWebhookUrl(rawUrl, env) {
  const resolvedEnv = env ?? process.env;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("BACKUP_ALERT_WEBHOOK_URL must be a valid URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("BACKUP_ALERT_WEBHOOK_URL must not embed credentials.");
  }

  const fixtureEnabled = resolvedEnv?.SOP_LOCAL_STORAGE_FIXTURE_ENABLED === "1";

  if (parsed.protocol === "https:") {
    if (!fixtureEnabled && isPrivateOrLocalHostname(parsed.hostname)) {
      throw new Error("BACKUP_ALERT_WEBHOOK_URL must not target loopback, link-local, or private network addresses.");
    }
    return parsed.toString();
  }

  if (parsed.protocol === "http:" && fixtureEnabled && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return parsed.toString();
  }

  throw new Error(
    "BACKUP_ALERT_WEBHOOK_URL must use https:// (loopback http:// is permitted only when SOP_LOCAL_STORAGE_FIXTURE_ENABLED=1).",
  );
}

export function buildBackupAlert(options = {}) {
  const {
    code,
    stage,
    database = null,
    message,
    backupId = null,
    timestamp = new Date().toISOString(),
    sensitiveValues = [],
  } = options;
  if (!VALID_ALERT_CODES.has(code)) {
    throw new Error(`Unknown backup alert code: ${String(code)}.`);
  }

  const alert = {
    severity: "critical",
    code,
    stage: String(stage || "unknown"),
    message: sanitizeAlertMessage(message, sensitiveValues),
    timestamp,
  };

  if (database) {
    alert.database = String(database);
  }
  if (backupId) {
    alert.backupId = String(backupId);
  }
  return alert;
}

export async function dispatchBackupAlert(alert, options = {}) {
  const {
    webhookUrl = "",
    env = process.env,
    fetchImpl = fetch,
    log = console.error,
  } = options;
  log(JSON.stringify(alert));

  const trimmedUrl = typeof webhookUrl === "string" ? webhookUrl.trim() : "";
  if (!trimmedUrl) {
    return { logged: true, webhookSent: false };
  }

  let validatedUrl;
  try {
    validatedUrl = validateAlertWebhookUrl(trimmedUrl, env);
  } catch (error) {
    return { logged: true, webhookSent: false, error: sanitizeAlertMessage(error?.message) };
  }

  try {
    const response = await fetchImpl(validatedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(alert),
      redirect: "error",
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    return {
      logged: true,
      webhookSent: response.ok,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      logged: true,
      webhookSent: false,
      error: sanitizeAlertMessage(error?.message ?? "Alert webhook delivery failed."),
    };
  }
}

export function readMigrationHead(rootDir = process.cwd()) {
  const journalPath = join(rootDir, "drizzle", "meta", "_journal.json");
  if (!existsSync(journalPath)) {
    return "unknown";
  }
  try {
    const parsed = JSON.parse(readFileSync(journalPath, "utf8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const lastEntry = entries.at(-1);
    return typeof lastEntry?.tag === "string" && lastEntry.tag.trim() ? lastEntry.tag.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

export function readWorkflowVersions(rootDir = process.cwd()) {
  const workflowDir = join(rootDir, "n8n");
  if (!existsSync(workflowDir)) {
    return {};
  }
  const versions = {};
  const files = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of files) {
    const content = readFileSync(join(workflowDir, name));
    versions[name] = computeSha256(content);
  }
  return versions;
}

export function buildPgDumpArgs({ host, port, user, database }) {
  // Preserve object ownership and least-privilege GRANT/REVOKE statements across restore.
  return [
    "--format=custom",
    "--lock-wait-timeout=30000",
    "--host",
    String(host),
    "--port",
    String(port),
    "--username",
    String(user),
    String(database),
  ];
}

export function defaultDumpDatabase({
  database,
  host,
  port,
  user,
  password,
  pgDumpBin = "pg_dump",
  timeoutMs = DEFAULT_DUMP_TIMEOUT_MS,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = buildPgDumpArgs({ host, port, user, database });
    const child = spawn(pgDumpBin, args, {
      env: {
        ...process.env,
        PGPASSWORD: password,
        PGCONNECT_TIMEOUT: "15",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`pg_dump execution error for ${database}: ${error.code ?? "SPAWN_FAILED"}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(`pg_dump timed out for ${database} after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString("utf8").trim();
        rejectPromise(new Error(`pg_dump exited with code ${code} for ${database}: ${stderrText}`));
        return;
      }
      const dumpBytes = Buffer.concat(stdoutChunks);
      if (dumpBytes.byteLength === 0) {
        rejectPromise(new Error(`pg_dump produced an empty archive for ${database}.`));
        return;
      }
      resolvePromise(dumpBytes);
    });
  });
}

function generateBackupId(nowDate) {
  const stamp = nowDate.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = randomUUID().slice(0, 8);
  return `backup-${stamp}-${suffix}`;
}

export async function runBackupJob(options = {}) {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? process.cwd();
  const readSecret = options.readSecretFile ?? defaultReadSecretFile;
  const nowDate = typeof options.now === "function" ? options.now() : new Date();
  const createdAt = nowDate.toISOString();
  const backupId = options.backupId ?? generateBackupId(nowDate);
  const webhookUrl = options.alertWebhookUrl ?? env.BACKUP_ALERT_WEBHOOK_URL ?? "";
  const alertDispatcher = options.dispatchAlert ?? dispatchBackupAlert;
  const dumpFn = options.dumpDatabase ?? defaultDumpDatabase;
  const encryptFn = options.encryptPayload ?? encryptBackupPayload;
  const localOutputDir = options.localOutputDir ?? null;
  const sensitiveValues = [];
  const totalStart = performance.now();

  async function failWithAlert(code, stage, message, database = null) {
    const alert = buildBackupAlert({
      code,
      stage,
      database,
      backupId,
      message,
      timestamp: new Date().toISOString(),
      sensitiveValues,
    });
    await alertDispatcher(alert, {
      webhookUrl,
      env,
      fetchImpl: options.fetchImpl ?? fetch,
      log: options.alertLog ?? console.error,
    });
    const error = new Error(alert.message);
    error.code = code;
    error.alert = alert;
    throw error;
  }

  let backupKeyRaw;
  let backupKeyFp;
  let n8nKeyFp;
  let dbHost;
  let dbPort;
  let dbUser;
  let dbPassword;
  let storage;

  try {
    const backupKeyFile = (env.BACKUP_ENCRYPTION_KEY_FILE ?? "").trim();
    backupKeyRaw = options.backupKey ?? (backupKeyFile ? readSecret(backupKeyFile) : "");
    if (backupKeyRaw) sensitiveValues.push(backupKeyRaw);
    const parsedBackupKey = parseBackupKey(backupKeyRaw);
    backupKeyFp = keyFingerprint(parsedBackupKey.toString("hex"));

    const n8nFingerprintDirect =
      options.n8nKeyFingerprint ??
      (env.N8N_ENCRYPTION_KEY_FINGERPRINT ?? "").trim() ??
      "";
    const n8nFingerprintFile = (env.N8N_ENCRYPTION_KEY_FINGERPRINT_FILE ?? "").trim();
    const resolvedFingerprint = n8nFingerprintDirect || (n8nFingerprintFile ? readSecret(n8nFingerprintFile) : "");

    if (resolvedFingerprint) {
      if (!HEX_64_PATTERN.test(resolvedFingerprint.trim())) {
        throw new Error("N8N_ENCRYPTION_KEY_FINGERPRINT must be a valid 64-character SHA-256 hex digest.");
      }
      n8nKeyFp = resolvedFingerprint.trim().toLowerCase();
    } else {
      const n8nKeyFile = (env.N8N_ENCRYPTION_KEY_FILE ?? "").trim();
      const n8nKeyRaw = options.n8nEncryptionKey ?? (n8nKeyFile ? readSecret(n8nKeyFile) : "");
      if (typeof n8nKeyRaw !== "string" || n8nKeyRaw.trim().length < 16) {
        throw new Error(
          "N8N_ENCRYPTION_KEY_FINGERPRINT_FILE (or N8N_ENCRYPTION_KEY_FILE) must be configured.",
        );
      }
      sensitiveValues.push(n8nKeyRaw.trim());
      n8nKeyFp = keyFingerprint(n8nKeyRaw.trim());
    }

    dbHost = (options.dbHost ?? env.DB_HOST ?? "postgres").trim();
    dbPort = Number.parseInt(String(options.dbPort ?? env.DB_PORT ?? "5432"), 10);
    dbUser = (options.dbUser ?? env.DB_ADMIN_USER ?? "sop_bootstrap").trim();
    const dbPasswordFile = (env.POSTGRES_PASSWORD_FILE ?? "").trim();
    dbPassword = options.dbPassword ?? (dbPasswordFile ? readSecret(dbPasswordFile) : "");
    if (dbPassword) sensitiveValues.push(dbPassword);

    if (!dbHost || !Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535 || !dbUser || !dbPassword) {
      throw new Error("Database connection settings and POSTGRES_PASSWORD_FILE are required.");
    }

    if (webhookUrl) {
      validateAlertWebhookUrl(webhookUrl, env);
    }

    if (options.storageClient) {
      storage = options.storageClient;
    } else if (!localOutputDir) {
      const storageConfig = loadBackupStorageConfig(env, { readSecret });
      sensitiveValues.push(
        storageConfig.credentials.accessKeyId,
        storageConfig.credentials.secretAccessKey,
      );
      storage = createBackupStorageClient(storageConfig);
    }
  } catch (error) {
    await failWithAlert(
      BACKUP_ALERT_CODES.CONFIG_INVALID,
      "config",
      error?.message ?? "Backup configuration validation failed.",
    );
  }

  const encryptedByDb = {};
  const dumpTimingsMs = {};
  let encryptDurationMs = 0;

  for (const database of BACKUP_DATABASES) {
    const dumpStart = performance.now();
    let dumpBytes;
    try {
      dumpBytes = await dumpFn({
        database,
        host: dbHost,
        port: dbPort,
        user: dbUser,
        password: dbPassword,
        args: buildPgDumpArgs({ host: dbHost, port: dbPort, user: dbUser, database }),
      });
      if (!Buffer.isBuffer(dumpBytes) || dumpBytes.byteLength === 0) {
        throw new Error(`Dump produced empty output for ${database}.`);
      }
    } catch (error) {
      await failWithAlert(
        BACKUP_ALERT_CODES.DUMP_FAILED,
        "dump",
        error?.message ?? `Logical dump failed for ${database}.`,
        database,
      );
    }
    dumpTimingsMs[database] = roundMs(performance.now() - dumpStart);

    const encStart = performance.now();
    try {
      encryptedByDb[database] = encryptFn(dumpBytes, {
        key: backupKeyRaw,
        database,
        backupId,
      });
    } catch (error) {
      await failWithAlert(
        BACKUP_ALERT_CODES.ENCRYPTION_FAILED,
        "encrypt",
        error?.message ?? `Encryption failed for ${database}.`,
        database,
      );
    }
    encryptDurationMs += performance.now() - encStart;
  }

  const migrationHead = options.migrationHead ?? readMigrationHead(rootDir);
  const workflowVersions = options.workflowVersions ?? readWorkflowVersions(rootDir);

  const objectKeyFor = (relativeName) =>
    storage ? storage.buildObjectKey(`${backupId}/${relativeName}`) : `${backupId}/${relativeName}`;

  let manifest;
  try {
    manifest = createBackupManifest({
      backupId,
      createdAt,
      migrationHead,
      workflowVersions,
      n8nKeyFingerprint: n8nKeyFp,
      backupKeyFingerprint: backupKeyFp,
      storage: {
        bucket: storage?.bucket ?? "local-only",
        prefix: storage?.prefix ?? "local",
        region: storage?.region ?? "local",
      },
      artifacts: {
        sop_app: {
          formatVersion: encryptedByDb.sop_app.formatVersion,
          objectKey: objectKeyFor("sop_app.dump.enc"),
          plaintextSha256: encryptedByDb.sop_app.plaintextSha256,
          plaintextBytes: encryptedByDb.sop_app.plaintextBytes,
          ciphertextSha256: encryptedByDb.sop_app.ciphertextSha256,
          ciphertextBytes: encryptedByDb.sop_app.ciphertextBytes,
        },
        sop_n8n: {
          formatVersion: encryptedByDb.sop_n8n.formatVersion,
          objectKey: objectKeyFor("sop_n8n.dump.enc"),
          plaintextSha256: encryptedByDb.sop_n8n.plaintextSha256,
          plaintextBytes: encryptedByDb.sop_n8n.plaintextBytes,
          ciphertextSha256: encryptedByDb.sop_n8n.ciphertextSha256,
          ciphertextBytes: encryptedByDb.sop_n8n.ciphertextBytes,
        },
      },
    });
  } catch (error) {
    await failWithAlert(
      BACKUP_ALERT_CODES.ENCRYPTION_FAILED,
      "manifest",
      error?.message ?? "Failed to construct backup manifest.",
    );
  }

  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestKey = objectKeyFor("manifest.json");
  const uploadStart = performance.now();

  if (localOutputDir) {
    try {
      const targetDir = join(resolve(localOutputDir), backupId);
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(targetDir, "sop_app.dump.enc"), encryptedByDb.sop_app.envelope, { mode: 0o600 });
      writeFileSync(join(targetDir, "sop_n8n.dump.enc"), encryptedByDb.sop_n8n.envelope, { mode: 0o600 });
      writeFileSync(join(targetDir, "manifest.json"), manifestBuffer, { mode: 0o600 });
    } catch (error) {
      await failWithAlert(
        BACKUP_ALERT_CODES.UPLOAD_FAILED,
        "local_write",
        error?.message ?? "Failed to write local backup artifacts.",
      );
    }
  }

  if (storage) {
    const uploadQueue = [
      {
        database: "sop_app",
        key: manifest.artifacts.sop_app.objectKey,
        body: encryptedByDb.sop_app.envelope,
        contentType: "application/octet-stream",
        metadata: {
          "backup-id": backupId,
          database: "sop_app",
          "ciphertext-sha256": encryptedByDb.sop_app.ciphertextSha256,
        },
      },
      {
        database: "sop_n8n",
        key: manifest.artifacts.sop_n8n.objectKey,
        body: encryptedByDb.sop_n8n.envelope,
        contentType: "application/octet-stream",
        metadata: {
          "backup-id": backupId,
          database: "sop_n8n",
          "ciphertext-sha256": encryptedByDb.sop_n8n.ciphertextSha256,
        },
      },
      {
        database: null,
        key: manifestKey,
        body: manifestBuffer,
        contentType: "application/json",
        metadata: {
          "backup-id": backupId,
          "manifest-sha256": computeSha256(manifestBuffer),
        },
      },
    ];

    for (const item of uploadQueue) {
      try {
        await storage.putVerifiedObject({
          key: item.key,
          body: item.body,
          contentType: item.contentType,
          metadata: item.metadata,
        });
      } catch (error) {
        const isVerifyFailure = error?.code === BACKUP_ALERT_CODES.VERIFY_FAILED;
        await failWithAlert(
          isVerifyFailure ? BACKUP_ALERT_CODES.VERIFY_FAILED : BACKUP_ALERT_CODES.UPLOAD_FAILED,
          isVerifyFailure ? "verify" : "upload",
          error?.message ?? `Backup ${isVerifyFailure ? "verification" : "upload"} failed.`,
          item.database,
        );
      }
    }
  }

  const uploadVerifyMs = roundMs(performance.now() - uploadStart);
  const totalMs = roundMs(performance.now() - totalStart);

  return {
    ok: true,
    backupId,
    createdAt,
    migrationHead,
    workflowVersions,
    n8nKeyFingerprint: n8nKeyFp,
    backupKeyFingerprint: backupKeyFp,
    manifestKey,
    artifacts: manifest.artifacts,
    timingsMs: {
      dumpAppMs: dumpTimingsMs.sop_app,
      dumpN8nMs: dumpTimingsMs.sop_n8n,
      encryptMs: roundMs(encryptDurationMs),
      uploadVerifyMs,
      totalMs,
    },
    policyNotice: manifest.policyNotice,
  };
}

function parseCliArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local-dir" && argv[index + 1]) {
      parsed.localOutputDir = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--local-dir=")) {
      parsed.localOutputDir = arg.slice("--local-dir=".length);
    } else if (arg === "--backup-id" && argv[index + 1]) {
      parsed.backupId = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--backup-id=")) {
      parsed.backupId = arg.slice("--backup-id=".length);
    }
  }
  return parsed;
}

if (isDirectExecution(import.meta.url)) {
  const cli = parseCliArgs(process.argv.slice(2));
  runBackupJob(cli)
    .then((receipt) => {
      console.log(JSON.stringify(receipt, null, 2));
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
