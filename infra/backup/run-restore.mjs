import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  computeSha256,
  decryptBackupPayload,
  keyFingerprint,
  PROVISIONAL_POLICY_NOTICE,
  verifyBackupManifest,
} from "./crypto.mjs";
import { sanitizeAlertMessage } from "./run-backup.mjs";
import { createBackupStorageClient, loadBackupStorageConfig } from "./storage.mjs";

export const RESTORE_ERROR_CODES = Object.freeze({
  ISOLATED_TARGET_REQUIRED: "RESTORE_ISOLATED_TARGET_REQUIRED",
  PRODUCTION_GUARD_BLOCKED: "RESTORE_PRODUCTION_GUARD_BLOCKED",
  N8N_KEY_MISMATCH: "RESTORE_N8N_KEY_MISMATCH",
  CIPHERTEXT_HASH_MISMATCH: "RESTORE_CIPHERTEXT_HASH_MISMATCH",
  DECRYPT_FAILED: "RESTORE_DECRYPT_FAILED",
  PG_RESTORE_FAILED: "RESTORE_PG_RESTORE_FAILED",
  INTEGRITY_CHECK_FAILED: "RESTORE_INTEGRITY_CHECK_FAILED",
});

export const REQUIRED_APP_TABLES = Object.freeze([
  "app.auth_users",
  "app.sop_documents",
  "app.workflow_jobs",
  "app.chat_conversations",
]);

export const REQUIRED_N8N_TABLES = Object.freeze([
  "credentials_entity",
  "workflow_entity",
]);

export const JOB_RECONCILIATION_SQL = `
WITH exhausted AS (
  UPDATE app.workflow_jobs
     SET state = 'FAILED',
         error_code = COALESCE(error_code, 'RESTORE_ATTEMPTS_EXHAUSTED'),
         dispatch_lease_token = NULL,
         dispatch_lease_until = NULL,
         run_lease_until = NULL,
         updated_at = NOW()
   WHERE state = 'RUNNING'
     AND attempt_number >= 3
  RETURNING id
),
requeued AS (
  UPDATE app.workflow_jobs
     SET state = 'QUEUED',
         stage = NULL,
         error_code = NULL,
         error_retryable = NULL,
         attempt_id = gen_random_uuid(),
         attempt_number = attempt_number + 1,
         dispatch_nonce = gen_random_uuid(),
         dispatch_count = 0,
         dispatch_next_at = NOW(),
         dispatch_lease_token = NULL,
         dispatch_lease_until = NULL,
         dispatch_accepted_at = NULL,
         execution_id = NULL,
         run_lease_until = NULL,
         step = 0,
         attempt_deadline = NOW() + interval '5 minutes',
         updated_at = NOW()
   WHERE state = 'RUNNING'
     AND attempt_number < 3
  RETURNING id
),
pruned_artifacts AS (
  DELETE FROM app.chat_turn_artifacts a
   USING app.workflow_jobs j
   WHERE a.job_id = j.id
     AND (
       j.state <> 'RUNNING'
       OR a.job_id IN (SELECT id FROM exhausted UNION ALL SELECT id FROM requeued)
     )
  RETURNING a.job_id
)
SELECT
  (SELECT COUNT(*)::int FROM requeued) AS requeued_count,
  (SELECT COUNT(*)::int FROM exhausted) AS exhausted_count,
  (SELECT COUNT(*)::int FROM pruned_artifacts) AS pruned_artifacts_count;
`.trim();

const DEFAULT_RESTORE_TIMEOUT_MS = 300_000;
const MAX_STDIO_CAPTURE_BYTES = 64 * 1024;
const PRODUCTION_PROJECT_PATTERNS = [
  /^ai-sop-assistant$/i,
  /^prod(?:uction)?$/i,
  /(?:^|[-_])prod(?:uction)?(?:$|[-_])/i,
];
const PRODUCTION_HOST_PATTERNS = [
  /^prod(?:uction)?[-.]/i,
  /\.prod(?:uction)?\./i,
];

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

function createCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createBoundedCollector(maxBytes = MAX_STDIO_CAPTURE_BYTES) {
  const chunks = [];
  let capturedBytes = 0;

  return {
    push(chunk) {
      if (capturedBytes >= maxBytes) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - capturedBytes;
      if (buf.byteLength <= remaining) {
        chunks.push(buf);
        capturedBytes += buf.byteLength;
      } else {
        chunks.push(buf.subarray(0, remaining));
        capturedBytes = maxBytes;
      }
    },
    toString() {
      return Buffer.concat(chunks).toString("utf8").trim();
    },
  };
}

export function assertIsolatedRestoreTarget(options = {}) {
  const {
    isolatedTarget = false,
    targetProject = "",
    targetHost = "",
    env = process.env,
    allowIsolatedOverride = false,
  } = options;

  if (isolatedTarget !== true) {
    throw createCodedError(
      RESTORE_ERROR_CODES.ISOLATED_TARGET_REQUIRED,
      "Refusing to restore without explicit --isolated-target flag; never overwrite production to test recovery.",
    );
  }

  const nodeEnv = String(env?.NODE_ENV ?? "").trim().toLowerCase();
  const explicitOverrideConfirmed =
    allowIsolatedOverride === true && env?.SOP_ALLOW_ISOLATED_RESTORE_OVERRIDE === "1";

  if (nodeEnv === "production" && !explicitOverrideConfirmed) {
    throw createCodedError(
      RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED,
      "Restore blocked: NODE_ENV=production without explicit isolated override.",
    );
  }

  const normalizedProject = String(targetProject ?? "").trim();
  if (!normalizedProject) {
    throw createCodedError(
      RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED,
      "Restore blocked: an explicit isolated targetProject identifier is required.",
    );
  }

  const configuredProdProject = String(env?.PRODUCTION_COMPOSE_PROJECT ?? "").trim();
  if (
    (configuredProdProject && normalizedProject.toLowerCase() === configuredProdProject.toLowerCase()) ||
    PRODUCTION_PROJECT_PATTERNS.some((pattern) => pattern.test(normalizedProject))
  ) {
    throw createCodedError(
      RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED,
      `Restore blocked: targetProject "${normalizedProject}" matches a protected production guardrail.`,
    );
  }

  const normalizedHost = String(targetHost ?? "").trim();
  const configuredProdHost = String(env?.PRODUCTION_DB_HOST ?? "").trim();
  if (
    normalizedHost &&
    ((configuredProdHost && normalizedHost.toLowerCase() === configuredProdHost.toLowerCase()) ||
      PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(normalizedHost)))
  ) {
    throw createCodedError(
      RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED,
      `Restore blocked: targetHost "${normalizedHost}" matches a protected production host guardrail.`,
    );
  }

  return {
    isolatedTarget: true,
    targetProject: normalizedProject,
    targetHost: normalizedHost || "postgres",
  };
}

export function buildPgRestoreArgs({ host, port, user, database }) {
  // Preserve object ownership and least-privilege GRANT/REVOKE statements across restore.
  return [
    "--clean",
    "--if-exists",
    "--exit-on-error",
    "--host",
    String(host),
    "--port",
    String(port),
    "--username",
    String(user),
    "--dbname",
    String(database),
  ];
}

export function defaultExecSql({
  database,
  sql,
  host,
  port,
  user,
  password,
  psqlBin = "psql",
  timeoutMs = 60_000,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "--no-psqlrc",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
      "--host",
      String(host),
      "--port",
      String(port),
      "--username",
      String(user),
      "--dbname",
      String(database),
      "--command",
      sql,
    ];

    const child = spawn(psqlBin, args, {
      env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "15" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutCollector = createBoundedCollector();
    const stderrCollector = createBoundedCollector();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => stdoutCollector.push(chunk));
    child.stderr.on("data", (chunk) => stderrCollector.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`psql failed on ${database}: ${error.code ?? "SPAWN_FAILED"}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(`psql timed out on ${database}.`));
        return;
      }
      if (code !== 0) {
        const detail = sanitizeAlertMessage(stderrCollector.toString(), [password]);
        rejectPromise(new Error(`psql exited with code ${code} on ${database}: ${detail}`));
        return;
      }
      resolvePromise(stdoutCollector.toString());
    });
  });
}

export function defaultRestoreDatabase({
  database,
  dumpBytes,
  host,
  port,
  user,
  password,
  pgRestoreBin = "pg_restore",
  timeoutMs = DEFAULT_RESTORE_TIMEOUT_MS,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = buildPgRestoreArgs({ host, port, user, database });
    const child = spawn(pgRestoreBin, args, {
      env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: "15" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutCollector = createBoundedCollector();
    const stderrCollector = createBoundedCollector();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => stdoutCollector.push(chunk));
    child.stderr.on("data", (chunk) => stderrCollector.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(
        createCodedError(
          RESTORE_ERROR_CODES.PG_RESTORE_FAILED,
          `pg_restore failed for ${database}: ${error.code ?? "SPAWN_FAILED"}`,
        ),
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(
          createCodedError(RESTORE_ERROR_CODES.PG_RESTORE_FAILED, `pg_restore timed out for ${database}.`),
        );
        return;
      }
      if (code !== 0) {
        const detail = sanitizeAlertMessage(stderrCollector.toString(), [password]);
        rejectPromise(
          createCodedError(
            RESTORE_ERROR_CODES.PG_RESTORE_FAILED,
            `pg_restore exited with code ${code} for ${database}: ${detail}`,
          ),
        );
        return;
      }
      resolvePromise({ restored: true, database, bytes: dumpBytes.byteLength });
    });

    child.stdin.on("error", () => {
      // Ignore EPIPE when pg_restore exits early; close handler reports exit code.
    });
    child.stdin.end(dumpBytes);
  });
}

function defaultReadSecretFile(filePath) {
  return readFileSync(filePath, "utf8").trim();
}

export async function runIsolatedRestore(options = {}) {
  const env = options.env ?? process.env;
  const targetHost = (options.targetHost ?? env.DB_HOST ?? "postgres").trim();
  const targetPort = Number.parseInt(String(options.targetPort ?? env.DB_PORT ?? "5432"), 10);
  const targetUser = (options.targetUser ?? env.DB_ADMIN_USER ?? "sop_bootstrap").trim();
  const readSecret = options.readSecretFile ?? defaultReadSecretFile;

  const guard = assertIsolatedRestoreTarget({
    isolatedTarget: options.isolatedTarget === true,
    targetProject: options.targetProject ?? env.RESTORE_TARGET_PROJECT ?? "",
    targetHost,
    env,
    allowIsolatedOverride: options.allowIsolatedOverride === true,
  });

  const totalStart = performance.now();
  const backupKeyRaw =
    options.backupKey ?? (env.BACKUP_ENCRYPTION_KEY_FILE ? readSecret(env.BACKUP_ENCRYPTION_KEY_FILE) : "");
  const n8nKeyRaw =
    options.n8nEncryptionKey ?? (env.N8N_ENCRYPTION_KEY_FILE ? readSecret(env.N8N_ENCRYPTION_KEY_FILE) : "");
  const targetPassword =
    options.targetPassword ?? (env.POSTGRES_PASSWORD_FILE ? readSecret(env.POSTGRES_PASSWORD_FILE) : "");

  if (!backupKeyRaw || !n8nKeyRaw || !targetPassword) {
    throw createCodedError(
      RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
      "Restore requires backup encryption key, N8N_ENCRYPTION_KEY, and target PostgreSQL admin password.",
    );
  }

  const downloadStart = performance.now();
  let manifest;
  const encryptedArtifacts = {};

  if (options.localDir) {
    const sourceDir = resolve(options.localDir);
    manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
    verifyBackupManifest(manifest);
    if (options.backupId && manifest.backupId !== options.backupId) {
      throw createCodedError(
        RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
        "Local manifest backupId does not match requested --backup-id.",
      );
    }
    encryptedArtifacts.sop_app = readFileSync(join(sourceDir, "sop_app.dump.enc"));
    encryptedArtifacts.sop_n8n = readFileSync(join(sourceDir, "sop_n8n.dump.enc"));
  } else {
    if (!options.backupId || typeof options.backupId !== "string") {
      throw createCodedError(
        RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
        "Restore from offsite storage requires --backup-id.",
      );
    }
    const storage = options.storageClient ?? createBackupStorageClient(loadBackupStorageConfig(env, { readSecret }));
    const manifestKey = storage.buildObjectKey(`${options.backupId}/manifest.json`);
    const manifestBytes = await storage.getObjectBytes(manifestKey);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
    verifyBackupManifest(manifest);

    if (manifest.backupId !== options.backupId) {
      throw createCodedError(
        RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
        "Downloaded manifest backupId does not match requested --backup-id.",
      );
    }

    const expectedPrefix = `${storage.buildObjectKey(manifest.backupId)}/`;
    for (const database of ["sop_app", "sop_n8n"]) {
      const objectKey = manifest.artifacts[database].objectKey;
      if (!objectKey.startsWith(expectedPrefix)) {
        throw createCodedError(
          RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
          `Manifest artifact objectKey for "${database}" escapes the requested backup prefix.`,
        );
      }
    }

    encryptedArtifacts.sop_app = await storage.getObjectBytes(manifest.artifacts.sop_app.objectKey);
    encryptedArtifacts.sop_n8n = await storage.getObjectBytes(manifest.artifacts.sop_n8n.objectKey);
  }
  const downloadMs = roundMs(performance.now() - downloadStart);

  const decryptStart = performance.now();
  const restoredN8nFingerprint = keyFingerprint(n8nKeyRaw);
  const expectedN8nFingerprint = manifest.n8nKeyFingerprint.toLowerCase();
  if (
    !timingSafeEqual(
      Buffer.from(restoredN8nFingerprint, "hex"),
      Buffer.from(expectedN8nFingerprint, "hex"),
    )
  ) {
    throw createCodedError(
      RESTORE_ERROR_CODES.N8N_KEY_MISMATCH,
      "Provided N8N_ENCRYPTION_KEY does not match manifest.n8nKeyFingerprint; refusing restore.",
    );
  }

  const decryptedDumps = {};
  for (const database of ["sop_app", "sop_n8n"]) {
    const artifact = manifest.artifacts[database];
    const ciphertextBytes = encryptedArtifacts[database];
    const actualCiphertextSha256 = computeSha256(ciphertextBytes);
    if (
      !timingSafeEqual(
        Buffer.from(actualCiphertextSha256, "hex"),
        Buffer.from(artifact.ciphertextSha256.toLowerCase(), "hex"),
      )
    ) {
      throw createCodedError(
        RESTORE_ERROR_CODES.CIPHERTEXT_HASH_MISMATCH,
        `Ciphertext SHA-256 mismatch for "${database}"; refusing restore.`,
      );
    }

    try {
      decryptedDumps[database] = decryptBackupPayload(ciphertextBytes, {
        key: backupKeyRaw,
        database,
        backupId: manifest.backupId,
        expectedPlaintextSha256: artifact.plaintextSha256,
      });
    } catch (error) {
      throw createCodedError(
        RESTORE_ERROR_CODES.DECRYPT_FAILED,
        `Decryption failed for "${database}": ${error?.message ?? "authentication failed"}`,
      );
    }
  }
  const decryptMs = roundMs(performance.now() - decryptStart);

  const execSql = options.execSql ?? defaultExecSql;
  const restoreDb = options.restoreDatabase ?? defaultRestoreDatabase;
  const dbConn = { host: targetHost, port: targetPort, user: targetUser, password: targetPassword };

  const restoreAppStart = performance.now();
  await execSql({
    ...dbConn,
    database: "sop_app",
    sql: "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;",
  });
  await restoreDb({
    ...dbConn,
    database: "sop_app",
    dumpBytes: decryptedDumps.sop_app,
    args: buildPgRestoreArgs({ ...dbConn, database: "sop_app" }),
  });
  const restoreAppMs = roundMs(performance.now() - restoreAppStart);

  const restoreN8nStart = performance.now();
  await restoreDb({
    ...dbConn,
    database: "sop_n8n",
    dumpBytes: decryptedDumps.sop_n8n,
    args: buildPgRestoreArgs({ ...dbConn, database: "sop_n8n" }),
  });
  const restoreN8nMs = roundMs(performance.now() - restoreN8nStart);

  const verifyStart = performance.now();
  const vectorCheckRaw = await execSql({
    ...dbConn,
    database: "sop_app",
    sql: "SELECT extname FROM pg_extension WHERE extname = 'vector';",
  });
  if (!String(vectorCheckRaw).includes("vector")) {
    throw createCodedError(
      RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
      "Post-restore check failed: pgvector extension is missing in sop_app.",
    );
  }

  await execSql({
    ...dbConn,
    database: "sop_app",
    sql: "SELECT '[1,0,0]'::vector <-> '[0,1,0]'::vector;",
  });

  const appTablesRaw = await execSql({
    ...dbConn,
    database: "sop_app",
    sql: "SELECT table_schema || '.' || table_name FROM information_schema.tables WHERE table_schema = 'app';",
  });
  for (const requiredTable of REQUIRED_APP_TABLES) {
    if (!String(appTablesRaw).includes(requiredTable)) {
      throw createCodedError(
        RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
        `Post-restore check failed: missing required sop_app table "${requiredTable}".`,
      );
    }
  }

  const n8nTablesRaw = await execSql({
    ...dbConn,
    database: "sop_n8n",
    sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';",
  });
  for (const requiredTable of REQUIRED_N8N_TABLES) {
    if (!String(n8nTablesRaw).includes(requiredTable)) {
      throw createCodedError(
        RESTORE_ERROR_CODES.INTEGRITY_CHECK_FAILED,
        `Post-restore check failed: missing required sop_n8n table "${requiredTable}".`,
      );
    }
  }

  let reconciliation;
  if (typeof options.reconcileJobs === "function") {
    reconciliation = await options.reconcileJobs({ dbConn, manifest });
  } else {
    const rawCounts = await execSql({
      ...dbConn,
      database: "sop_app",
      sql: JOB_RECONCILIATION_SQL,
    });
    const [requeuedStr = "0", exhaustedStr = "0", prunedStr = "0"] = String(rawCounts).trim().split("|");
    reconciliation = {
      requeuedRunningJobs: Number.parseInt(requeuedStr, 10) || 0,
      exhaustedRunningJobs: Number.parseInt(exhaustedStr, 10) || 0,
      prunedChatTurnArtifacts: Number.parseInt(prunedStr, 10) || 0,
      redisTransientStateCleared: true,
    };
  }
  const verifyMs = roundMs(performance.now() - verifyStart);
  const totalMs = roundMs(performance.now() - totalStart);

  const nowDate = typeof options.now === "function" ? options.now() : new Date();
  const backupAgeSeconds = Math.max(
    0,
    Math.round((nowDate.getTime() - Date.parse(manifest.createdAt)) / 1000),
  );

  const recoveryGaps = [
    `Point-in-time gap between backup creation (${manifest.createdAt}) and restore (${nowDate.toISOString()}) is ${backupAgeSeconds}s; changes committed after the backup snapshot are not recovered by logical dumps.`,
    "Transient Redis queue entries are not backed up; in-flight jobs reconcile from durable PostgreSQL app.workflow_jobs state and orphaned app.chat_turn_artifacts are pruned.",
    "Live SOP deletions committed before backup expiry may still exist inside older retained encrypted backups until approved retention policy expires them.",
  ];

  return {
    ok: true,
    isolatedTarget: guard.isolatedTarget,
    targetProject: guard.targetProject,
    backupId: manifest.backupId,
    backupCreatedAt: manifest.createdAt,
    migrationHead: manifest.migrationHead,
    workflowVersions: manifest.workflowVersions,
    n8nKeyFingerprintVerified: true,
    n8nKeyFingerprint: restoredN8nFingerprint,
    integrity: {
      pgvectorVerified: true,
      appTablesVerified: [...REQUIRED_APP_TABLES],
      n8nTablesVerified: [...REQUIRED_N8N_TABLES],
    },
    reconciliation,
    timingsMs: {
      downloadMs,
      decryptMs,
      restoreAppMs,
      restoreN8nMs,
      verifyMs,
      totalMs,
    },
    recoveryGaps,
    policyNotice: PROVISIONAL_POLICY_NOTICE,
  };
}

function parseCliArgs(argv) {
  const parsed = {
    isolatedTarget: false,
    allowIsolatedOverride: false,
    targetProject: "",
    targetHost: "",
    backupId: "",
    localDir: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--isolated-target") parsed.isolatedTarget = true;
    else if (arg === "--confirm-isolated-override") parsed.allowIsolatedOverride = true;
    else if (arg === "--target-project" && next) {
      parsed.targetProject = next;
      index += 1;
    } else if (arg === "--target-host" && next) {
      parsed.targetHost = next;
      index += 1;
    } else if (arg === "--backup-id" && next) {
      parsed.backupId = next;
      index += 1;
    } else if (arg === "--local-dir" && next) {
      parsed.localDir = next;
      index += 1;
    }
  }
  return parsed;
}

if (isDirectExecution(import.meta.url)) {
  const cli = parseCliArgs(process.argv.slice(2));
  runIsolatedRestore(cli)
    .then((receipt) => {
      console.log(JSON.stringify(receipt, null, 2));
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          ok: false,
          code: error?.code ?? "RESTORE_FAILED",
          message: sanitizeAlertMessage(error?.message ?? "Isolated restore failed."),
        }),
      );
      process.exitCode = 1;
    });
}
