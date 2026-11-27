import { describe, expect, it } from "vitest";
import {
  auditCompose,
  auditDockerfile,
  auditN8nWorkflow,
  auditNginx,
  verifyHardening,
} from "../../scripts/verify-hardening.mjs";
import { scanArtifacts, scanTextForLeaks } from "../../scripts/security-scan-artifacts.mjs";
import {
  collectHostMetrics,
  DEFAULT_THRESHOLDS,
  evaluateOpsSnapshot,
} from "../../scripts/ops-monitor.mjs";
import {
  ASSUMPTIONS_NOTICE,
  runBoundedConcurrency,
  summarizeLatencySamples,
} from "../../scripts/load-benchmark.mjs";

describe("S14 infrastructure hardening verification (ADR 13/15)", () => {
  it("passes hardening verification against the real repository manifests", () => {
    const result = verifyHardening(process.cwd());
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.checkedFiles).toEqual(
      expect.arrayContaining([
        "Dockerfile",
        "docker-compose.yml",
        "infra/proxy/nginx.conf",
        "n8n/s03-probe.v1.json",
        "n8n/s05-ingestion.v1.json",
        "n8n/s11-chat.v1.json",
      ]),
    );
  });

  it("rejects unpinned base images and root runtime users in Dockerfile", () => {
    const insecureDockerfile = [
      "FROM node:24-bookworm-slim AS dependencies",
      "FROM node:24-bookworm-slim AS runtime",
      "USER root",
      'CMD ["node", "server.js"]',
    ].join("\n");

    const audit = auditDockerfile(insecureDockerfile);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((item) => item.includes("@sha256"))).toBe(true);
    expect(audit.violations.some((item) => item.includes("non-root USER"))).toBe(true);
  });

  it("rejects exposed internal service ports, missing no-logging on OCR, and missing n8n pruning", () => {
    const insecureCompose = `
services:
  postgres:
    image: postgres:18
    ports: ["0.0.0.0:5432:5432"]
  proxy:
    image: nginx:1.30
    ports: ["0.0.0.0:3000:8080"]
  paddleocr:
    image: paddleocr:local
    logging:
      driver: json-file
networks:
  database:
  workflow:
`;
    const audit = auditCompose(insecureCompose);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((item) => item.includes('service "postgres" must not publish host ports'))).toBe(true);
    expect(audit.violations.some((item) => item.includes("loopback 127.0.0.1"))).toBe(true);
    expect(audit.violations.some((item) => item.includes('service "paddleocr" must keep logging driver: none'))).toBe(true);
    expect(audit.violations.some((item) => item.includes("EXECUTIONS_DATA_PRUNE"))).toBe(true);
  });

  it("rejects nginx configs missing server_tokens off, internal route block, or security headers", () => {
    const insecureNginx = `
http {
  server {
    listen 8080;
    location / {
      proxy_pass http://app:3000;
    }
  }
}
`;
    const audit = auditNginx(insecureNginx);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((item) => item.includes("server_tokens off"))).toBe(true);
    expect(audit.violations.some((item) => item.includes("/api/internal/"))).toBe(true);
    expect(audit.violations.some((item) => item.includes("X-Frame-Options"))).toBe(true);
  });

  it("rejects n8n workflows that save execution data, use excluded nodes, or follow redirects", () => {
    const insecureWorkflow = {
      settings: {
        saveDataErrorExecution: "all",
        saveDataSuccessExecution: "all",
        saveManualExecutions: true,
        saveExecutionProgress: true,
      },
      nodes: [
        { name: "Bad code node", type: "n8n-nodes-base.code", parameters: {} },
        { name: "Open webhook", type: "n8n-nodes-base.webhook", parameters: { authentication: "none" } },
        { name: "Open http", type: "n8n-nodes-base.httpRequest", parameters: { options: {} } },
      ],
    };

    const audit = auditN8nWorkflow("n8n/bad.json", insecureWorkflow);
    expect(audit.ok).toBe(false);
    expect(audit.violations.some((item) => item.includes("saveDataErrorExecution"))).toBe(true);
    expect(audit.violations.some((item) => item.includes("excluded type"))).toBe(true);
    expect(audit.violations.some((item) => item.includes("jwtAuth"))).toBe(true);
    expect(audit.violations.some((item) => item.includes("followRedirects: false"))).toBe(true);
  });
});

describe("S14 artifact and bundle leak scanner (PRD section 12)", () => {
  it("reports zero findings across real repository artifacts and workflow exports", () => {
    const result = scanArtifacts(process.cwd());
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.scannedFiles).toBeGreaterThan(0);
  });

  it("detects private keys, provider API keys, presigned URLs, DB URLs with passwords, and benchmark passages without echoing secret values", () => {
    const syntheticPrivateKey = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const syntheticOpenAiKey = ["sk-proj", "syntheticLeakToken1234567890"].join("-");
    const syntheticResendKey = ["re", "AbCdEfGhIjKlMnOpQrStUvWxYz"].join("_");
    const syntheticPresigned = "https://bucket.example.invalid/doc.pdf?X-Amz-Signature=deadbeef123456";
    const syntheticDbUrl = "postgresql://sop_runtime:leakedPass99@postgres:5432/sop_app";
    const syntheticPassage = "SOP-101 Section 1 Pre-Cycle Chamber Inspection";

    const samples = [
      { text: syntheticPrivateKey, expectedRule: "PRIVATE_KEY_PEM", forbiddenValue: "PRIVATE KEY" },
      { text: `token=${syntheticOpenAiKey}`, expectedRule: "API_KEY_SK", forbiddenValue: syntheticOpenAiKey },
      { text: `key=${syntheticResendKey}`, expectedRule: "API_KEY_RESEND", forbiddenValue: syntheticResendKey },
      { text: syntheticPresigned, expectedRule: "PRESIGNED_URL_SIGNATURE", forbiddenValue: "deadbeef123456" },
      { text: syntheticDbUrl, expectedRule: "DATABASE_URL_CREDENTIALS", forbiddenValue: "leakedPass99" },
      { text: `bundle="${syntheticPassage}"`, expectedRule: "BENCHMARK_PASSAGE_LEAK", forbiddenValue: syntheticPassage },
    ];

    for (const sample of samples) {
      const findings = scanTextForLeaks(sample.text, { file: "synthetic-artifact.js" });
      expect(findings.some((finding) => finding.ruleId === sample.expectedRule)).toBe(true);
      const serialized = JSON.stringify(findings);
      expect(serialized).not.toContain(sample.forbiddenValue);
    }
  });

  it("does not false-positive on clean text or JS template PostgreSQL URL builders", () => {
    const cleanSource = [
      "const status = 'ready';",
      "const url = `postgresql://${user}:${encodeURIComponent(password)}@${host}/sop_app`;",
      "const note = 'Pattern checks cover sk-* and X-Amz-Signature names.';",
    ].join("\n");

    expect(scanTextForLeaks(cleanSource, { file: "src/clean.ts" })).toEqual([]);
  });
});

describe("S14 operator health monitoring thresholds (PRD sections 13–14)", () => {
  const healthyOpsPayload = {
    status: "ok",
    checkedAt: "2026-11-27T08:00:00.000Z",
    traceId: "trace-ops-healthy",
    database: { ok: true, pgvectorOk: true, latencyMs: 3 },
    queues: {
      workflowJobs: { QUEUED: 1, RUNNING: 1, COMPLETED: 12, FAILED: 0, WAITING_FOR_PIPELINE: 0 },
      staleLeases: 0,
      documentsByStatus: { ACTIVE: 2 },
      deletionCleanupPending: 0,
      deletionCleanupFailed: 0,
    },
    process: {
      nodeVersion: "v24.19.2",
      uptimeSeconds: 120,
      memoryRssBytes: 123_456_789,
      heapUsedBytes: 42_000_000,
      heapTotalBytes: 100_000_000,
    },
    metrics: {
      providers: {
        openai_embedding: { ok: 10, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 120 },
        paddleocr: { ok: 4, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
      },
      stages: {},
      ocr: { pagesTotal: 12, ocrPages: 4, failedPages: 0 },
    },
  };

  it("reports ok against the exact OperationalHealthSnapshot schema when all checks are healthy", () => {
    const report = evaluateOpsSnapshot({
      observedAt: "2026-11-27T08:00:00.000Z",
      live: { ok: true, statusCode: 200, latencyMs: 4.2 },
      ready: { ok: true, statusCode: 200, latencyMs: 8.1 },
      ops: {
        ok: true,
        statusCode: 200,
        latencyMs: 12.5,
        data: healthyOpsPayload,
      },
      host: {
        disk: { freePercent: 55, freeBytes: 50_000_000_000, totalBytes: 100_000_000_000 },
        memory: { rssBytes: 120_000_000, heapUsedBytes: 40_000_000, heapTotalBytes: 100_000_000, heapRatio: 0.4 },
      },
    });

    expect(report.status).toBe("ok");
    expect(report.alerts).toEqual([]);
    expect(report.thresholds).toEqual(DEFAULT_THRESHOLDS);
    expect(report.checks.ops).toMatchObject({
      ok: true,
      opsStatus: "ok",
      failedJobs: 0,
      staleLeases: 0,
      deletionCleanupFailed: 0,
      appHeapRatio: 0.42,
      degradedProviders: [],
    });
  });

  it("raises degraded alerts for OperationalHealthSnapshot queue, stale lease, cleanup, provider, heap, status, and host faults", () => {
    const report = evaluateOpsSnapshot(
      {
        observedAt: "2026-11-27T08:00:00.000Z",
        live: { ok: true, statusCode: 200, latencyMs: 3 },
        ready: { ok: true, statusCode: 200, latencyMs: 7 },
        ops: {
          ok: true,
          statusCode: 200,
          latencyMs: 15,
          data: {
            ...healthyOpsPayload,
            status: "degraded",
            queues: {
              ...healthyOpsPayload.queues,
              workflowJobs: { QUEUED: 2, RUNNING: 1, FAILED: 9, WAITING_FOR_PIPELINE: 0 },
              staleLeases: 2,
              deletionCleanupFailed: 1,
            },
            process: {
              ...healthyOpsPayload.process,
              heapUsedBytes: 88_000_000,
              heapTotalBytes: 100_000_000,
            },
            metrics: {
              ...healthyOpsPayload.metrics,
              providers: {
                openai_embedding: { ok: 10, transientError: 2, rejected: 0, invalidOutput: 0, tokensTotal: 120 },
                openai_judge: { ok: 5, transientError: 0, rejected: 1, invalidOutput: 1, tokensTotal: 300 },
                paddleocr: { ok: 4, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
              },
            },
          },
        },
        host: {
          disk: { freePercent: 10, freeBytes: 10_000_000_000, totalBytes: 100_000_000_000 },
          memory: { rssBytes: 400_000_000, heapUsedBytes: 88_000_000, heapTotalBytes: 100_000_000, heapRatio: 0.88 },
        },
      },
      { diskFreePercentMin: 15, heapRatioMax: 0.85, failedJobsMax: 5 },
    );

    expect(report.status).toBe("degraded");
    const codes = report.alerts.map((alert) => alert.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "OPS_STATUS_DEGRADED",
        "FAILED_JOBS_THRESHOLD",
        "STALE_JOB_LEASES",
        "DELETION_CLEANUP_FAILED",
        "PROVIDER_FAULT",
        "APP_HEAP_USAGE_HIGH",
        "DISK_SPACE_LOW",
        "HEAP_USAGE_HIGH",
      ]),
    );
    expect(report.checks.ops?.degradedProviders).toEqual(["openai_embedding", "openai_judge"]);
    expect(report.checks.ops?.appHeapRatio).toBe(0.88);
  });

  it("raises critical alerts for pgvector/DB unhealthy, critical app heap ratio, readiness 503, and critically low disk", () => {
    const report = evaluateOpsSnapshot({
      observedAt: "2026-11-27T08:00:00.000Z",
      live: { ok: true, statusCode: 200, latencyMs: 3 },
      ready: { ok: false, statusCode: 503, latencyMs: 25 },
      ops: {
        ok: true,
        statusCode: 200,
        latencyMs: 22,
        data: {
          ...healthyOpsPayload,
          status: "degraded",
          database: { ok: false, pgvectorOk: false, latencyMs: 20 },
          process: {
            ...healthyOpsPayload.process,
            heapUsedBytes: 96_000_000,
            heapTotalBytes: 100_000_000,
          },
        },
      },
      host: {
        disk: { freePercent: 3.5, freeBytes: 3_500_000_000, totalBytes: 100_000_000_000 },
        memory: { rssBytes: 100_000_000, heapUsedBytes: 30_000_000, heapTotalBytes: 100_000_000, heapRatio: 0.3 },
      },
    });

    expect(report.status).toBe("critical");
    const codes = report.alerts.map((alert) => alert.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "READINESS_FAILED",
        "DATABASE_UNHEALTHY",
        "PGVECTOR_UNHEALTHY",
        "APP_HEAP_USAGE_HIGH",
        "DISK_SPACE_CRITICAL",
      ]),
    );
    expect(codes).not.toContain("OPS_STATUS_DEGRADED");
    expect(report.alerts.find((alert) => alert.code === "APP_HEAP_USAGE_HIGH")?.severity).toBe("critical");
  });

  it("collects real local host memory and disk metrics without throwing", () => {
    const metrics = collectHostMetrics(process.cwd());
    expect(metrics.memory.rssBytes).toBeGreaterThan(0);
    expect(metrics.memory.heapTotalBytes).toBeGreaterThan(0);
    if (metrics.disk) {
      expect(metrics.disk.totalBytes).toBeGreaterThan(0);
      expect(metrics.disk.freePercent).toBeGreaterThanOrEqual(0);
      expect(metrics.disk.freePercent).toBeLessThanOrEqual(100);
    }
  });
});

describe("S14 bounded-concurrency load benchmark runner (PRD sections 13 & 16)", () => {
  it("computes accurate min, mean, p50, p95, p99, and max latency summaries", () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    const summary = summarizeLatencySamples(samples);
    expect(summary).toEqual({
      count: 100,
      minMs: 1,
      maxMs: 100,
      meanMs: 50.5,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
    });
    expect(summarizeLatencySamples([])).toEqual({
      count: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    });
  });

  it("enforces bounded concurrency, tracks failures, and emits the explicit planning assumptions notice", async () => {
    let active = 0;
    let observedMaxActive = 0;

    const result = await runBoundedConcurrency({
      totalRequests: 15,
      concurrency: 3,
      worker: async (index: number) => {
        active += 1;
        if (active > observedMaxActive) observedMaxActive = active;
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 2));
        active -= 1;
        if (index % 5 === 0) {
          throw new Error("synthetic failure");
        }
      },
    });

    expect(observedMaxActive).toBeLessThanOrEqual(3);
    expect(result.summary.peakInFlight).toBeLessThanOrEqual(3);
    expect(result.summary.succeeded).toBe(12);
    expect(result.summary.failed).toBe(3);
    expect(result.summary.errorRate).toBe(0.2);
    expect(result.latency.count).toBe(15);
    expect(result.assumptionsNotice).toBe(ASSUMPTIONS_NOTICE);
    expect(result.assumptionsNotice).toContain("20 MB");
    expect(result.assumptionsNotice).toContain("4 vCPU / 8 GB RAM");
  });

  it("rejects out-of-bounds concurrency or request counts", async () => {
    await expect(
      runBoundedConcurrency({ totalRequests: 0, concurrency: 2, worker: async () => undefined }),
    ).rejects.toThrow("totalRequests");
    await expect(
      runBoundedConcurrency({ totalRequests: 10, concurrency: 100, worker: async () => undefined }),
    ).rejects.toThrow("concurrency");
  });
});
