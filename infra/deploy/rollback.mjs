import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseComposeEnv, redactSensitiveText } from "./deploy.mjs";
import {
  assertValidReleaseManifest,
  checkRollbackCompatibility,
  restoreReleaseArtifacts,
} from "./release-manifest.mjs";
import { runDeploySmokeChecks } from "./smoke-check.mjs";

export const ROLLBACK_ERROR_CODES = {
  MANIFEST_MISSING: "ROLLBACK_MANIFEST_MISSING",
  MANIFEST_INVALID: "ROLLBACK_MANIFEST_INVALID",
  REQUIRES_DATA_RECOVERY: "ROLLBACK_REQUIRES_DATA_RECOVERY",
  SMOKE_FAILED: "ROLLBACK_SMOKE_FAILED",
  STEP_FAILED: "ROLLBACK_STEP_FAILED",
};

export const ROLLBACK_STEP_ORDER = [
  "validateCompatibility",
  "pullTargetImages",
  "restoreWorkflowArtifacts",
  "startTargetServices",
  "runSmokeChecks",
  "recordRolledBackRelease",
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
  return Number(Math.max(0, value).toFixed(2));
}

export function buildRollbackComposeCommands() {
  return {
    pullTargetImages: [["pull", "app", "paddleocr", "convert-worker"]],
    restoreWorkflowArtifacts: [
      ["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "postgres", "redis", "n8n-main"],
      ["run", "--rm", "--no-deps", "n8n-bootstrap"],
    ],
    // --no-deps prevents Docker Compose from re-running migrate during image rollback.
    startTargetServices: [
      ["up", "-d", "--no-build", "--no-deps", "--wait", "--wait-timeout", "180", "paddleocr", "convert-worker", "n8n-worker"],
      ["up", "-d", "--no-build", "--no-deps", "--wait", "--wait-timeout", "180", "app"],
      ["up", "-d", "--no-build", "--no-deps", "--wait", "--wait-timeout", "180", "proxy"],
    ],
  };
}

function loadManifest(explicitManifest, filePath, label) {
  if (explicitManifest) {
    try {
      return assertValidReleaseManifest(explicitManifest);
    } catch (error) {
      error.code = ROLLBACK_ERROR_CODES.MANIFEST_INVALID;
      throw error;
    }
  }
  if (!filePath || !existsSync(filePath)) {
    const error = new Error(`Missing required ${label} release manifest at "${filePath}".`);
    error.code = ROLLBACK_ERROR_CODES.MANIFEST_MISSING;
    throw error;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    const candidate = raw && typeof raw === "object" && raw.manifest ? raw.manifest : raw;
    return assertValidReleaseManifest(candidate);
  } catch (error) {
    error.code = ROLLBACK_ERROR_CODES.MANIFEST_INVALID;
    throw error;
  }
}

function writeJsonFile(filePath, payload) {
  mkdirSync(resolve(filePath, ".."), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function runDockerComposeCommand(args, composeEnv, composeFiles) {
  const fullArgs = [
    "compose",
    ...composeFiles.flatMap((file) => ["-f", file]),
    ...args,
  ];
  const result = spawnSync("docker", fullArgs, {
    encoding: "utf8",
    env: { ...process.env, ...composeEnv },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = redactSensitiveText(result.stderr || result.error?.message || "docker compose failed");
    const error = new Error(`docker compose ${args[0]} failed: ${detail}`);
    error.code = ROLLBACK_ERROR_CODES.STEP_FAILED;
    throw error;
  }
  return { ok: true };
}

export async function runControlledRollback(options = {}) {
  const clock = options.clock ?? (() => performance.now());
  const overallStart = clock();
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const stateDir = resolve(options.stateDir ?? ".deploy-state");
  const inProgressReleasePath = join(stateDir, "in-progress-release.json");
  const hasExplicitCurrent = Boolean(options.currentManifest || options.currentManifestPath);
  const usedInProgressManifest = !hasExplicitCurrent && existsSync(inProgressReleasePath);
  const currentReleasePath = options.currentManifestPath
    ? resolve(options.currentManifestPath)
    : usedInProgressManifest
      ? inProgressReleasePath
      : join(stateDir, "current-release.json");
  const targetReleasePath = options.targetManifestPath
    ? resolve(options.targetManifestPath)
    : join(stateDir, "previous-known-good.json");
  const composeFiles = options.composeFiles ?? [
    "docker-compose.yml",
    "infra/deploy/compose.release.yml",
  ];
  const dryRun = Boolean(options.dryRun);
  const allowAdditiveSchemaRollback = Boolean(options.allowAdditiveSchemaRollback);
  const runners = options.runners ?? {};
  const shouldRestoreArtifacts =
    options.restoreArtifacts ?? (!dryRun && !runners.restoreWorkflowArtifacts);
  const composeCommands = buildRollbackComposeCommands();
  const steps = [];

  const recordStep = async (name, fn) => {
    const start = clock();
    try {
      const output = await fn();
      steps.push({ name, ok: true, durationMs: roundMs(clock() - start) });
      return output;
    } catch (error) {
      steps.push({
        name,
        ok: false,
        durationMs: roundMs(clock() - start),
        errorCode: error?.code ?? ROLLBACK_ERROR_CODES.STEP_FAILED,
      });
      throw error;
    }
  };

  const currentManifest = loadManifest(
    options.currentManifest,
    currentReleasePath,
    usedInProgressManifest ? "in-progress" : "current",
  );
  const targetManifest = loadManifest(options.targetManifest, targetReleasePath, "target known-good");

  let compatibility = null;
  let additiveSchemaOverrideUsed = false;

  // Step 1: validateCompatibility
  await recordStep("validateCompatibility", async () => {
    compatibility = checkRollbackCompatibility(currentManifest, targetManifest);
    if (compatibility.requiresDataRecovery) {
      // Breaking migrations can never be rolled back via image swap alone.
      const additiveEligible =
        allowAdditiveSchemaRollback &&
        currentManifest.schemaChangeType === "additive_backward_compatible" &&
        compatibility.modifiedMigrations.length === 0 &&
        compatibility.removedMigrations.length === 0;

      if (!additiveEligible) {
        const error = new Error(
          `Blind image rollback refused (${compatibility.mode}): schema change type "${currentManifest.schemaChangeType}" cannot be reversed by image rollback. Follow ${compatibility.recoveryRunbook}.`,
        );
        error.code = ROLLBACK_ERROR_CODES.REQUIRES_DATA_RECOVERY;
        error.compatibility = compatibility;
        error.recoveryRunbook = compatibility.recoveryRunbook;
        throw error;
      }
      additiveSchemaOverrideUsed = true;
    }
  });

  const targetComposeEnv = buildReleaseComposeEnv(targetManifest);

  try {
    // Step 2: pullTargetImages
    await recordStep("pullTargetImages", async () => {
      if (runners.pullTargetImages) {
        await runners.pullTargetImages({
          targetManifest,
          composeEnv: targetComposeEnv,
          composeFiles,
          dryRun,
        });
      } else if (!dryRun) {
        for (const args of composeCommands.pullTargetImages) {
          runDockerComposeCommand(args, targetComposeEnv, composeFiles);
        }
      }
    });

    // Step 3: restoreWorkflowArtifacts (restores & verifies target snapshot before n8n-bootstrap)
    await recordStep("restoreWorkflowArtifacts", async () => {
      if (shouldRestoreArtifacts) {
        restoreReleaseArtifacts(
          targetManifest,
          join(stateDir, "releases", targetManifest.gitSha),
          rootDir,
        );
      }
      if (runners.restoreWorkflowArtifacts) {
        await runners.restoreWorkflowArtifacts({
          targetManifest,
          composeEnv: targetComposeEnv,
          composeFiles,
          dryRun,
        });
      } else if (!dryRun) {
        for (const args of composeCommands.restoreWorkflowArtifacts) {
          runDockerComposeCommand(args, targetComposeEnv, composeFiles);
        }
      }
    });

    // Step 4: startTargetServices (--no-deps avoids re-running migrate)
    await recordStep("startTargetServices", async () => {
      if (runners.startTargetServices) {
        await runners.startTargetServices({
          targetManifest,
          composeEnv: targetComposeEnv,
          composeFiles,
          dryRun,
        });
      } else if (!dryRun) {
        for (const args of composeCommands.startTargetServices) {
          runDockerComposeCommand(args, targetComposeEnv, composeFiles);
        }
      }
    });
  } catch (error) {
    const failedStep = steps[steps.length - 1]?.name ?? "unknown";
    return {
      ok: false,
      status: "FAILED",
      fromGitSha: currentManifest.gitSha,
      toGitSha: targetManifest.gitSha,
      usedInProgressManifest,
      failedStep,
      errorCode: error?.code ?? ROLLBACK_ERROR_CODES.STEP_FAILED,
      message: redactSensitiveText(error?.message ?? "Rollback step failed."),
      compatibility,
      additiveSchemaOverrideUsed,
      steps,
      timingsMs: { totalMs: roundMs(clock() - overallStart) },
    };
  }

  // Step 5: runSmokeChecks
  let smokeResult = null;
  const smokeStart = clock();
  try {
    if (runners.runSmokeChecks) {
      smokeResult = await runners.runSmokeChecks({ targetManifest, dryRun });
    } else if (dryRun) {
      smokeResult = { ok: true, mode: "dry_run", executed: false };
    } else {
      smokeResult = await runDeploySmokeChecks({
        baseUrl: options.baseUrl,
        sessionCookie: options.sessionCookie,
        question: options.smokeQuestion,
        healthOnly: options.healthOnly,
        timeoutMs: options.smokeTimeoutMs,
      });
    }

    const smokePassed = Boolean(smokeResult?.ok);
    steps.push({
      name: "runSmokeChecks",
      ok: smokePassed,
      durationMs: roundMs(clock() - smokeStart),
      ...(smokePassed ? {} : { errorCode: ROLLBACK_ERROR_CODES.SMOKE_FAILED }),
    });

    if (!smokePassed) {
      return {
        ok: false,
        status: "FAILED",
        fromGitSha: currentManifest.gitSha,
        toGitSha: targetManifest.gitSha,
        usedInProgressManifest,
        failedStep: "runSmokeChecks",
        errorCode: ROLLBACK_ERROR_CODES.SMOKE_FAILED,
        message: "Post-rollback smoke checks failed; current-release.json was not updated.",
        compatibility,
        additiveSchemaOverrideUsed,
        smokeResult,
        steps,
        timingsMs: { totalMs: roundMs(clock() - overallStart) },
      };
    }
  } catch (error) {
    steps.push({
      name: "runSmokeChecks",
      ok: false,
      durationMs: roundMs(clock() - smokeStart),
      errorCode: ROLLBACK_ERROR_CODES.SMOKE_FAILED,
    });
    return {
      ok: false,
      status: "FAILED",
      fromGitSha: currentManifest.gitSha,
      toGitSha: targetManifest.gitSha,
      usedInProgressManifest,
      failedStep: "runSmokeChecks",
      errorCode: ROLLBACK_ERROR_CODES.SMOKE_FAILED,
      message: redactSensitiveText(error?.message ?? "Post-rollback smoke check threw an error."),
      compatibility,
      additiveSchemaOverrideUsed,
      smokeResult: null,
      steps,
      timingsMs: { totalMs: roundMs(clock() - overallStart) },
    };
  }

  // Step 6: recordRolledBackRelease (clears in-progress-release.json on successful rollback)
  await recordStep("recordRolledBackRelease", async () => {
    if (runners.recordRolledBackRelease) {
      await runners.recordRolledBackRelease({ targetManifest, stateDir, dryRun });
    } else if (!dryRun) {
      writeJsonFile(join(stateDir, "current-release.json"), targetManifest);
      rmSync(inProgressReleasePath, { force: true });
    }
  });

  return {
    ok: true,
    status: dryRun ? "DRY_RUN_ROLLED_BACK" : "ROLLED_BACK",
    fromGitSha: currentManifest.gitSha,
    toGitSha: targetManifest.gitSha,
    usedInProgressManifest,
    compatibility,
    additiveSchemaOverrideUsed,
    steps,
    smokeResult,
    timingsMs: { totalMs: roundMs(clock() - overallStart) },
  };
}

function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    }
  }
  return args;
}

if (isDirectExecution(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    let sessionCookie = "";
    if (args["session-cookie-file"]) {
      sessionCookie = readFileSync(resolve(String(args["session-cookie-file"])), "utf8").trim();
    }

    const receipt = await runControlledRollback({
      stateDir: args["state-dir"] ? String(args["state-dir"]) : ".deploy-state",
      currentManifestPath: args["current-manifest"] ? String(args["current-manifest"]) : undefined,
      targetManifestPath: args["target-manifest"] ? String(args["target-manifest"]) : undefined,
      allowAdditiveSchemaRollback: Boolean(args["allow-additive-schema-rollback"]),
      baseUrl: args["base-url"] ? String(args["base-url"]) : "http://127.0.0.1:3000",
      sessionCookie,
      healthOnly: Boolean(args["health-only"]),
      dryRun: Boolean(args["dry-run"]),
    });

    console.log(JSON.stringify(receipt, null, 2));
    if (!receipt.ok) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        status: "FAILED",
        errorCode: error?.code ?? ROLLBACK_ERROR_CODES.STEP_FAILED,
        message: redactSensitiveText(error?.message ?? "Rollback failed."),
        ...(error?.recoveryRunbook ? { recoveryRunbook: error.recoveryRunbook } : {}),
      }),
    );
    process.exitCode = 1;
  }
}
