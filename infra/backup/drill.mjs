import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PROVISIONAL_POLICY_NOTICE } from "./crypto.mjs";
import { sanitizeAlertMessage } from "./run-backup.mjs";
import { RESTORE_ERROR_CODES, runIsolatedRestore } from "./run-restore.mjs";

export const DRILL_PROJECT_PREFIX = "ai-sop-dr-drill-";
export const DEFAULT_DRILL_PROXY_PORT = 3099;
const DRILL_PROJECT_PATTERN = /^ai-sop-dr-drill-[a-z0-9-]+$/;

export const REQUIRED_SMOKE_CHECKS = Object.freeze([
  "auth",
  "upload",
  "verification",
  "activeOnlyRetrieval",
  "chatSseStreamSafety",
]);

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

export function assertValidDrillProjectName(projectName) {
  if (typeof projectName !== "string" || !DRILL_PROJECT_PATTERN.test(projectName)) {
    const error = new Error(
      `Restore drill requires a disposable Compose project name matching "${DRILL_PROJECT_PREFIX}<id>".`,
    );
    error.code = RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED;
    throw error;
  }
  return projectName;
}

export function resolveDrillProxyPort(rawPort) {
  if (rawPort === undefined || rawPort === null || String(rawPort).trim() === "") {
    return DEFAULT_DRILL_PROXY_PORT;
  }
  const normalized = String(rawPort).trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("DRILL_PROXY_PORT must be an integer between 1024 and 65535.");
  }
  const parsed = Number.parseInt(normalized, 10);
  if (parsed < 1024 || parsed > 65535 || parsed === 3000) {
    throw new Error("DRILL_PROXY_PORT must be between 1024 and 65535 and must not collide with port 3000.");
  }
  return parsed;
}

export function generateDrillProjectName(nowDate = new Date()) {
  const stamp = nowDate.toISOString().slice(0, 10).replaceAll("-", "");
  return `${DRILL_PROJECT_PREFIX}${stamp}-${randomUUID().slice(0, 6)}`;
}

function defaultComposeCommand(project, args, { dockerBin = "docker", env = process.env } = {}) {
  return execFileSync(dockerBin, ["compose", "-p", project, ...args], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
    env,
  });
}

async function defaultObjectAccessCheck({ storageClient, sampleObjectKey }) {
  if (!storageClient || !sampleObjectKey) {
    return {
      verified: false,
      mode: "not_configured",
      detail: "No private sample object key supplied; object access must be verified against configured R2/S3 in live drill.",
    };
  }
  const head = await storageClient.headObject(sampleObjectKey);
  return {
    verified: Number.isInteger(head.contentLength) && head.contentLength > 0,
    mode: "head_object",
    bucket: head.bucket,
    contentLength: head.contentLength,
  };
}

export async function defaultSmokeChecks(options = {}) {
  const { baseUrl, fetchImpl = fetch } = options;
  const unexecutedReason =
    "Synthetic functional smoke suite not supplied; provide runSmokeChecks runner to verify auth/upload/verification/ACTIVE-only/SSE.";

  if (!baseUrl) {
    return {
      unauthenticatedFailClosed: {
        ok: false,
        executed: false,
        reason: "No isolated baseUrl supplied.",
      },
      ...Object.fromEntries(
        REQUIRED_SMOKE_CHECKS.map((name) => [name, { ok: false, executed: false, reason: unexecutedReason }]),
      ),
    };
  }

  const origin = baseUrl.replace(/\/+$/, "");
  const probe = async (path) => {
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      return response.status;
    } catch {
      return 0;
    }
  };

  const [readyStatus, documentsStatus, usersStatus, conversationsStatus] = await Promise.all([
    probe("/api/health/ready"),
    probe("/api/documents"),
    probe("/api/users"),
    probe("/api/chat/conversations"),
  ]);

  const unauthenticatedOk =
    readyStatus === 200 &&
    documentsStatus === 401 &&
    usersStatus === 401 &&
    conversationsStatus === 401;

  return {
    unauthenticatedFailClosed: {
      ok: unauthenticatedOk,
      executed: true,
      readyStatus,
      documentsStatus,
      usersStatus,
      conversationsStatus,
    },
    ...Object.fromEntries(
      REQUIRED_SMOKE_CHECKS.map((name) => [name, { ok: false, executed: false, reason: unexecutedReason }]),
    ),
  };
}

export function buildDrillComposeOverrideYaml(options = {}) {
  const drillProxyPort = resolveDrillProxyPort(options.drillProxyPort);
  const lines = [
    "services:",
    "  proxy:",
    "    ports: !override",
    `      - "127.0.0.1:${drillProxyPort}:8080"`,
  ];
  if (options.n8nEncryptionKeyFile) {
    const resolvedKeyPath = resolve(String(options.n8nEncryptionKeyFile));
    lines.push(
      "secrets:",
      "  n8n-encryption-key:",
      `    file: ${JSON.stringify(resolvedKeyPath)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildInNetworkRestoreComposeArgs(options = {}) {
  const {
    drillProject,
    backupId = "",
    localDir = "",
    n8nEncryptionKeyFile = ".local-secrets/n8n-encryption-key",
    postgresAdminPasswordFile = ".local-secrets/postgres-admin",
    drillOverrideFile = "",
  } = options;
  const resolvedN8nKeyFile = resolve(String(n8nEncryptionKeyFile));
  const resolvedPgAdminFile = resolve(String(postgresAdminPasswordFile));
  const restoreArgs = [
    "-f",
    "docker-compose.yml",
    "-f",
    "infra/backup/compose.backup.yml",
  ];
  if (drillOverrideFile) {
    restoreArgs.push("-f", String(drillOverrideFile));
  }
  restoreArgs.push(
    "--profile",
    "backup",
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "-e",
    `RESTORE_TARGET_PROJECT=${drillProject}`,
    "-e",
    "DB_ADMIN_USER=sop_bootstrap",
    "-e",
    "POSTGRES_PASSWORD_FILE=/run/secrets/postgres-admin-restore",
    "-e",
    "N8N_ENCRYPTION_KEY_FILE=/run/secrets/n8n-encryption-key-restore",
    "-v",
    `${resolvedPgAdminFile}:/run/secrets/postgres-admin-restore:ro`,
    "-v",
    `${resolvedN8nKeyFile}:/run/secrets/n8n-encryption-key-restore:ro`,
  );
  if (localDir) {
    const resolvedLocalDir = resolve(String(localDir));
    restoreArgs.push("-v", `${resolvedLocalDir}:/tmp/drill-backup:ro`);
  }
  restoreArgs.push(
    "backup-scheduler",
    "node",
    "infra/backup/run-restore.mjs",
    "--isolated-target",
    "--target-project",
    drillProject,
    "--target-host",
    "postgres",
  );
  if (backupId) {
    restoreArgs.push("--backup-id", backupId);
  }
  if (localDir) {
    restoreArgs.push("--local-dir", "/tmp/drill-backup");
  }
  return restoreArgs;
}

export async function runRestoreDrill(options = {}) {
  const env = options.env ?? process.env;
  const nowDate = typeof options.now === "function" ? options.now() : new Date();
  const drillId = options.drillId ?? `drill-${nowDate.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const drillProject = assertValidDrillProjectName(options.drillProject ?? generateDrillProjectName(nowDate));
  const drillProxyPort = resolveDrillProxyPort(options.drillProxyPort ?? env.DRILL_PROXY_PORT);

  if (String(env?.NODE_ENV ?? "").trim().toLowerCase() === "production") {
    const error = new Error("Restore drills must never run inside NODE_ENV=production.");
    error.code = RESTORE_ERROR_CODES.PRODUCTION_GUARD_BLOCKED;
    throw error;
  }

  const composeRunner = options.composeRunner ?? defaultComposeCommand;
  const objectAccessChecker = options.verifyObjectAccess ?? defaultObjectAccessCheck;
  const smokeRunner = options.runSmokeChecks ?? defaultSmokeChecks;
  const manageStack = options.manageStack ?? false;
  const inNetworkRestore = options.inNetworkRestore ?? manageStack;
  const n8nEncryptionKeyFile =
    options.n8nEncryptionKeyFile ?? env.DRILL_N8N_ENCRYPTION_KEY_FILE ?? "";
  const postgresAdminPasswordFile =
    options.postgresAdminPasswordFile ?? env.DRILL_POSTGRES_ADMIN_FILE ?? "";
  const drillStart = performance.now();
  const composeEnv = { ...env, DRILL_PROXY_PORT: String(drillProxyPort) };

  let overrideDir = null;
  let drillOverrideFile = "";
  let restoreReceipt = null;
  let objectAccess = null;
  let smokeChecks = null;
  let teardownSucceeded = manageStack ? false : null;
  let drillError = null;

  try {
    if (manageStack) {
      overrideDir = mkdtempSync(join(realpathSync(tmpdir()), "ai-sop-dr-override-"));
      drillOverrideFile = join(overrideDir, "compose.drill.yml");
      writeFileSync(
        drillOverrideFile,
        buildDrillComposeOverrideYaml({
          drillProxyPort,
          n8nEncryptionKeyFile: n8nEncryptionKeyFile || undefined,
        }),
        { mode: 0o600 },
      );
      composeRunner(
        drillProject,
        ["-f", "docker-compose.yml", "-f", drillOverrideFile, "up", "--wait", "--wait-timeout", "180", "postgres", "redis"],
        { env: composeEnv },
      );
    }

    if (options.restoreRunner) {
      restoreReceipt = await options.restoreRunner({
        ...(options.restoreOptions ?? {}),
        isolatedTarget: true,
        targetProject: drillProject,
        targetHost: inNetworkRestore ? "postgres" : options.restoreOptions?.targetHost ?? "127.0.0.1",
        env,
      });
    } else if (inNetworkRestore) {
      const rawOutput = composeRunner(
        drillProject,
        buildInNetworkRestoreComposeArgs({
          drillProject,
          backupId: options.restoreOptions?.backupId,
          localDir: options.restoreOptions?.localDir,
          n8nEncryptionKeyFile: n8nEncryptionKeyFile || undefined,
          postgresAdminPasswordFile: postgresAdminPasswordFile || undefined,
          drillOverrideFile,
        }),
        { env: composeEnv },
      );
      restoreReceipt = JSON.parse(String(rawOutput).trim());
    } else {
      restoreReceipt = await runIsolatedRestore({
        ...(options.restoreOptions ?? {}),
        isolatedTarget: true,
        targetProject: drillProject,
        env,
      });
    }

    if (manageStack) {
      composeRunner(
        drillProject,
        [
          "-f",
          "docker-compose.yml",
          "-f",
          drillOverrideFile,
          "up",
          "--wait",
          "--wait-timeout",
          "180",
          "n8n-main",
          "n8n-worker",
          "app",
          "proxy",
        ],
        { env: composeEnv },
      );
    }

    objectAccess = await objectAccessChecker({
      storageClient: options.storageClient ?? options.restoreOptions?.storageClient ?? null,
      sampleObjectKey: options.sampleObjectKey ?? null,
      drillProject,
    });

    smokeChecks = await smokeRunner({
      drillProject,
      baseUrl: options.baseUrl ?? (manageStack ? `http://127.0.0.1:${drillProxyPort}` : null),
      restoreReceipt,
    });

    const missingChecks = REQUIRED_SMOKE_CHECKS.filter((name) => !smokeChecks || !smokeChecks[name]);
    if (missingChecks.length > 0) {
      throw new Error(`Restore drill smoke checks missing required suites: ${missingChecks.join(", ")}.`);
    }
  } catch (error) {
    drillError = error;
  } finally {
    if (manageStack) {
      try {
        composeRunner(drillProject, ["down", "--volumes", "--remove-orphans"], { env: composeEnv });
        teardownSucceeded = true;
      } catch {
        teardownSucceeded = false;
      }
    }
    if (overrideDir) {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  }

  if (drillError) {
    throw drillError;
  }

  const allSmokePassed = REQUIRED_SMOKE_CHECKS.every(
    (name) => smokeChecks[name]?.ok === true && smokeChecks[name]?.executed !== false,
  );
  const recoveryGaps = [...(restoreReceipt?.recoveryGaps ?? [])];
  if (!objectAccess?.verified) {
    recoveryGaps.push("Private object access was not verified against a live R2/S3 bucket during this drill run.");
  }
  if (!allSmokePassed) {
    recoveryGaps.push("One or more synthetic functional smoke checks did not pass or were not executed.");
  }
  if (manageStack && teardownSucceeded !== true) {
    recoveryGaps.push(`Disposable drill project "${drillProject}" failed automated teardown and requires manual cleanup.`);
  }

  const teardownOk = !manageStack || teardownSucceeded === true;

  return {
    ok: Boolean(restoreReceipt?.ok && objectAccess?.verified && allSmokePassed && teardownOk),
    drillId,
    drillProject,
    drillProxyPort,
    executedAt: nowDate.toISOString(),
    backupId: restoreReceipt?.backupId ?? null,
    migrationHead: restoreReceipt?.migrationHead ?? null,
    n8nKeyFingerprintVerified: Boolean(restoreReceipt?.n8nKeyFingerprintVerified),
    restoreTimingsMs: restoreReceipt?.timingsMs ?? null,
    reconciliation: restoreReceipt?.reconciliation ?? null,
    objectAccess,
    smokeChecks,
    teardownSucceeded,
    totalDrillMs: roundMs(performance.now() - drillStart),
    recoveryGaps,
    policyNotice: PROVISIONAL_POLICY_NOTICE,
  };
}

function parseCliArgs(argv) {
  const parsed = {
    manageStack: true,
    restoreOptions: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--no-manage-stack") parsed.manageStack = false;
    else if (arg === "--project" && next) {
      parsed.drillProject = next;
      index += 1;
    } else if (arg === "--proxy-port" && next) {
      parsed.drillProxyPort = next;
      index += 1;
    } else if (arg === "--backup-id" && next) {
      parsed.restoreOptions.backupId = next;
      index += 1;
    } else if (arg === "--local-dir" && next) {
      parsed.restoreOptions.localDir = next;
      index += 1;
    } else if (arg === "--sample-object-key" && next) {
      parsed.sampleObjectKey = next;
      index += 1;
    } else if (arg === "--n8n-key-file" && next) {
      parsed.n8nEncryptionKeyFile = next;
      index += 1;
    } else if (arg === "--postgres-admin-file" && next) {
      parsed.postgresAdminPasswordFile = next;
      index += 1;
    } else if (arg === "--base-url" && next) {
      parsed.baseUrl = next;
      index += 1;
    }
  }
  return parsed;
}

if (isDirectExecution(import.meta.url)) {
  const cli = parseCliArgs(process.argv.slice(2));
  runRestoreDrill(cli)
    .then((receipt) => {
      console.log(JSON.stringify(receipt, null, 2));
      if (!receipt.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          ok: false,
          code: error?.code ?? "DRILL_FAILED",
          message: sanitizeAlertMessage(error?.message ?? "Isolated restore drill failed."),
        }),
      );
      process.exitCode = 1;
    });
}
