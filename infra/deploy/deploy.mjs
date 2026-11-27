import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValidReleaseManifest,
  checkRollbackCompatibility,
  GIT_SHA_PATTERN,
  snapshotReleaseArtifacts,
} from "./release-manifest.mjs";
import { runDeploySmokeChecks } from "./smoke-check.mjs";

export const DEPLOY_ERROR_CODES = {
  APPROVAL_REQUIRED: "DEPLOY_APPROVAL_REQUIRED",
  CONFIG_INVALID: "DEPLOY_CONFIG_INVALID",
  MANIFEST_INVALID: "DEPLOY_MANIFEST_INVALID",
  STEP_FAILED: "DEPLOY_STEP_FAILED",
  SMOKE_FAILED: "DEPLOY_SMOKE_FAILED",
};

export const DEPLOY_STEP_ORDER = [
  "validateManifest",
  "pullImages",
  "runMigrations",
  "bootstrapWorkflows",
  "startServices",
  "runSmokeChecks",
  "recordCurrentRelease",
];

const ALLOWED_ENVIRONMENTS = new Set(["staging", "nonprod", "production"]);

const REDACTION_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-(?:proj|live)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_API_KEY]"],
  [/\bre_[A-Za-z0-9]{12,}\b/g, "[REDACTED_RESEND_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/X-Amz-Signature=[A-Za-z0-9%._-]+/gi, "X-Amz-Signature=[REDACTED]"],
  [/postgres(?:ql)?:\/\/[^/\s:'"`]+:[^@\s'"`]+@/gi, "postgresql://[REDACTED]@"],
  [/((?:password|secret|token|cookie|authorization|apikey)\s*[=:]\s*)([^\s,;'"`]+)/gi, "$1[REDACTED]"],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]"],
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

export function redactSensitiveText(input) {
  let output = String(input ?? "");
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function buildReleaseComposeEnv(manifest) {
  assertValidReleaseManifest(manifest);
  return {
    APP_IMAGE_DIGEST: manifest.images.app,
    MIGRATE_IMAGE_DIGEST: manifest.images.migrate,
    PADDLEOCR_IMAGE_DIGEST: manifest.images.paddleocr,
    CONVERSION_IMAGE_DIGEST: manifest.images.convertWorker,
    BACKUP_SCHEDULER_IMAGE_DIGEST: manifest.images.backupScheduler,
  };
}

export function buildDeployComposeCommands() {
  return {
    pullImages: [["pull", "app", "migrate", "paddleocr", "convert-worker"]],
    runMigrations: [
      ["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "postgres"],
      ["run", "--rm", "--no-deps", "migrate"],
    ],
    bootstrapWorkflows: [
      ["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "redis", "n8n-main"],
      ["run", "--rm", "--no-deps", "n8n-bootstrap"],
    ],
    startServices: [["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "proxy"]],
  };
}

export function assertDeployApproval(options = {}) {
  const environment = String(options.environment ?? "").trim();
  if (!ALLOWED_ENVIRONMENTS.has(environment)) {
    const error = new Error(
      `Unsupported deployment environment "${environment}". Expected one of: staging, nonprod, production.`,
    );
    error.code = DEPLOY_ERROR_CODES.APPROVAL_REQUIRED;
    throw error;
  }

  const manifest = options.manifest;
  assertValidReleaseManifest(manifest);

  if (environment === "production") {
    const env = options.env ?? process.env;
    const hasProductionGate =
      env.GITHUB_ENVIRONMENT === "production" || options.approvedProductionGate === true;
    const candidateSha = String(options.v01CandidateSha ?? "").trim();
    const shaMatches = GIT_SHA_PATTERN.test(candidateSha) && candidateSha === manifest.gitSha;

    if (!hasProductionGate || !shaMatches) {
      const reasons = [];
      if (!hasProductionGate) {
        reasons.push(
          'missing approved production gate (GITHUB_ENVIRONMENT="production" or explicit --approved-production-gate)',
        );
      }
      if (!shaMatches) {
        reasons.push("missing or mismatched --v01-candidate-sha against manifest.gitSha");
      }
      const error = new Error(`Production deployment blocked: ${reasons.join("; ")}.`);
      error.code = DEPLOY_ERROR_CODES.APPROVAL_REQUIRED;
      throw error;
    }
  }

  return { ok: true, environment };
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
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
    error.code = DEPLOY_ERROR_CODES.STEP_FAILED;
    throw error;
  }
  return { ok: true };
}

export async function runControlledDeploy(options = {}) {
  const clock = options.clock ?? (() => performance.now());
  const overallStart = clock();
  const environment = String(options.environment ?? "staging").trim();
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const stateDir = resolve(options.stateDir ?? ".deploy-state");
  const currentReleasePath = join(stateDir, "current-release.json");
  const previousKnownGoodPath = join(stateDir, "previous-known-good.json");
  const inProgressReleasePath = join(stateDir, "in-progress-release.json");
  const composeFiles = options.composeFiles ?? [
    "docker-compose.yml",
    "infra/deploy/compose.release.yml",
  ];
  const dryRun = Boolean(options.dryRun);
  const healthOnly = Boolean(options.healthOnly);
  const sessionCookie = typeof options.sessionCookie === "string" ? options.sessionCookie.trim() : "";
  const runners = options.runners ?? {};
  const shouldVerifyArtifacts =
    options.verifyArtifacts ?? (!dryRun && !runners.bootstrapWorkflows && !runners.startServices);
  const composeCommands = buildDeployComposeCommands();
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
        errorCode: error?.code ?? DEPLOY_ERROR_CODES.STEP_FAILED,
      });
      throw error;
    }
  };

  let manifest = options.manifest ?? null;
  if (!manifest && options.manifestPath) {
    manifest = JSON.parse(readFileSync(resolve(options.manifestPath), "utf8"));
  }

  // Step 1: validateManifest + approval guard + smoke preflight + artifact digest snapshot
  await recordStep("validateManifest", async () => {
    try {
      assertValidReleaseManifest(manifest);
    } catch (error) {
      error.code = DEPLOY_ERROR_CODES.MANIFEST_INVALID;
      throw error;
    }
    assertDeployApproval({
      environment,
      manifest,
      env: options.env ?? process.env,
      approvedProductionGate: options.approvedProductionGate,
      v01CandidateSha: options.v01CandidateSha,
    });
    if (!dryRun && !healthOnly && !runners.runSmokeChecks && !sessionCookie) {
      const error = new Error(
        "Deployment blocked: checked-answer SSE smoke check requires an authorized synthetic session cookie (or explicit --health-only).",
      );
      error.code = DEPLOY_ERROR_CODES.CONFIG_INVALID;
      throw error;
    }
    if (shouldVerifyArtifacts) {
      snapshotReleaseArtifacts(manifest, rootDir, join(stateDir, "releases", manifest.gitSha));
    }
    if (runners.validateManifest) {
      await runners.validateManifest({ manifest, environment });
    }
  });

  const composeEnv = buildReleaseComposeEnv(manifest);

  // Retain existing current-release.json as previous-known-good.json before promoting candidate.
  const existingCurrent = readJsonIfExists(currentReleasePath);
  const existingPrevious = readJsonIfExists(previousKnownGoodPath);
  let previousKnownGood = existingPrevious;

  if (existingCurrent) {
    assertValidReleaseManifest(existingCurrent);
    if (!existingPrevious || existingCurrent.gitSha !== manifest.gitSha) {
      previousKnownGood = existingCurrent;
      if (!dryRun) {
        writeJsonFile(previousKnownGoodPath, existingCurrent);
      }
    }
  }

  let servicesStarted = false;
  let migrationsRan = false;

  try {
    // Step 2: pullImages
    await recordStep("pullImages", async () => {
      if (runners.pullImages) {
        await runners.pullImages({ manifest, composeEnv, composeFiles, dryRun });
      } else if (!dryRun) {
        for (const args of composeCommands.pullImages) {
          runDockerComposeCommand(args, composeEnv, composeFiles);
        }
      }
    });

    // Step 3: runMigrations (persists in-progress-release.json BEFORE mutating DB schema)
    await recordStep("runMigrations", async () => {
      if (!dryRun) {
        writeJsonFile(inProgressReleasePath, {
          manifest,
          migrationsRan: true,
          startedAt: new Date().toISOString(),
        });
      }
      if (runners.runMigrations) {
        await runners.runMigrations({ manifest, composeEnv, composeFiles, dryRun });
      } else if (!dryRun) {
        for (const args of composeCommands.runMigrations) {
          runDockerComposeCommand(args, composeEnv, composeFiles);
        }
      }
      migrationsRan = true;
    });

    // Step 4: bootstrapWorkflows
    await recordStep("bootstrapWorkflows", async () => {
      if (runners.bootstrapWorkflows) {
        await runners.bootstrapWorkflows({ manifest, composeEnv, composeFiles, dryRun });
      } else if (!dryRun) {
        for (const args of composeCommands.bootstrapWorkflows) {
          runDockerComposeCommand(args, composeEnv, composeFiles);
        }
      }
    });

    // Step 5: startServices
    await recordStep("startServices", async () => {
      if (runners.startServices) {
        await runners.startServices({ manifest, composeEnv, composeFiles, dryRun });
      } else if (!dryRun) {
        for (const args of composeCommands.startServices) {
          runDockerComposeCommand(args, composeEnv, composeFiles);
        }
      }
      servicesStarted = true;
    });
  } catch (error) {
    const failedStep = steps[steps.length - 1]?.name ?? "unknown";
    const rollbackAssessment =
      (migrationsRan || servicesStarted) && previousKnownGood
        ? checkRollbackCompatibility(manifest, previousKnownGood)
        : null;
    return {
      ok: false,
      status: "FAILED",
      environment,
      gitSha: manifest.gitSha,
      failedStep,
      errorCode: error?.code ?? DEPLOY_ERROR_CODES.STEP_FAILED,
      message: redactSensitiveText(error?.message ?? "Deployment step failed."),
      previousKnownGoodPreserved: Boolean(previousKnownGood),
      inProgressReleaseRecorded: !dryRun && existsSync(inProgressReleasePath),
      rollbackAssessment,
      steps,
      timingsMs: { totalMs: roundMs(clock() - overallStart) },
    };
  }

  // Step 6: runSmokeChecks
  let smokeResult = null;
  const smokeStart = clock();
  try {
    if (runners.runSmokeChecks) {
      smokeResult = await runners.runSmokeChecks({ manifest, environment, dryRun });
    } else if (dryRun) {
      smokeResult = {
        ok: true,
        mode: "dry_run",
        executed: false,
      };
    } else {
      smokeResult = await runDeploySmokeChecks({
        baseUrl: options.baseUrl,
        sessionCookie,
        question: options.smokeQuestion,
        healthOnly,
        timeoutMs: options.smokeTimeoutMs,
      });
    }

    const smokePassed = Boolean(smokeResult?.ok);
    steps.push({
      name: "runSmokeChecks",
      ok: smokePassed,
      durationMs: roundMs(clock() - smokeStart),
      ...(smokePassed ? {} : { errorCode: DEPLOY_ERROR_CODES.SMOKE_FAILED }),
    });

    if (!smokePassed) {
      const rollbackAssessment = previousKnownGood
        ? checkRollbackCompatibility(manifest, previousKnownGood)
        : null;
      return {
        ok: false,
        status: "FAILED",
        environment,
        gitSha: manifest.gitSha,
        failedStep: "runSmokeChecks",
        errorCode: DEPLOY_ERROR_CODES.SMOKE_FAILED,
        message: "Post-deploy smoke checks failed; release was not promoted and previous known-good manifest was preserved.",
        previousKnownGoodPreserved: Boolean(previousKnownGood),
        inProgressReleaseRecorded: !dryRun && existsSync(inProgressReleasePath),
        rollbackAssessment,
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
      errorCode: DEPLOY_ERROR_CODES.SMOKE_FAILED,
    });
    const rollbackAssessment = previousKnownGood
      ? checkRollbackCompatibility(manifest, previousKnownGood)
      : null;
    return {
      ok: false,
      status: "FAILED",
      environment,
      gitSha: manifest.gitSha,
      failedStep: "runSmokeChecks",
      errorCode: DEPLOY_ERROR_CODES.SMOKE_FAILED,
      message: redactSensitiveText(error?.message ?? "Smoke check threw an error."),
      previousKnownGoodPreserved: Boolean(previousKnownGood),
      inProgressReleaseRecorded: !dryRun && existsSync(inProgressReleasePath),
      rollbackAssessment,
      smokeResult: null,
      steps,
      timingsMs: { totalMs: roundMs(clock() - overallStart) },
    };
  }

  // Step 7: recordCurrentRelease (clears in-progress-release.json only after full promotion)
  await recordStep("recordCurrentRelease", async () => {
    if (runners.recordCurrentRelease) {
      await runners.recordCurrentRelease({ manifest, stateDir, dryRun });
    } else if (!dryRun) {
      writeJsonFile(currentReleasePath, manifest);
      rmSync(inProgressReleasePath, { force: true });
    }
  });

  return {
    ok: true,
    status: dryRun ? "DRY_RUN_SUCCEEDED" : "SUCCEEDED",
    environment,
    gitSha: manifest.gitSha,
    previousGitSha: previousKnownGood?.gitSha ?? null,
    previousKnownGoodPreserved: Boolean(previousKnownGood),
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

    const receipt = await runControlledDeploy({
      manifestPath: args.manifest ? String(args.manifest) : "release-manifest.json",
      environment: args.environment ? String(args.environment) : "staging",
      stateDir: args["state-dir"] ? String(args["state-dir"]) : ".deploy-state",
      v01CandidateSha: args["v01-candidate-sha"] ? String(args["v01-candidate-sha"]) : "",
      approvedProductionGate: Boolean(args["approved-production-gate"]),
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
        errorCode: error?.code ?? DEPLOY_ERROR_CODES.STEP_FAILED,
        message: redactSensitiveText(error?.message ?? "Deployment failed."),
      }),
    );
    process.exitCode = 1;
  }
}
