import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
export const ARTIFACT_DIGEST_MISMATCH_CODE = "ARTIFACT_DIGEST_MISMATCH";
export const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const DIGEST_IMAGE_REF_PATTERN = /^[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/;

export const REQUIRED_IMAGE_KEYS = [
  "app",
  "migrate",
  "paddleocr",
  "convertWorker",
  "backupScheduler",
];

export const SCHEMA_CHANGE_TYPES = [
  "none",
  "additive_backward_compatible",
  "breaking_requires_restore",
];

export const MANAGED_WORKFLOW_SPECS = [
  { id: "sop-s03-probe-v1", path: "n8n/s03-probe.v1.json" },
  { id: "sop-s05-ingestion-v1", path: "n8n/s05-ingestion.v1.json" },
  { id: "sop-s11-chat-v1", path: "n8n/s11-chat.v1.json" },
];

export const TRACKED_CONFIG_FILES = [
  "docker-compose.yml",
  "infra/deploy/compose.release.yml",
  "infra/proxy/nginx.conf",
  "infra/backup/compose.backup.yml",
];

const FORBIDDEN_SECRET_FIELD_PATTERN =
  /(?:password|secret|privatekey|token|cookie|apikey|passphrase|encryptionkey|signature)/i;

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

export function computeSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function scanForForbiddenFields(node, pathPrefix, errors) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      scanForForbiddenFields(node[index], `${pathPrefix}[${index}]`, errors);
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (FORBIDDEN_SECRET_FIELD_PATTERN.test(key)) {
      errors.push(`Forbidden secret-like field "${fieldPath}" in release manifest.`);
    }
    scanForForbiddenFields(value, fieldPath, errors);
  }
}

export function collectRepoArtifacts(rootDir = process.cwd()) {
  const journalPath = join(rootDir, "drizzle", "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  if (!Array.isArray(journal?.entries) || journal.entries.length === 0) {
    throw new Error("drizzle/meta/_journal.json must contain at least one migration entry.");
  }

  const migrationEntries = journal.entries.map((entry) => {
    const tag = String(entry.tag ?? "").trim();
    if (!tag) {
      throw new Error("Migration journal entry is missing a tag.");
    }
    const sqlPath = join(rootDir, "drizzle", `${tag}.sql`);
    const sqlBytes = readFileSync(sqlPath);
    return {
      idx: Number(entry.idx),
      tag,
      sha256: computeSha256(sqlBytes),
    };
  });

  const headTag = migrationEntries[migrationEntries.length - 1].tag;
  const migrations = {
    headTag,
    count: migrationEntries.length,
    entries: migrationEntries,
  };

  const workflows = MANAGED_WORKFLOW_SPECS.map((spec) => {
    const absolutePath = join(rootDir, ...spec.path.split("/"));
    const rawBytes = readFileSync(absolutePath);
    const parsed = JSON.parse(rawBytes.toString("utf8"));
    if (parsed?.id !== spec.id) {
      throw new Error(`Workflow ${spec.path} id "${parsed?.id}" does not match expected "${spec.id}".`);
    }
    return {
      id: spec.id,
      path: spec.path,
      sha256: computeSha256(rawBytes),
    };
  });

  const configDigests = {};
  for (const relPath of TRACKED_CONFIG_FILES) {
    const absolutePath = join(rootDir, ...relPath.split("/"));
    configDigests[relPath] = computeSha256(readFileSync(absolutePath));
  }

  return { migrations, workflows, configDigests };
}

export function validateReleaseManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["Release manifest must be a JSON object."] };
  }

  scanForForbiddenFields(manifest, "", errors);

  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${RELEASE_MANIFEST_SCHEMA_VERSION}.`);
  }
  if (typeof manifest.gitSha !== "string" || !GIT_SHA_PATTERN.test(manifest.gitSha)) {
    errors.push("gitSha must be a lowercase 40-character hexadecimal commit SHA.");
  }
  if (typeof manifest.gitRef !== "string" || manifest.gitRef.trim().length === 0) {
    errors.push("gitRef must be a non-empty string.");
  }
  if (typeof manifest.builtAt !== "string" || !Number.isFinite(Date.parse(manifest.builtAt))) {
    errors.push("builtAt must be a valid ISO-8601 timestamp.");
  }
  if (!SCHEMA_CHANGE_TYPES.includes(manifest.schemaChangeType)) {
    errors.push(`schemaChangeType must be one of: ${SCHEMA_CHANGE_TYPES.join(", ")}.`);
  }

  const images = manifest.images;
  if (!images || typeof images !== "object" || Array.isArray(images)) {
    errors.push("images must be an object containing all required digest-pinned service images.");
  } else {
    for (const key of REQUIRED_IMAGE_KEYS) {
      const ref = images[key];
      if (typeof ref !== "string" || !DIGEST_IMAGE_REF_PATTERN.test(ref)) {
        errors.push(
          `images.${key} must match immutable digest-only format "<repo>@sha256:<64-hex>" (no mutable tags or :latest).`,
        );
      }
    }
  }

  const migrations = manifest.migrations;
  if (!migrations || typeof migrations !== "object" || Array.isArray(migrations)) {
    errors.push("migrations must be an object with headTag, count, and entries.");
  } else {
    if (!Array.isArray(migrations.entries) || migrations.entries.length === 0) {
      errors.push("migrations.entries must be a non-empty array.");
    } else {
      const seenTags = new Set();
      for (const entry of migrations.entries) {
        if (!entry || typeof entry !== "object") {
          errors.push("Every migration entry must be an object.");
          continue;
        }
        if (typeof entry.tag !== "string" || entry.tag.trim().length === 0) {
          errors.push("Every migration entry must include a non-empty tag.");
        } else if (seenTags.has(entry.tag)) {
          errors.push(`Duplicate migration tag "${entry.tag}" in migrations.entries.`);
        } else {
          seenTags.add(entry.tag);
        }
        if (typeof entry.sha256 !== "string" || !SHA256_HEX_PATTERN.test(entry.sha256)) {
          errors.push(`Migration "${entry.tag ?? "<unknown>"}" must have a 64-hex sha256 digest.`);
        }
      }
      if (migrations.count !== migrations.entries.length) {
        errors.push("migrations.count must equal migrations.entries.length.");
      }
      const lastEntry = migrations.entries[migrations.entries.length - 1];
      if (typeof migrations.headTag !== "string" || migrations.headTag !== lastEntry?.tag) {
        errors.push("migrations.headTag must match the final entry tag in migrations.entries.");
      }
    }
  }

  const workflows = manifest.workflows;
  if (!Array.isArray(workflows)) {
    errors.push("workflows must be an array of managed workflow artifacts.");
  } else {
    const byId = new Map();
    for (const item of workflows) {
      if (!item || typeof item !== "object") {
        errors.push("Every workflow entry must be an object.");
        continue;
      }
      if (typeof item.id !== "string" || typeof item.path !== "string") {
        errors.push("Every workflow entry must specify string id and path.");
        continue;
      }
      if (typeof item.sha256 !== "string" || !SHA256_HEX_PATTERN.test(item.sha256)) {
        errors.push(`Workflow "${item.id}" must have a 64-hex sha256 digest.`);
      }
      byId.set(item.id, item);
    }
    for (const spec of MANAGED_WORKFLOW_SPECS) {
      const found = byId.get(spec.id);
      if (!found || found.path !== spec.path) {
        errors.push(`Missing required managed workflow "${spec.id}" (${spec.path}).`);
      }
    }
  }

  const configDigests = manifest.configDigests;
  if (!configDigests || typeof configDigests !== "object" || Array.isArray(configDigests)) {
    errors.push("configDigests must be an object mapping tracked config files to SHA-256 digests.");
  } else {
    for (const relPath of TRACKED_CONFIG_FILES) {
      const digest = configDigests[relPath];
      if (typeof digest !== "string" || !SHA256_HEX_PATTERN.test(digest)) {
        errors.push(`configDigests["${relPath}"] must be a 64-hex sha256 digest.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertValidReleaseManifest(manifest) {
  const result = validateReleaseManifest(manifest);
  if (!result.ok) {
    const error = new Error(`Invalid release manifest: ${result.errors.join("; ")}`);
    error.code = "RELEASE_MANIFEST_INVALID";
    error.details = result.errors;
    throw error;
  }
  return manifest;
}

export function createReleaseManifest(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const artifacts =
    options.migrations && options.workflows && options.configDigests
      ? {
          migrations: options.migrations,
          workflows: options.workflows,
          configDigests: options.configDigests,
        }
      : collectRepoArtifacts(rootDir);

  let schemaChangeType = options.schemaChangeType;
  if (!schemaChangeType) {
    if (options.previousManifest) {
      const prevHead = options.previousManifest.migrations?.headTag;
      const prevEntries = JSON.stringify(options.previousManifest.migrations?.entries ?? []);
      const nextEntries = JSON.stringify(artifacts.migrations.entries);
      schemaChangeType =
        prevHead === artifacts.migrations.headTag && prevEntries === nextEntries
          ? "none"
          : "additive_backward_compatible";
    } else {
      schemaChangeType = "none";
    }
  }

  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    gitSha: options.gitSha,
    gitRef: options.gitRef,
    builtAt: options.builtAt ?? new Date().toISOString(),
    images: options.images,
    migrations: artifacts.migrations,
    workflows: artifacts.workflows,
    configDigests: artifacts.configDigests,
    schemaChangeType,
  };

  return assertValidReleaseManifest(manifest);
}

export function checkRollbackCompatibility(currentManifest, targetManifest) {
  assertValidReleaseManifest(currentManifest);
  assertValidReleaseManifest(targetManifest);

  const currentMap = new Map(currentManifest.migrations.entries.map((entry) => [entry.tag, entry.sha256]));
  const targetMap = new Map(targetManifest.migrations.entries.map((entry) => [entry.tag, entry.sha256]));

  const addedMigrations = [];
  const modifiedMigrations = [];
  const removedMigrations = [];

  for (const [tag, sha256] of currentMap.entries()) {
    if (!targetMap.has(tag)) {
      addedMigrations.push(tag);
    } else if (targetMap.get(tag) !== sha256) {
      modifiedMigrations.push(tag);
    }
  }
  for (const tag of targetMap.keys()) {
    if (!currentMap.has(tag)) {
      removedMigrations.push(tag);
    }
  }

  const migrationsIdentical =
    currentManifest.migrations.headTag === targetManifest.migrations.headTag &&
    addedMigrations.length === 0 &&
    modifiedMigrations.length === 0 &&
    removedMigrations.length === 0;

  if (migrationsIdentical && currentManifest.schemaChangeType !== "breaking_requires_restore") {
    return {
      mode: "image_rollback_safe",
      requiresDataRecovery: false,
      schemaChangeType: currentManifest.schemaChangeType,
      currentMigrationHead: currentManifest.migrations.headTag,
      targetMigrationHead: targetManifest.migrations.headTag,
      addedMigrations: [],
      modifiedMigrations: [],
      removedMigrations: [],
      reason: "Migration head and SQL digests match; pinned image and workflow rollback is safe.",
    };
  }

  return {
    mode: "schema_recovery_required",
    requiresDataRecovery: true,
    schemaChangeType: currentManifest.schemaChangeType,
    currentMigrationHead: currentManifest.migrations.headTag,
    targetMigrationHead: targetManifest.migrations.headTag,
    addedMigrations,
    modifiedMigrations,
    removedMigrations,
    recoveryRunbook: "docs/disaster-recovery.md",
    reason:
      "Image rollback does not reverse PostgreSQL schema migrations; execute isolated S15 backup recovery or a verified additive-schema procedure.",
  };
}

export function detectRequiredReverification(previousManifest, nextManifest) {
  assertValidReleaseManifest(previousManifest);
  assertValidReleaseManifest(nextManifest);

  const changedAreas = new Set();
  const changedArtifacts = [];
  const requiredChecks = new Set();

  if (
    previousManifest.gitSha !== nextManifest.gitSha ||
    previousManifest.images.app !== nextManifest.images.app ||
    previousManifest.images.migrate !== nextManifest.images.migrate
  ) {
    changedAreas.add("application");
    if (previousManifest.gitSha !== nextManifest.gitSha) changedArtifacts.push("gitSha");
    if (previousManifest.images.app !== nextManifest.images.app) changedArtifacts.push("images.app");
    if (previousManifest.images.migrate !== nextManifest.images.migrate) {
      changedArtifacts.push("images.migrate");
    }
    for (const check of [
      "lint",
      "typecheck",
      "unit",
      "security-scan-artifacts",
      "deploy-smoke-check",
      "checked-answer-sse-smoke",
      "golden-benchmark-50",
    ]) {
      requiredChecks.add(check);
    }
  }

  if (
    previousManifest.images.paddleocr !== nextManifest.images.paddleocr ||
    previousManifest.images.convertWorker !== nextManifest.images.convertWorker
  ) {
    changedAreas.add("ingestion-workers");
    if (previousManifest.images.paddleocr !== nextManifest.images.paddleocr) {
      changedArtifacts.push("images.paddleocr");
      requiredChecks.add("paddleocr-verify");
    }
    if (previousManifest.images.convertWorker !== nextManifest.images.convertWorker) {
      changedArtifacts.push("images.convertWorker");
      requiredChecks.add("conversion-verify");
    }
    requiredChecks.add("ingestion-regression");
  }

  if (
    previousManifest.images.backupScheduler !== nextManifest.images.backupScheduler ||
    previousManifest.configDigests["infra/backup/compose.backup.yml"] !==
      nextManifest.configDigests["infra/backup/compose.backup.yml"]
  ) {
    changedAreas.add("backup-recovery");
    if (previousManifest.images.backupScheduler !== nextManifest.images.backupScheduler) {
      changedArtifacts.push("images.backupScheduler");
    }
    if (
      previousManifest.configDigests["infra/backup/compose.backup.yml"] !==
      nextManifest.configDigests["infra/backup/compose.backup.yml"]
    ) {
      changedArtifacts.push("config:infra/backup/compose.backup.yml");
    }
    for (const check of ["verify-hardening", "backup-unit", "isolated-restore-drill"]) {
      requiredChecks.add(check);
    }
  }

  const prevMigrations = JSON.stringify(previousManifest.migrations);
  const nextMigrations = JSON.stringify(nextManifest.migrations);
  if (prevMigrations !== nextMigrations) {
    changedAreas.add("database-schema");
    changedArtifacts.push("migrations");
    for (const check of [
      "test:db",
      "migration-review",
      "rollback-compatibility-check",
      "isolated-restore-drill",
    ]) {
      requiredChecks.add(check);
    }
  }

  const prevWorkflowsById = new Map(previousManifest.workflows.map((wf) => [wf.id, wf.sha256]));
  for (const wf of nextManifest.workflows) {
    if (prevWorkflowsById.get(wf.id) !== wf.sha256) {
      changedAreas.add("n8n-workflows");
      changedArtifacts.push(`workflow:${wf.id}`);
      for (const check of [
        "verify-hardening",
        "workflow-contract",
        "workflow-runtime-recovery",
        "checked-answer-sse-smoke",
      ]) {
        requiredChecks.add(check);
      }
      if (wf.id === "sop-s11-chat-v1") {
        requiredChecks.add("golden-benchmark-50");
      }
    }
  }

  const runtimeConfigs = [
    "docker-compose.yml",
    "infra/deploy/compose.release.yml",
    "infra/proxy/nginx.conf",
  ];
  for (const relPath of runtimeConfigs) {
    if (previousManifest.configDigests[relPath] !== nextManifest.configDigests[relPath]) {
      changedAreas.add("runtime-config");
      changedArtifacts.push(`config:${relPath}`);
      for (const check of [
        "verify-hardening",
        "compose-config",
        "deploy-smoke-check",
        "nonprod-rollback-rehearsal",
      ]) {
        requiredChecks.add(check);
      }
    }
  }

  return {
    changed: changedAreas.size > 0,
    changedAreas: [...changedAreas].sort(),
    changedArtifacts: [...new Set(changedArtifacts)].sort(),
    requiredChecks: [...requiredChecks].sort(),
  };
}

export function verifyRepoArtifactsMatchManifest(manifest, rootDir = process.cwd()) {
  assertValidReleaseManifest(manifest);
  const mismatches = [];

  for (const wf of manifest.workflows) {
    const filePath = join(rootDir, ...wf.path.split("/"));
    if (!existsSync(filePath)) {
      mismatches.push(`Missing workflow file "${wf.path}" required by manifest.`);
      continue;
    }
    const bytes = readFileSync(filePath);
    const actualSha = computeSha256(bytes);
    if (actualSha !== wf.sha256) {
      mismatches.push(
        `Workflow "${wf.path}" digest mismatch (expected ${wf.sha256}, actual ${actualSha}).`,
      );
    }
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (parsed?.id !== wf.id) {
        mismatches.push(`Workflow "${wf.path}" id mismatch (expected ${wf.id}, actual ${parsed?.id}).`);
      }
    } catch {
      mismatches.push(`Workflow "${wf.path}" is not valid JSON.`);
    }
  }

  for (const [relPath, expectedSha] of Object.entries(manifest.configDigests)) {
    const filePath = join(rootDir, ...relPath.split("/"));
    if (!existsSync(filePath)) {
      mismatches.push(`Missing config file "${relPath}" required by manifest.`);
      continue;
    }
    const actualSha = computeSha256(readFileSync(filePath));
    if (actualSha !== expectedSha) {
      mismatches.push(
        `Config "${relPath}" digest mismatch (expected ${expectedSha}, actual ${actualSha}).`,
      );
    }
  }

  if (mismatches.length > 0) {
    const error = new Error(`Artifact digest verification failed: ${mismatches.join("; ")}`);
    error.code = ARTIFACT_DIGEST_MISMATCH_CODE;
    error.mismatches = mismatches;
    throw error;
  }

  return {
    ok: true,
    verifiedWorkflows: manifest.workflows.length,
    verifiedConfigs: Object.keys(manifest.configDigests).length,
  };
}

export function snapshotReleaseArtifacts(manifest, rootDir, snapshotDir) {
  verifyRepoArtifactsMatchManifest(manifest, rootDir);
  mkdirSync(snapshotDir, { recursive: true });

  const relativeFiles = [
    ...manifest.workflows.map((wf) => wf.path),
    ...Object.keys(manifest.configDigests),
  ];

  for (const relPath of relativeFiles) {
    const sourcePath = join(rootDir, ...relPath.split("/"));
    const targetPath = join(snapshotDir, ...relPath.split("/"));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  writeFileSync(
    join(snapshotDir, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { ok: true, snapshotDir, fileCount: relativeFiles.length };
}

export function restoreReleaseArtifacts(manifest, snapshotDir, rootDir) {
  verifyRepoArtifactsMatchManifest(manifest, snapshotDir);

  const relativeFiles = [
    ...manifest.workflows.map((wf) => wf.path),
    ...Object.keys(manifest.configDigests),
  ];

  for (const relPath of relativeFiles) {
    const sourcePath = join(snapshotDir, ...relPath.split("/"));
    const targetPath = join(rootDir, ...relPath.split("/"));
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }

  verifyRepoArtifactsMatchManifest(manifest, rootDir);
  return { ok: true, restoredFrom: snapshotDir, fileCount: relativeFiles.length };
}

function parseCliArgs(argv) {
  const args = { _: [] };
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
    } else {
      args._.push(token);
    }
  }
  return args;
}

if (isDirectExecution(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2));

  try {
    if (args.validate) {
      const manifestPath = typeof args.validate === "string" ? args.validate : args._[0];
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      const validation = validateReleaseManifest(parsed);
      console.log(JSON.stringify(validation, null, 2));
      if (!validation.ok) process.exitCode = 1;
    } else if (args["check-rollback"]) {
      const current = JSON.parse(readFileSync(String(args.current), "utf8"));
      const target = JSON.parse(readFileSync(String(args.target), "utf8"));
      const result = checkRollbackCompatibility(current, target);
      console.log(JSON.stringify(result, null, 2));
      if (result.requiresDataRecovery) process.exitCode = 2;
    } else if (args.reverify) {
      const previous = JSON.parse(readFileSync(String(args.previous), "utf8"));
      const next = JSON.parse(readFileSync(String(args.next), "utf8"));
      console.log(JSON.stringify(detectRequiredReverification(previous, next), null, 2));
    } else {
      const manifest = createReleaseManifest({
        rootDir: process.cwd(),
        gitSha: String(args["git-sha"] ?? process.env.GITHUB_SHA ?? ""),
        gitRef: String(args["git-ref"] ?? process.env.GITHUB_REF ?? ""),
        builtAt: args["built-at"] ? String(args["built-at"]) : undefined,
        schemaChangeType: args["schema-change-type"] ? String(args["schema-change-type"]) : "none",
        images: {
          app: String(args["app-image"] ?? process.env.APP_IMAGE_DIGEST ?? ""),
          migrate: String(args["migrate-image"] ?? process.env.MIGRATE_IMAGE_DIGEST ?? ""),
          paddleocr: String(args["paddleocr-image"] ?? process.env.PADDLEOCR_IMAGE_DIGEST ?? ""),
          convertWorker: String(
            args["convert-worker-image"] ?? process.env.CONVERSION_IMAGE_DIGEST ?? "",
          ),
          backupScheduler: String(
            args["backup-scheduler-image"] ?? process.env.BACKUP_SCHEDULER_IMAGE_DIGEST ?? "",
          ),
        },
      });
      const output = JSON.stringify(manifest, null, 2);
      if (args.output) {
        const outputPath = resolve(String(args.output));
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${output}\n`, "utf8");
      }
      console.log(output);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: error?.code ?? "RELEASE_MANIFEST_ERROR",
        message: error?.message ?? "Release manifest command failed.",
      }),
    );
    process.exitCode = 1;
  }
}
