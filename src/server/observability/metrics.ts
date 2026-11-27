export type TelemetryPipeline = "ingestion" | "retrieval" | "answer" | "chat";

export type TelemetryProvider =
  | "openai_embedding"
  | "openai_retrieval"
  | "openai_answer"
  | "openai_judge"
  | "paddleocr"
  | "conversion"
  | "storage"
  | "resend";

export type ProviderOutcome = "ok" | "transient_error" | "rejected" | "invalid_output";

export type StageTimingSummary = {
  count: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
};

export type OcrMetricsSummary = {
  runsTotal: number;
  pagesTotal: number;
  ocrPagesTotal: number;
  failedRuns: number;
};

export type ProviderMetricsSummary = {
  ok: number;
  transientError: number;
  rejected: number;
  invalidOutput: number;
  tokensTotal: number;
};

export type OperationalMetricsSnapshot = {
  stages: Record<string, StageTimingSummary>;
  ocr: OcrMetricsSummary;
  providers: Record<TelemetryProvider, ProviderMetricsSummary>;
  process: {
    uptimeSeconds: number;
    memoryRssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
};

export const maxStageTimingSamples = 200;
const maxTrackedStageKeys = 64;
const stageNamePattern = /^[a-z0-9_.-]{1,48}$/i;

const allProviders: readonly TelemetryProvider[] = [
  "openai_embedding",
  "openai_retrieval",
  "openai_answer",
  "openai_judge",
  "paddleocr",
  "conversion",
  "storage",
  "resend",
];

type StageRingBuffer = {
  count: number;
  samples: number[];
  nextIndex: number;
  maxMs: number;
};

const stageBuffers = new Map<string, StageRingBuffer>();

let ocrState: OcrMetricsSummary = {
  runsTotal: 0,
  pagesTotal: 0,
  ocrPagesTotal: 0,
  failedRuns: 0,
};

function createEmptyProviderState(): Record<TelemetryProvider, ProviderMetricsSummary> {
  return {
    openai_embedding: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
    openai_retrieval: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
    openai_answer: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
    openai_judge: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
    paddleocr: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
    conversion: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
    storage: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
    resend: { ok: 0, transientError: 0, rejected: 0, invalidOutput: 0, tokensTotal: 0 },
  };
}

let providerState: Record<TelemetryProvider, ProviderMetricsSummary> = createEmptyProviderState();

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Number(value.toFixed(2));
}

function clampNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function percentile(sorted: readonly number[], rank: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index];
}

export function recordStageTiming(
  pipeline: TelemetryPipeline,
  stage: string,
  durationMs: number,
): void {
  if (!stageNamePattern.test(stage)) return;
  const key = `${pipeline}.${stage}`;
  let buffer = stageBuffers.get(key);
  if (!buffer) {
    if (stageBuffers.size >= maxTrackedStageKeys) return;
    buffer = { count: 0, samples: [], nextIndex: 0, maxMs: 0 };
    stageBuffers.set(key, buffer);
  }
  const safeDuration = clampNonNegative(durationMs);
  buffer.count += 1;
  if (safeDuration > buffer.maxMs) {
    buffer.maxMs = safeDuration;
  }
  if (buffer.samples.length < maxStageTimingSamples) {
    buffer.samples.push(safeDuration);
  } else {
    buffer.samples[buffer.nextIndex] = safeDuration;
    buffer.nextIndex = (buffer.nextIndex + 1) % maxStageTimingSamples;
  }
}

export function recordOcrMetrics(input: {
  pagesTotal: number;
  ocrPages: number;
  failed?: boolean;
}): void {
  ocrState.runsTotal += 1;
  ocrState.pagesTotal += clampNonNegativeInteger(input.pagesTotal);
  ocrState.ocrPagesTotal += clampNonNegativeInteger(input.ocrPages);
  if (input.failed) {
    ocrState.failedRuns += 1;
  }
}

export function recordProviderOutcome(
  provider: TelemetryProvider,
  outcome: ProviderOutcome,
  details?: { tokens?: number },
): void {
  const entry = providerState[provider];
  if (!entry) return;
  if (outcome === "ok") entry.ok += 1;
  else if (outcome === "transient_error") entry.transientError += 1;
  else if (outcome === "rejected") entry.rejected += 1;
  else if (outcome === "invalid_output") entry.invalidOutput += 1;
  if (details?.tokens !== undefined) {
    entry.tokensTotal += clampNonNegativeInteger(details.tokens);
  }
}

export function snapshotOperationalMetrics(): OperationalMetricsSnapshot {
  const stages: Record<string, StageTimingSummary> = {};
  for (const [key, buffer] of stageBuffers.entries()) {
    const sorted = [...buffer.samples].sort((left, right) => left - right);
    stages[key] = {
      count: buffer.count,
      sampleCount: sorted.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: buffer.maxMs,
    };
  }

  const providers = {} as Record<TelemetryProvider, ProviderMetricsSummary>;
  for (const provider of allProviders) {
    providers[provider] = { ...providerState[provider] };
  }

  const memory = process.memoryUsage();
  return {
    stages,
    ocr: { ...ocrState },
    providers,
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryRssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
    },
  };
}

export function resetOperationalMetrics(): void {
  stageBuffers.clear();
  ocrState = {
    runsTotal: 0,
    pagesTotal: 0,
    ocrPagesTotal: 0,
    failedRuns: 0,
  };
  providerState = createEmptyProviderState();
}
