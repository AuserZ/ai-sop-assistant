import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256_DIGEST_PATTERN = /@sha256:[a-f0-9]{64}$/;
const EXCLUDED_N8N_NODE_TYPES = new Set([
  "n8n-nodes-base.code",
  "n8n-nodes-base.executeCommand",
  "n8n-nodes-base.localFileTrigger",
  "n8n-nodes-base.readWriteFile",
]);

const REQUIRED_INTERNAL_NETWORKS = ["database", "workflow", "ocr", "conversion"];
const SERVICES_REQUIRING_BOUNDED_LOGGING = ["postgres", "migrate", "app", "proxy", "redis", "n8n-main", "n8n-worker"];
const SERVICES_REQUIRING_NO_LOGGING = ["paddleocr", "convert-worker"];
const SERVICES_REQUIRING_RESOURCE_LIMITS = [
  "postgres",
  "migrate",
  "app",
  "proxy",
  "redis",
  "n8n-main",
  "n8n-worker",
  "paddleocr",
  "convert-worker",
];
const SERVICES_REQUIRING_READ_ONLY = [
  "migrate",
  "app",
  "proxy",
  "redis",
  "n8n-main",
  "n8n-worker",
  "paddleocr",
  "convert-worker",
];

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

function splitTopLevelSections(yamlText) {
  const sections = new Map();
  let currentKey = null;
  let currentLines = [];

  for (const rawLine of yamlText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (!rawLine.startsWith(" ") && !rawLine.startsWith("\t") && rawLine.includes(":")) {
      if (currentKey) sections.set(currentKey, currentLines);
      const colonIndex = rawLine.indexOf(":");
      currentKey = rawLine.slice(0, colonIndex).trim();
      currentLines = [rawLine.slice(colonIndex + 1)];
    } else if (currentKey) {
      currentLines.push(rawLine);
    }
  }
  if (currentKey) sections.set(currentKey, currentLines);
  return sections;
}

function splitNamedBlocks(lines, indentSpaces = 2) {
  const blocks = new Map();
  const prefix = " ".repeat(indentSpaces);
  let currentName = null;
  let currentLines = [];

  for (const line of lines) {
    if (line.startsWith(prefix) && !line.startsWith(`${prefix} `) && line.includes(":")) {
      if (currentName) blocks.set(currentName, currentLines.join("\n"));
      const colonIndex = line.indexOf(":");
      currentName = line.slice(indentSpaces, colonIndex).trim();
      currentLines = [line];
    } else if (currentName) {
      currentLines.push(line);
    }
  }
  if (currentName) blocks.set(currentName, currentLines.join("\n"));
  return blocks;
}

function expandServiceBlock(serviceBlock, runtimeAnchorBlock) {
  if (serviceBlock.includes("<<: *n8n-runtime") && runtimeAnchorBlock) {
    return `${runtimeAnchorBlock}\n${serviceBlock}`;
  }
  return serviceBlock;
}

export function auditDockerfile(content) {
  const violations = [];
  const stageAliases = new Set();
  const lines = content.split(/\r?\n/);
  let currentStage = null;
  let runtimeStageUser = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;

    const fromMatch = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (fromMatch) {
      const imageRef = fromMatch[1];
      const alias = fromMatch[2] ?? null;
      currentStage = alias ?? imageRef;
      if (!stageAliases.has(imageRef) && !SHA256_DIGEST_PATTERN.test(imageRef)) {
        violations.push(`Dockerfile:${index + 1}: base image "${imageRef}" must be pinned to an immutable @sha256 digest`);
      }
      if (alias) stageAliases.add(alias);
      continue;
    }

    const userMatch = /^USER\s+(\S+)/i.exec(line);
    if (userMatch && currentStage === "runtime") {
      runtimeStageUser = userMatch[1];
    }
  }

  if (!runtimeStageUser || runtimeStageUser === "root" || runtimeStageUser === "0" || runtimeStageUser.startsWith("0:")) {
    violations.push("Dockerfile: runtime stage must set a non-root USER");
  }
  if (!/NEXT_TELEMETRY_DISABLED=1/.test(content)) {
    violations.push("Dockerfile: NEXT_TELEMETRY_DISABLED=1 must be set");
  }
  if (!/COPY\s+--from=dependencies\s+--chown=node:node\s+.*pdf\.worker\.min\.mjs\s+\.\/public\/pdf\.worker\.min\.mjs/.test(content)) {
    violations.push("Dockerfile: pdf.worker.min.mjs must be copied to ./public/pdf.worker.min.mjs with --chown=node:node");
  }

  return { ok: violations.length === 0, violations };
}

export function auditCompose(content) {
  const violations = [];
  const sections = splitTopLevelSections(content);

  const boundedLoggingAnchor = (sections.get("x-bounded-logging") ?? []).join("\n");
  const hasBoundedLoggingAnchor =
    /driver:\s*json-file/.test(boundedLoggingAnchor) &&
    /max-size:\s*"?10m"?/.test(boundedLoggingAnchor) &&
    /max-file:\s*"?3"?/.test(boundedLoggingAnchor);
  if (!hasBoundedLoggingAnchor) {
    violations.push("docker-compose.yml: x-bounded-logging anchor must define json-file driver with bounded max-size and max-file");
  }

  const n8nEnvText = (sections.get("x-n8n-environment") ?? []).join("\n");
  const requiredN8nSettings = [
    ["EXECUTIONS_DATA_SAVE_ON_SUCCESS", /EXECUTIONS_DATA_SAVE_ON_SUCCESS:\s*"?none"?/],
    ["EXECUTIONS_DATA_SAVE_ON_ERROR", /EXECUTIONS_DATA_SAVE_ON_ERROR:\s*"?none"?/],
    ["EXECUTIONS_DATA_SAVE_ON_PROGRESS", /EXECUTIONS_DATA_SAVE_ON_PROGRESS:\s*"?false"?/],
    ["EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS", /EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS:\s*"?false"?/],
    ["EXECUTIONS_DATA_PRUNE", /EXECUTIONS_DATA_PRUNE:\s*"?true"?/],
    ["N8N_DISABLE_UI", /N8N_DISABLE_UI:\s*"?true"?/],
    ["N8N_PUBLIC_API_DISABLED", /N8N_PUBLIC_API_DISABLED:\s*"?true"?/],
    ["N8N_BLOCK_ENV_ACCESS_IN_NODE", /N8N_BLOCK_ENV_ACCESS_IN_NODE:\s*"?true"?/],
  ];
  for (const [name, pattern] of requiredN8nSettings) {
    if (!pattern.test(n8nEnvText)) {
      violations.push(`docker-compose.yml: x-n8n-environment must set ${name}`);
    }
  }
  if (!n8nEnvText.includes("n8n-nodes-base.code") || !n8nEnvText.includes("n8n-nodes-base.executeCommand")) {
    violations.push("docker-compose.yml: NODES_EXCLUDE must exclude code and executeCommand nodes");
  }

  const networksSection = splitNamedBlocks(sections.get("networks") ?? []);
  for (const networkName of REQUIRED_INTERNAL_NETWORKS) {
    const block = networksSection.get(networkName) ?? "";
    if (!/internal:\s*true/.test(block)) {
      violations.push(`docker-compose.yml: network "${networkName}" must declare internal: true`);
    }
  }

  const runtimeAnchorBlock = (sections.get("x-n8n-runtime") ?? []).join("\n");
  const services = splitNamedBlocks(sections.get("services") ?? []);

  for (const [serviceName, rawBlock] of services.entries()) {
    const effectiveBlock = expandServiceBlock(rawBlock, runtimeAnchorBlock);
    const portsMatch = /^\s+ports:\s*(.*)$/m.exec(effectiveBlock);
    if (portsMatch) {
      if (serviceName !== "proxy") {
        violations.push(`docker-compose.yml: service "${serviceName}" must not publish host ports`);
      } else if (!/127\.0\.0\.1:\d+:\d+/.test(effectiveBlock)) {
        violations.push('docker-compose.yml: service "proxy" must bind only to loopback 127.0.0.1');
      }
    }
  }

  if (!services.has("proxy") || !/^\s+ports:/m.test(services.get("proxy") ?? "")) {
    violations.push('docker-compose.yml: service "proxy" must publish a loopback port');
  }

  for (const serviceName of SERVICES_REQUIRING_NO_LOGGING) {
    const block = services.get(serviceName) ?? "";
    if (!/logging:\s*\n\s+driver:\s*none/.test(block)) {
      violations.push(`docker-compose.yml: service "${serviceName}" must keep logging driver: none`);
    }
  }

  for (const serviceName of SERVICES_REQUIRING_BOUNDED_LOGGING) {
    const rawBlock = services.get(serviceName);
    if (!rawBlock) {
      violations.push(`docker-compose.yml: missing required service "${serviceName}"`);
      continue;
    }
    const effectiveBlock = expandServiceBlock(rawBlock, runtimeAnchorBlock);
    const hasInlineBoundedLogging =
      /driver:\s*json-file/.test(effectiveBlock) &&
      /max-size:/.test(effectiveBlock) &&
      /max-file:/.test(effectiveBlock);
    if (!/logging:\s*\*bounded-logging/.test(effectiveBlock) && !hasInlineBoundedLogging) {
      violations.push(`docker-compose.yml: service "${serviceName}" must configure bounded logging`);
    }
  }

  for (const serviceName of SERVICES_REQUIRING_RESOURCE_LIMITS) {
    const rawBlock = services.get(serviceName);
    if (!rawBlock) continue;
    const effectiveBlock = expandServiceBlock(rawBlock, runtimeAnchorBlock);
    for (const limitKey of ["mem_limit", "cpus", "pids_limit"]) {
      if (!new RegExp(`^\\s+${limitKey}:`, "m").test(effectiveBlock)) {
        violations.push(`docker-compose.yml: service "${serviceName}" must set ${limitKey}`);
      }
    }
  }

  for (const serviceName of SERVICES_REQUIRING_READ_ONLY) {
    const rawBlock = services.get(serviceName);
    if (!rawBlock) continue;
    const effectiveBlock = expandServiceBlock(rawBlock, runtimeAnchorBlock);
    if (!/read_only:\s*true/.test(effectiveBlock)) {
      violations.push(`docker-compose.yml: service "${serviceName}" must set read_only: true`);
    }
    if (!/cap_drop:\s*\[ALL\]/.test(effectiveBlock)) {
      violations.push(`docker-compose.yml: service "${serviceName}" must drop ALL capabilities`);
    }
    if (!/no-new-privileges:true/.test(effectiveBlock)) {
      violations.push(`docker-compose.yml: service "${serviceName}" must set no-new-privileges:true`);
    }
  }

  const migrateBlock = services.get("migrate") ?? "";
  if (migrateBlock) {
    if (!/tmpfs:[\s\S]*?\/tmp/.test(migrateBlock)) {
      violations.push('docker-compose.yml: service "migrate" must mount a /tmp tmpfs');
    }
    if (!/^\s+HOME:\s*"?\/tmp"?\s*$/m.test(migrateBlock)) {
      violations.push('docker-compose.yml: service "migrate" must set HOME: /tmp');
    }
  }

  return { ok: violations.length === 0, violations };
}

export function auditNginx(content) {
  const violations = [];
  const requiredDirectives = [
    ["server_tokens off;", /server_tokens\s+off\s*;/],
    ["location /api/internal/ { return 404; }", /location\s+\/api\/internal\/\s*\{\s*return\s+404\s*;\s*\}/],
    ["client_max_body_size 16k;", /client_max_body_size\s+16k\s*;/],
    ["proxy_buffering off;", /proxy_buffering\s+off\s*;/],
    ["proxy_cache off;", /proxy_cache\s+off\s*;/],
    ["proxy_read_timeout 35s;", /proxy_read_timeout\s+35s\s*;/],
    ["send_timeout 15s;", /send_timeout\s+15s\s*;/],
    ["proxy_ignore_client_abort off;", /proxy_ignore_client_abort\s+off\s*;/],
    ["proxy_set_header Host $http_host;", /proxy_set_header\s+Host\s+\$http_host\s*;/],
    ["X-Content-Type-Options nosniff header", /add_header\s+X-Content-Type-Options\s+"nosniff"\s+always\s*;/],
    ["X-Frame-Options DENY header", /add_header\s+X-Frame-Options\s+"DENY"\s+always\s*;/],
    ["Referrer-Policy no-referrer header", /add_header\s+Referrer-Policy\s+"no-referrer"\s+always\s*;/],
    [
      "Permissions-Policy header",
      /add_header\s+Permissions-Policy\s+"camera=\(\), microphone=\(\), geolocation=\(\)"\s+always\s*;/,
    ],
  ];

  for (const [label, pattern] of requiredDirectives) {
    if (!pattern.test(content)) {
      violations.push(`infra/proxy/nginx.conf: missing required directive (${label})`);
    }
  }

  return { ok: violations.length === 0, violations };
}

export function auditN8nWorkflow(fileName, workflow) {
  const violations = [];
  const settings = workflow?.settings ?? {};

  if (settings.saveDataErrorExecution !== "none") {
    violations.push(`${fileName}: settings.saveDataErrorExecution must be "none"`);
  }
  if (settings.saveDataSuccessExecution !== "none") {
    violations.push(`${fileName}: settings.saveDataSuccessExecution must be "none"`);
  }
  if (settings.saveManualExecutions !== false) {
    violations.push(`${fileName}: settings.saveManualExecutions must be false`);
  }
  if (settings.saveExecutionProgress !== false) {
    violations.push(`${fileName}: settings.saveExecutionProgress must be false`);
  }

  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  for (const node of nodes) {
    if (EXCLUDED_N8N_NODE_TYPES.has(node?.type)) {
      violations.push(`${fileName}: node "${node.name ?? node.id}" uses excluded type "${node.type}"`);
    }
    if (node?.type === "n8n-nodes-base.webhook" && node?.parameters?.authentication !== "jwtAuth") {
      violations.push(`${fileName}: webhook node "${node.name ?? node.id}" must require jwtAuth`);
    }
    if (node?.type === "n8n-nodes-base.httpRequest") {
      const followRedirects = node?.parameters?.options?.redirect?.redirect?.followRedirects;
      if (followRedirects !== false) {
        violations.push(`${fileName}: httpRequest node "${node.name ?? node.id}" must set followRedirects: false`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

export function auditBackupDockerfile(content) {
  const violations = [];
  const stageAliases = new Set();
  const lines = content.split(/\r?\n/);
  let currentStage = null;
  let runtimeStageUser = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;

    const fromMatch = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (fromMatch) {
      const imageRef = fromMatch[1];
      const alias = fromMatch[2] ?? null;
      currentStage = alias ?? imageRef;
      if (!stageAliases.has(imageRef) && !SHA256_DIGEST_PATTERN.test(imageRef)) {
        violations.push(
          `infra/backup/Dockerfile:${index + 1}: base image "${imageRef}" must be pinned to an immutable @sha256 digest`,
        );
      }
      if (alias) stageAliases.add(alias);
      continue;
    }

    const userMatch = /^USER\s+(\S+)/i.exec(line);
    if (userMatch && currentStage === "runtime") {
      runtimeStageUser = userMatch[1];
    }
  }

  if (!runtimeStageUser || runtimeStageUser === "root" || runtimeStageUser === "0" || runtimeStageUser.startsWith("0:")) {
    violations.push("infra/backup/Dockerfile: runtime stage must set a non-root USER");
  }

  return { ok: violations.length === 0, violations };
}

export function auditBackupCompose(content) {
  const violations = [];
  const sections = splitTopLevelSections(content);
  const services = splitNamedBlocks(sections.get("services") ?? []);
  const block = services.get("backup-scheduler");

  if (!block) {
    violations.push('infra/backup/compose.backup.yml: missing required service "backup-scheduler"');
    return { ok: false, violations };
  }

  if (!/profiles:\s*\[backup\]/.test(block)) {
    violations.push('infra/backup/compose.backup.yml: backup-scheduler must declare profiles: [backup]');
  }
  const userMatch = /^\s+user:\s*"?([^"\s]+)"?/m.exec(block);
  if (!userMatch || userMatch[1] === "root" || userMatch[1] === "0" || userMatch[1].startsWith("0:")) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must run as a non-root user");
  }
  if (!/read_only:\s*true/.test(block)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must set read_only: true");
  }
  if (!/cap_drop:\s*\[ALL\]/.test(block)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must drop ALL capabilities");
  }
  if (!/no-new-privileges:true/.test(block)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must set no-new-privileges:true");
  }
  if (/^\s+ports:/m.test(block)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must not publish host ports");
  }
  if (
    !/driver:\s*json-file/.test(block) ||
    !/max-size:/.test(block) ||
    !/max-file:/.test(block)
  ) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must configure bounded json-file logging");
  }
  for (const limitKey of ["mem_limit", "cpus", "pids_limit"]) {
    if (!new RegExp(`^\\s+${limitKey}:`, "m").test(block)) {
      violations.push(`infra/backup/compose.backup.yml: backup-scheduler must set ${limitKey}`);
    }
  }
  if (/(?:^|\W)n8n-encryption-key(?!-fingerprint)(?:\W|$)/m.test(content)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must not mount raw n8n-encryption-key");
  }
  if (/backup-escrow-passphrase/.test(content)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must not mount backup-escrow-passphrase");
  }
  if (/(?:^|\W)postgres-admin(?:\W|$)/m.test(content)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must not mount postgres-admin superuser secret");
  }
  if (/(?:^|\W)sop_bootstrap(?:\W|$)/m.test(content)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must not use superuser sop_bootstrap role");
  }
  if (!/^\s+BACKUP_PG_USER:\s*"?sop_backup"?\s*$/m.test(block)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must set BACKUP_PG_USER: sop_backup");
  }
  if (!/^\s+BACKUP_PG_PASSWORD_FILE:\s*"?\/run\/secrets\/backup-db"?\s*$/m.test(block)) {
    violations.push(
      "infra/backup/compose.backup.yml: backup-scheduler must set BACKUP_PG_PASSWORD_FILE: /run/secrets/backup-db",
    );
  }
  if (!/^\s+-\s*backup-db\s*$/m.test(block)) {
    violations.push("infra/backup/compose.backup.yml: backup-scheduler must mount least-privilege backup-db secret");
  }

  return { ok: violations.length === 0, violations };
}

function parseJobNeeds(jobBlock) {
  const needs = new Set();
  const lines = jobBlock.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(\s+)needs:\s*(.*)$/.exec(line);
    if (!match) continue;
    const baseIndent = match[1].length;
    const inlineValue = match[2].trim();
    if (inlineValue) {
      if (inlineValue.startsWith("[") && inlineValue.endsWith("]")) {
        for (const item of inlineValue.slice(1, -1).split(",")) {
          const cleaned = item.trim().replace(/^["']|["']$/g, "");
          if (cleaned) needs.add(cleaned);
        }
      } else {
        needs.add(inlineValue.replace(/^["']|["']$/g, ""));
      }
      break;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextLine = lines[cursor];
      if (!nextLine.trim() || nextLine.trim().startsWith("#")) continue;
      const itemMatch = /^(\s+)-\s*([^\s#]+)/.exec(nextLine);
      if (itemMatch && itemMatch[1].length >= baseIndent) {
        needs.add(itemMatch[2].trim().replace(/^["']|["']$/g, ""));
      } else {
        break;
      }
    }
    break;
  }
  return needs;
}

function findInlineInputsInRunBlocks(content) {
  const hits = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const runMatch = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (!runMatch) continue;
    const runIndent = runMatch[1].length;
    const value = runMatch[2].trim();
    if (value && !/^[|>][+-]?$/.test(value)) {
      if (/\$\{\{\s*inputs\./.test(value)) {
        hits.push(index + 1);
      }
      continue;
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const bodyLine = lines[cursor];
      if (!bodyLine.trim()) continue;
      const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
      if (bodyIndent <= runIndent) break;
      if (/\$\{\{\s*inputs\./.test(bodyLine)) {
        hits.push(cursor + 1);
      }
    }
  }
  return hits;
}

export function auditReleaseCompose(content) {
  const violations = [];
  const sections = splitTopLevelSections(content);
  const services = splitNamedBlocks(sections.get("services") ?? []);

  if (/:latest(?:\s|$|["'])/.test(content)) {
    violations.push("infra/deploy/compose.release.yml: must not reference mutable :latest image tags");
  }

  const requiredDigestServices = [
    ["app", "APP_IMAGE_DIGEST"],
    ["migrate", "MIGRATE_IMAGE_DIGEST"],
    ["paddleocr", "PADDLEOCR_IMAGE_DIGEST"],
    ["convert-worker", "CONVERSION_IMAGE_DIGEST"],
    ["backup-scheduler", "BACKUP_SCHEDULER_IMAGE_DIGEST"],
  ];

  for (const [serviceName, envVar] of requiredDigestServices) {
    const block = services.get(serviceName);
    if (!block) {
      violations.push(`infra/deploy/compose.release.yml: missing required service "${serviceName}"`);
      continue;
    }
    const imagePattern = new RegExp(`^\\s+image:\\s*\\$\\{${envVar}:\\?[^}]+\\}\\s*$`, "m");
    if (!imagePattern.test(block)) {
      violations.push(
        `infra/deploy/compose.release.yml: service "${serviceName}" must pin image to required \${${envVar}:?...} digest variable`,
      );
    }
    if (/^\s+build:\s*\n\s+context:/m.test(block)) {
      violations.push(
        `infra/deploy/compose.release.yml: service "${serviceName}" must not configure local build context fallback`,
      );
    }
  }

  const backupBlock = services.get("backup-scheduler") ?? "";
  if (backupBlock && !/^\s+profiles:\s*\[backup\]\s*$/m.test(backupBlock)) {
    violations.push('infra/deploy/compose.release.yml: service "backup-scheduler" must declare profiles: [backup]');
  }

  for (const [serviceName, block] of services.entries()) {
    if (/^\s+ports:/m.test(block)) {
      violations.push(
        `infra/deploy/compose.release.yml: service "${serviceName}" must not publish additional host ports`,
      );
    }
  }

  const appBlock = services.get("app") ?? "";
  const requiredDisabledFlags = [
    "SOP_WORKFLOW_PROBE_ENABLED",
    "SOP_LOCAL_STORAGE_FIXTURE_ENABLED",
    "SOP_LOCAL_EMBEDDING_FIXTURE_ENABLED",
    "SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED",
    "SOP_LOCAL_ANSWER_FIXTURE_ENABLED",
  ];
  for (const flag of requiredDisabledFlags) {
    if (!new RegExp(`^\\s+${flag}:\\s*"0"\\s*$`, "m").test(appBlock)) {
      violations.push(`infra/deploy/compose.release.yml: app must force ${flag}: "0"`);
    }
  }

  for (const serviceName of ["app", "proxy", "postgres", "redis"]) {
    const block = services.get(serviceName) ?? "";
    if (!/^\s+restart:\s*unless-stopped\s*$/m.test(block)) {
      violations.push(
        `infra/deploy/compose.release.yml: service "${serviceName}" must set restart: unless-stopped`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

export function auditDeployWorkflow(content) {
  const violations = [];
  const sections = splitTopLevelSections(content);

  const onText = (sections.get("on") ?? []).join("\n");
  if (!/\bworkflow_dispatch\s*:/.test(onText)) {
    violations.push(".github/workflows/deploy.yml: trigger must declare workflow_dispatch");
  }
  for (const forbiddenTrigger of ["push", "pull_request", "pull_request_target", "schedule"]) {
    if (new RegExp(`^\\s+${forbiddenTrigger}\\s*:`, "m").test(onText)) {
      violations.push(
        `.github/workflows/deploy.yml: trigger must be workflow_dispatch only (forbidden "${forbiddenTrigger}")`,
      );
    }
  }

  if (!/^permissions:\s*\{\}\s*$/m.test(content)) {
    violations.push(".github/workflows/deploy.yml: top-level permissions must be restricted to {}");
  }

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const usesMatch = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line);
    if (usesMatch) {
      const actionRef = usesMatch[1];
      if (!/@[a-f0-9]{40}$/.test(actionRef)) {
        violations.push(
          `.github/workflows/deploy.yml:${index + 1}: action "${actionRef}" must be pinned to a full 40-hex commit SHA`,
        );
      }
    }
    if (/\becho\b.*secrets\./.test(line)) {
      violations.push(
        `.github/workflows/deploy.yml:${index + 1}: workflow must never echo secret values`,
      );
    }
  }

  for (const lineNumber of findInlineInputsInRunBlocks(content)) {
    violations.push(
      `.github/workflows/deploy.yml:${lineNumber}: must pass workflow inputs via env rather than interpolating \${{ inputs.* }} inside run:`,
    );
  }

  if (/:latest(?:\s|$|["'])/.test(content)) {
    violations.push(".github/workflows/deploy.yml: must not push or reference mutable :latest image tags");
  }

  const jobs = splitNamedBlocks(sections.get("jobs") ?? []);
  const requiredJobs = [
    "verify-candidate",
    "build-immutable-artifacts",
    "deploy-nonprod",
    "deploy-production",
  ];
  for (const jobName of requiredJobs) {
    if (!jobs.has(jobName)) {
      violations.push(`.github/workflows/deploy.yml: missing required job "${jobName}"`);
    }
  }

  const buildNeeds = parseJobNeeds(jobs.get("build-immutable-artifacts") ?? "");
  if (!buildNeeds.has("verify-candidate")) {
    violations.push(
      '.github/workflows/deploy.yml: "build-immutable-artifacts" must depend on "verify-candidate"',
    );
  }

  const nonprodJob = jobs.get("deploy-nonprod") ?? "";
  const nonprodNeeds = parseJobNeeds(nonprodJob);
  if (!nonprodNeeds.has("verify-candidate") || !nonprodNeeds.has("build-immutable-artifacts")) {
    violations.push(
      '.github/workflows/deploy.yml: "deploy-nonprod" must require verify-candidate and build-immutable-artifacts',
    );
  }
  if (!/^\s+environment:\s*staging\s*$/m.test(nonprodJob)) {
    violations.push('.github/workflows/deploy.yml: "deploy-nonprod" must target environment: staging');
  }

  const prodJob = jobs.get("deploy-production") ?? "";
  const prodNeeds = parseJobNeeds(prodJob);
  for (const dep of ["verify-candidate", "build-immutable-artifacts", "deploy-nonprod"]) {
    if (!prodNeeds.has(dep)) {
      violations.push(
        `.github/workflows/deploy.yml: "deploy-production" must require "${dep}" in needs`,
      );
    }
  }
  if (!/^\s+environment:\s*production\s*$/m.test(prodJob)) {
    violations.push(
      '.github/workflows/deploy.yml: "deploy-production" must enforce manual gate via environment: production',
    );
  }
  if (!prodJob.includes("inputs.target_environment == 'production'")) {
    violations.push(
      '.github/workflows/deploy.yml: "deploy-production" must guard execution with inputs.target_environment == \'production\'',
    );
  }
  if (!prodJob.includes("inputs.v01_candidate_sha") || !prodJob.includes("github.sha")) {
    violations.push(
      '.github/workflows/deploy.yml: "deploy-production" must verify inputs.v01_candidate_sha against github.sha',
    );
  }

  return { ok: violations.length === 0, violations };
}

export function verifyHardening(rootDir = process.cwd()) {
  const violations = [];
  const checkedFiles = [];

  const dockerfilePath = join(rootDir, "Dockerfile");
  checkedFiles.push("Dockerfile");
  violations.push(...auditDockerfile(readFileSync(dockerfilePath, "utf8")).violations);

  const composePath = join(rootDir, "docker-compose.yml");
  checkedFiles.push("docker-compose.yml");
  violations.push(...auditCompose(readFileSync(composePath, "utf8")).violations);

  const backupDockerfilePath = join(rootDir, "infra", "backup", "Dockerfile");
  checkedFiles.push("infra/backup/Dockerfile");
  violations.push(...auditBackupDockerfile(readFileSync(backupDockerfilePath, "utf8")).violations);

  const backupComposePath = join(rootDir, "infra", "backup", "compose.backup.yml");
  checkedFiles.push("infra/backup/compose.backup.yml");
  violations.push(...auditBackupCompose(readFileSync(backupComposePath, "utf8")).violations);

  const releaseComposePath = join(rootDir, "infra", "deploy", "compose.release.yml");
  checkedFiles.push("infra/deploy/compose.release.yml");
  violations.push(...auditReleaseCompose(readFileSync(releaseComposePath, "utf8")).violations);

  const deployWorkflowPath = join(rootDir, ".github", "workflows", "deploy.yml");
  checkedFiles.push(".github/workflows/deploy.yml");
  violations.push(...auditDeployWorkflow(readFileSync(deployWorkflowPath, "utf8")).violations);

  const nginxPath = join(rootDir, "infra", "proxy", "nginx.conf");
  checkedFiles.push("infra/proxy/nginx.conf");
  violations.push(...auditNginx(readFileSync(nginxPath, "utf8")).violations);

  const n8nDir = join(rootDir, "n8n");
  const workflowFiles = readdirSync(n8nDir).filter((name) => name.endsWith(".json")).sort();
  if (workflowFiles.length === 0) {
    violations.push("n8n: expected at least one versioned workflow JSON file");
  }
  for (const fileName of workflowFiles) {
    const relativePath = `n8n/${fileName}`;
    checkedFiles.push(relativePath);
    const parsed = JSON.parse(readFileSync(join(n8nDir, fileName), "utf8"));
    violations.push(...auditN8nWorkflow(relativePath, parsed).violations);
  }

  return {
    ok: violations.length === 0,
    checkedFiles,
    violationCount: violations.length,
    violations,
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = verifyHardening(process.cwd());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
