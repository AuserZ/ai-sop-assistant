import { statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const DEFAULT_THRESHOLDS = Object.freeze({
  diskFreePercentMin: 15,
  diskFreePercentCritical: 5,
  heapRatioMax: 0.85,
  heapRatioCritical: 0.95,
  failedJobsMax: 5,
});

const REQUEST_TIMEOUT_MS = 5_000;

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

function roundNumber(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function collectHostMetrics(diskPath = process.cwd()) {
  const mem = process.memoryUsage();
  const heapRatio = mem.heapTotal > 0 ? roundNumber(mem.heapUsed / mem.heapTotal, 4) : 0;
  let disk = null;

  try {
    const stats = statfsSync(diskPath);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail) * blockSize;
    const freePercent = totalBytes > 0 ? roundNumber((freeBytes / totalBytes) * 100, 2) : 0;
    disk = {
      path: diskPath,
      totalBytes,
      freeBytes,
      freePercent,
    };
  } catch {
    disk = null;
  }

  return {
    disk,
    memory: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      heapRatio,
      systemFreeBytes: freemem(),
      systemTotalBytes: totalmem(),
    },
  };
}

function extractFailedJobCount(opsData) {
  const failed = opsData?.queues?.workflowJobs?.FAILED;
  return typeof failed === "number" && Number.isFinite(failed) ? failed : null;
}

function extractStaleLeaseCount(opsData) {
  const staleLeases = opsData?.queues?.staleLeases;
  return typeof staleLeases === "number" && Number.isFinite(staleLeases) ? staleLeases : null;
}

function extractDeletionCleanupFailedCount(opsData) {
  const cleanupFailed = opsData?.queues?.deletionCleanupFailed;
  return typeof cleanupFailed === "number" && Number.isFinite(cleanupFailed) ? cleanupFailed : null;
}

function extractAppHeapRatio(opsData) {
  const used = opsData?.process?.heapUsedBytes;
  const total = opsData?.process?.heapTotalBytes;
  if (typeof used === "number" && Number.isFinite(used) && typeof total === "number" && Number.isFinite(total) && total > 0) {
    return roundNumber(used / total, 4);
  }
  return null;
}

function extractDegradedProviders(opsData) {
  const providers = opsData?.metrics?.providers;
  if (!providers || typeof providers !== "object") return [];

  const degraded = new Set();
  for (const [name, counters] of Object.entries(providers)) {
    if (!counters || typeof counters !== "object") continue;
    const transientError =
      typeof counters.transientError === "number" && Number.isFinite(counters.transientError)
        ? counters.transientError
        : 0;
    const rejected =
      typeof counters.rejected === "number" && Number.isFinite(counters.rejected) ? counters.rejected : 0;
    const invalidOutput =
      typeof counters.invalidOutput === "number" && Number.isFinite(counters.invalidOutput)
        ? counters.invalidOutput
        : 0;
    if (transientError + rejected + invalidOutput > 0) {
      const safeName = /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : "unknown_provider";
      degraded.add(safeName);
    }
  }
  return [...degraded].sort();
}

export function evaluateOpsSnapshot(snapshot, overrides = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  const alerts = [];

  if (snapshot.live && !snapshot.live.ok) {
    alerts.push({
      severity: "critical",
      code: "LIVENESS_FAILED",
      message: "Application liveness probe failed",
    });
  }

  if (snapshot.ready && !snapshot.ready.ok) {
    alerts.push({
      severity: "critical",
      code: "READINESS_FAILED",
      message: "Application readiness probe failed (database or pgvector unavailable)",
    });
  }

  if (snapshot.ops) {
    if (!snapshot.ops.ok) {
      const severity = (snapshot.ops.statusCode ?? 500) >= 500 ? "critical" : "degraded";
      alerts.push({
        severity,
        code: "OPS_ENDPOINT_UNAVAILABLE",
        message: `Admin ops health endpoint returned HTTP ${snapshot.ops.statusCode ?? "error"}`,
      });
    } else if (snapshot.ops.data) {
      const opsData = snapshot.ops.data;
      const db = opsData.database;
      let opsHasCritical = false;

      if (db && db.ok === false) {
        opsHasCritical = true;
        alerts.push({
          severity: "critical",
          code: "DATABASE_UNHEALTHY",
          message: "Database check reported unhealthy in ops snapshot",
        });
      }
      if (db && db.pgvectorOk === false) {
        opsHasCritical = true;
        alerts.push({
          severity: "critical",
          code: "PGVECTOR_UNHEALTHY",
          message: "pgvector readiness check failed in ops snapshot",
        });
      }

      const failedJobs = extractFailedJobCount(opsData);
      if (failedJobs !== null && failedJobs > thresholds.failedJobsMax) {
        alerts.push({
          severity: "degraded",
          code: "FAILED_JOBS_THRESHOLD",
          message: `Failed workflow jobs (${failedJobs}) exceed threshold (${thresholds.failedJobsMax})`,
        });
      }

      const staleLeases = extractStaleLeaseCount(opsData);
      if (staleLeases !== null && staleLeases > 0) {
        alerts.push({
          severity: "degraded",
          code: "STALE_JOB_LEASES",
          message: `Stale workflow job leases detected (${staleLeases})`,
        });
      }

      const deletionCleanupFailed = extractDeletionCleanupFailedCount(opsData);
      if (deletionCleanupFailed !== null && deletionCleanupFailed > 0) {
        alerts.push({
          severity: "degraded",
          code: "DELETION_CLEANUP_FAILED",
          message: `Failed document deletion cleanups detected (${deletionCleanupFailed})`,
        });
      }

      const degradedProviders = extractDegradedProviders(opsData);
      for (const providerName of degradedProviders) {
        alerts.push({
          severity: "degraded",
          code: "PROVIDER_FAULT",
          message: `Provider "${providerName}" recorded error, rejection, or invalid output counters`,
        });
      }

      const appHeapRatio = extractAppHeapRatio(opsData);
      if (appHeapRatio !== null && appHeapRatio >= thresholds.heapRatioMax) {
        const isCritical = appHeapRatio >= thresholds.heapRatioCritical;
        if (isCritical) opsHasCritical = true;
        alerts.push({
          severity: isCritical ? "critical" : "degraded",
          code: "APP_HEAP_USAGE_HIGH",
          message: isCritical
            ? `Application heap ratio (${appHeapRatio}) reached critical limit (${thresholds.heapRatioCritical})`
            : `Application heap ratio (${appHeapRatio}) reached warning threshold (${thresholds.heapRatioMax})`,
        });
      }

      if (opsData.status === "degraded" && !opsHasCritical) {
        alerts.push({
          severity: "degraded",
          code: "OPS_STATUS_DEGRADED",
          message: "Admin ops health snapshot reported degraded status",
        });
      }
    }
  }

  const disk = snapshot.host?.disk ?? null;
  if (disk && typeof disk.freePercent === "number" && Number.isFinite(disk.freePercent)) {
    if (disk.freePercent < thresholds.diskFreePercentCritical) {
      alerts.push({
        severity: "critical",
        code: "DISK_SPACE_CRITICAL",
        message: `Free disk space (${disk.freePercent}%) is below critical floor (${thresholds.diskFreePercentCritical}%)`,
      });
    } else if (disk.freePercent < thresholds.diskFreePercentMin) {
      alerts.push({
        severity: "degraded",
        code: "DISK_SPACE_LOW",
        message: `Free disk space (${disk.freePercent}%) is below warning threshold (${thresholds.diskFreePercentMin}%)`,
      });
    }
  }

  const memory = snapshot.host?.memory ?? null;
  if (memory && typeof memory.heapRatio === "number" && Number.isFinite(memory.heapRatio)) {
    if (memory.heapRatio >= thresholds.heapRatioCritical) {
      alerts.push({
        severity: "critical",
        code: "HEAP_USAGE_CRITICAL",
        message: `Process heap ratio (${memory.heapRatio}) reached critical limit (${thresholds.heapRatioCritical})`,
      });
    } else if (memory.heapRatio >= thresholds.heapRatioMax) {
      alerts.push({
        severity: "degraded",
        code: "HEAP_USAGE_HIGH",
        message: `Process heap ratio (${memory.heapRatio}) reached warning threshold (${thresholds.heapRatioMax})`,
      });
    }
  }

  let status = "ok";
  if (alerts.some((alert) => alert.severity === "critical")) {
    status = "critical";
  } else if (alerts.some((alert) => alert.severity === "degraded")) {
    status = "degraded";
  }

  // Output allowlisted operational fields only; never echo cookies, URLs with query strings, or raw bodies.
  const redactedChecks = {
    live: snapshot.live
      ? { ok: Boolean(snapshot.live.ok), statusCode: snapshot.live.statusCode ?? null, latencyMs: snapshot.live.latencyMs ?? null }
      : null,
    ready: snapshot.ready
      ? { ok: Boolean(snapshot.ready.ok), statusCode: snapshot.ready.statusCode ?? null, latencyMs: snapshot.ready.latencyMs ?? null }
      : null,
    ops: snapshot.ops
      ? {
          ok: Boolean(snapshot.ops.ok),
          statusCode: snapshot.ops.statusCode ?? null,
          latencyMs: snapshot.ops.latencyMs ?? null,
          opsStatus: typeof snapshot.ops.data?.status === "string" ? snapshot.ops.data.status : null,
          failedJobs: extractFailedJobCount(snapshot.ops.data),
          staleLeases: extractStaleLeaseCount(snapshot.ops.data),
          deletionCleanupFailed: extractDeletionCleanupFailedCount(snapshot.ops.data),
          appHeapRatio: extractAppHeapRatio(snapshot.ops.data),
          degradedProviders: extractDegradedProviders(snapshot.ops.data),
        }
      : null,
  };

  return {
    status,
    observedAt: snapshot.observedAt ?? new Date().toISOString(),
    checks: redactedChecks,
    host: {
      disk: disk ? { freePercent: disk.freePercent, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes } : null,
      memory: memory
        ? {
            rssBytes: memory.rssBytes,
            heapUsedBytes: memory.heapUsedBytes,
            heapTotalBytes: memory.heapTotalBytes,
            heapRatio: memory.heapRatio,
          }
        : null,
    },
    thresholds,
    alerts,
  };
}

function parseBaseUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL must not embed credentials");
  }
  return parsed.origin;
}

async function probeEndpoint(origin, pathname, headers = {}) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${origin}${pathname}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const latencyMs = roundNumber(performance.now() - startedAt, 2);
    let data = null;
    if (response.ok) {
      data = await response.json().catch(() => null);
    }
    return {
      ok: response.ok,
      statusCode: response.status,
      latencyMs,
      data,
    };
  } catch {
    return {
      ok: false,
      statusCode: 0,
      latencyMs: roundNumber(performance.now() - startedAt, 2),
      data: null,
    };
  }
}

function parseCliOptions(argv) {
  const options = {
    baseUrl: "http://127.0.0.1:3000",
    diskPath: process.cwd(),
    localOnly: false,
    thresholds: {},
  };

  for (const arg of argv) {
    if (arg === "--local-only") {
      options.localOnly = true;
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
    } else if (arg.startsWith("--disk-path=")) {
      options.diskPath = arg.slice("--disk-path=".length);
    } else if (arg.startsWith("--disk-free-min=")) {
      options.thresholds.diskFreePercentMin = Number(arg.slice("--disk-free-min=".length));
    } else if (arg.startsWith("--heap-ratio-max=")) {
      options.thresholds.heapRatioMax = Number(arg.slice("--heap-ratio-max=".length));
    } else if (arg.startsWith("--failed-jobs-max=")) {
      options.thresholds.failedJobsMax = Number(arg.slice("--failed-jobs-max=".length));
    }
  }
  return options;
}

async function runCli() {
  const options = parseCliOptions(process.argv.slice(2));
  const snapshot = {
    observedAt: new Date().toISOString(),
    live: null,
    ready: null,
    ops: null,
    host: collectHostMetrics(options.diskPath),
  };

  if (!options.localOnly) {
    const origin = parseBaseUrl(options.baseUrl);
    snapshot.live = await probeEndpoint(origin, "/api/health/live");
    snapshot.ready = await probeEndpoint(origin, "/api/health/ready");

    const opsCookie = process.env.SOP_OPS_COOKIE;
    const opsHeaderName = process.env.SOP_OPS_HEADER_NAME;
    const opsHeaderValue = process.env.SOP_OPS_HEADER_VALUE;
    if (opsCookie || (opsHeaderName && opsHeaderValue)) {
      const headers = {};
      if (opsCookie) headers.Cookie = opsCookie;
      if (opsHeaderName && opsHeaderValue) headers[opsHeaderName] = opsHeaderValue;
      snapshot.ops = await probeEndpoint(origin, "/api/health/ops", headers);
    }
  }

  const report = evaluateOpsSnapshot(snapshot, options.thresholds);
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "critical") {
    process.exitCode = 1;
  } else if (report.status === "degraded") {
    process.exitCode = 2;
  }
}

if (isDirectExecution(import.meta.url)) {
  runCli().catch((error) => {
    console.error(JSON.stringify({ status: "critical", error: error instanceof Error ? error.message : "Monitor failed" }));
    process.exitCode = 1;
  });
}
