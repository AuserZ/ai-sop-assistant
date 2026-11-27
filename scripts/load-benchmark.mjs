import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const MAX_BENCHMARK_CONCURRENCY = 64;
export const MAX_BENCHMARK_REQUESTS = 5_000;

export const ASSUMPTIONS_NOTICE =
  "Planning assumptions only (PRD sections 13 & 16): 20 MB upload cap, 4 vCPU / 8 GB RAM VPS sizing, " +
  "and worker/OCR concurrency limits are unverified initial estimates and require real VPS load benchmarking before go-live.";

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

function percentile(sortedValues, rankFraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * rankFraction) - 1));
  return sortedValues[index];
}

export function summarizeLatencySamples(samplesMs) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  const cleaned = samplesMs.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error("Latency samples must be finite non-negative numbers");
    }
    return value;
  });
  const sorted = [...cleaned].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);

  return {
    count: sorted.length,
    minMs: roundNumber(sorted[0]),
    maxMs: roundNumber(sorted[sorted.length - 1]),
    meanMs: roundNumber(sum / sorted.length),
    p50Ms: roundNumber(percentile(sorted, 0.5)),
    p95Ms: roundNumber(percentile(sorted, 0.95)),
    p99Ms: roundNumber(percentile(sorted, 0.99)),
  };
}

export async function runBoundedConcurrency({ totalRequests, concurrency, worker }) {
  if (!Number.isInteger(totalRequests) || totalRequests < 1 || totalRequests > MAX_BENCHMARK_REQUESTS) {
    throw new Error(`totalRequests must be an integer between 1 and ${MAX_BENCHMARK_REQUESTS}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_BENCHMARK_CONCURRENCY) {
    throw new Error(`concurrency must be an integer between 1 and ${MAX_BENCHMARK_CONCURRENCY}`);
  }
  if (typeof worker !== "function") {
    throw new Error("worker must be a function");
  }

  const effectiveConcurrency = Math.min(concurrency, totalRequests);
  const latencies = [];
  let nextIndex = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let succeeded = 0;
  let failed = 0;

  const rssStartBytes = process.memoryUsage().rss;
  const startedAt = performance.now();

  async function runWorkerSlot() {
    while (true) {
      const requestIndex = nextIndex;
      nextIndex += 1;
      if (requestIndex >= totalRequests) return;

      inFlight += 1;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      const reqStart = performance.now();
      try {
        await worker(requestIndex);
        succeeded += 1;
      } catch {
        failed += 1;
      } finally {
        latencies.push(performance.now() - reqStart);
        inFlight -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: effectiveConcurrency }, () => runWorkerSlot()));

  const elapsedMs = Math.max(0.01, performance.now() - startedAt);
  const rssEndBytes = process.memoryUsage().rss;

  return {
    assumptionsNotice: ASSUMPTIONS_NOTICE,
    config: {
      totalRequests,
      requestedConcurrency: concurrency,
      effectiveConcurrency,
    },
    summary: {
      succeeded,
      failed,
      peakInFlight,
      elapsedMs: roundNumber(elapsedMs),
      throughputRps: roundNumber((totalRequests / elapsedMs) * 1000),
      errorRate: roundNumber(failed / totalRequests, 4),
    },
    latency: summarizeLatencySamples(latencies),
    memory: {
      rssStartBytes,
      rssEndBytes,
      rssDeltaBytes: rssEndBytes - rssStartBytes,
    },
  };
}

function parseCliOptions(argv) {
  const options = {
    mode: "synthetic",
    baseUrl: null,
    path: "/api/health/live",
    concurrency: 8,
    requests: 40,
    timeoutMs: 5_000,
  };

  for (const arg of argv) {
    if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
      options.mode = "http";
    } else if (arg.startsWith("--path=")) {
      options.path = arg.slice("--path=".length);
    } else if (arg.startsWith("--concurrency=")) {
      options.concurrency = Number(arg.slice("--concurrency=".length));
    } else if (arg.startsWith("--requests=")) {
      options.requests = Number(arg.slice("--requests=".length));
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    }
  }
  return options;
}

function buildTargetUrl(baseUrl, pathname) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Base URL must not embed credentials");
  }
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${parsed.origin}${normalizedPath}`;
}

async function runCli() {
  const options = parseCliOptions(process.argv.slice(2));
  let worker;

  if (options.mode === "synthetic") {
    worker = async (index) => {
      await delay(1 + (index % 4));
    };
  } else if (options.mode === "http") {
    const targetUrl = buildTargetUrl(options.baseUrl ?? "http://127.0.0.1:3000", options.path);
    worker = async () => {
      const response = await fetch(targetUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      await response.arrayBuffer();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    };
  } else {
    throw new Error(`Unsupported benchmark mode "${options.mode}"`);
  }

  const result = await runBoundedConcurrency({
    totalRequests: options.requests,
    concurrency: options.concurrency,
    worker,
  });

  console.log(JSON.stringify({ mode: options.mode, ...result }, null, 2));
  if (result.summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (isDirectExecution(import.meta.url)) {
  runCli().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Benchmark failed" }));
    process.exitCode = 1;
  });
}
