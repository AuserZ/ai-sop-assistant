import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCANNABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".md", ".css", ".html", ".txt"]);
const MAX_SCAN_FILE_BYTES = 10 * 1024 * 1024;
const PASSAGE_EXCERPT_LENGTH = 56;

const SECRET_RULES = [
  {
    id: "PRIVATE_KEY_PEM",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    message: "PEM private key marker detected",
  },
  {
    id: "API_KEY_SK",
    pattern: /\bsk-(?:proj|live)-[A-Za-z0-9_-]{8,}\b/g,
    message: "Provider secret key pattern (sk-proj-/sk-live-) detected",
  },
  {
    id: "API_KEY_RESEND",
    pattern: /\bre_[A-Za-z0-9]{20,}\b/g,
    message: "Resend API key pattern detected",
  },
  {
    id: "AWS_ACCESS_KEY_ID",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    message: "AWS access key ID pattern detected",
  },
  {
    id: "PRESIGNED_URL_SIGNATURE",
    pattern: /X-Amz-Signature=[A-Za-z0-9%._-]+/gi,
    message: "Presigned object storage query signature detected",
  },
  {
    id: "DATABASE_URL_CREDENTIALS",
    // Excludes JS template expressions like postgresql://${user}:${password}@host.
    pattern: /postgres(?:ql)?:\/\/[^/\s:'"`$]+:[^@\s'"`$]+@[^/\s'"`]+/gi,
    message: "Embedded database credentials in PostgreSQL connection URL detected",
  },
];

const DEFAULT_BENCHMARK_SENTINELS = [
  "SOP-101 Section 1 Pre-Cycle Chamber Inspection",
  "121.0 °C minimum exposure temperature at 1.15 bar gauge pressure",
  "Incubate Geobacillus stearothermophilus spore ampoule at 56.0 °C",
];

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

export function loadBenchmarkPassages(rootDir = process.cwd()) {
  const benchmarkPath = join(rootDir, "tests", "fixtures", "benchmark-50.json");
  if (!existsSync(benchmarkPath)) {
    return [...DEFAULT_BENCHMARK_SENTINELS];
  }
  const parsed = JSON.parse(readFileSync(benchmarkPath, "utf8"));
  const passages = new Set(DEFAULT_BENCHMARK_SENTINELS);
  for (const chunk of parsed?.chunks ?? []) {
    if (typeof chunk?.text === "string" && chunk.text.length >= PASSAGE_EXCERPT_LENGTH) {
      passages.add(chunk.text.slice(0, PASSAGE_EXCERPT_LENGTH));
    }
  }
  return [...passages];
}

export function scanTextForLeaks(text, context = {}) {
  const file = context.file ?? "<memory>";
  const checkPassages = context.checkPassages ?? true;
  const forbiddenPassages = context.forbiddenPassages ?? DEFAULT_BENCHMARK_SENTINELS;
  const findings = [];

  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(text);
    if (match) {
      findings.push({
        file,
        ruleId: rule.id,
        line: lineNumberAt(text, match.index),
        message: rule.message,
      });
    }
  }

  if (checkPassages) {
    for (const passage of forbiddenPassages) {
      if (!passage) continue;
      const foundIndex = text.indexOf(passage);
      if (foundIndex !== -1) {
        findings.push({
          file,
          ruleId: "BENCHMARK_PASSAGE_LEAK",
          line: lineNumberAt(text, foundIndex),
          message: "Raw synthetic SOP benchmark passage detected in non-fixture artifact",
        });
        break;
      }
    }
  }

  return findings;
}

function collectFiles(targetDir, results = []) {
  if (!existsSync(targetDir)) return results;
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    const fullPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, results);
    } else if (entry.isFile() && SCANNABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

export function scanArtifacts(rootDir = process.cwd()) {
  const benchmarkPassages = loadBenchmarkPassages(rootDir);
  const scanTargets = [
    { dir: join(rootDir, ".next", "static"), category: "client-bundle", checkPassages: true },
    { dir: join(rootDir, "n8n"), category: "workflow-export", checkPassages: true },
    { dir: join(rootDir, "docs", "verification"), category: "verification-doc", checkPassages: true },
    { dir: join(rootDir, "src"), category: "source", checkPassages: true },
  ];

  const findings = [];
  let scannedFiles = 0;
  const clientBundleDir = join(rootDir, ".next", "static");
  const clientBundleScanned = existsSync(clientBundleDir);

  for (const target of scanTargets) {
    const files = collectFiles(target.dir);
    for (const filePath of files) {
      const stats = statSync(filePath);
      if (stats.size > MAX_SCAN_FILE_BYTES) continue;
      scannedFiles += 1;
      const content = readFileSync(filePath, "utf8");
      const relPath = relative(rootDir, filePath).replaceAll("\\", "/");
      findings.push(
        ...scanTextForLeaks(content, {
          file: relPath,
          category: target.category,
          checkPassages: target.checkPassages,
          forbiddenPassages: benchmarkPassages,
        }),
      );
    }
  }

  return {
    ok: findings.length === 0,
    scannedFiles,
    clientBundleScanned,
    findingCount: findings.length,
    findings,
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = scanArtifacts(process.cwd());
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}
