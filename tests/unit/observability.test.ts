import { beforeEach, describe, expect, it } from "vitest";
import { GET as getLiveHealthRoute } from "../../src/app/api/health/live/route";
import {
  createAppLogger,
  logEvent,
  maxStageTimingSamples,
  recordOcrMetrics,
  recordProviderOutcome,
  recordStageTiming,
  resetOperationalMetrics,
  resolveTraceId,
  sanitizeLogMetadata,
  scrubLogString,
  snapshotOperationalMetrics,
} from "../../src/server/observability";

function createCaptureStream() {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(chunk: string) {
        lines.push(chunk);
      },
    },
  };
}

describe("S14/ADR13 structured Pino logging redaction and trace correlation", () => {
  it("strips and redacts nested secrets, SOP passages, prompts, signed URLs, private keys, emails, and CRLF injections", () => {
    const capture = createCaptureStream();
    const testLogger = createAppLogger(capture.stream, { level: "debug" });

    const forbiddenValues = [
      "SuperSecretPass!2026",
      "top-secret-auth-key-9999",
      "eyJhbGciOiJSUzI1NiJ9.payload.sig",
      "session_cookie_value_xyz",
      "sk-liveSecretKey99887766",
      "re_resendSecretKey112233",
      "https://bucket.r2.cloudflarestorage.com/sop.pdf?X-Amz-Signature=deadbeef123456&X-Amz-Credential=cred99",
      "SOP-101 confidential sterilization passage 121.0 C",
      "System prompt override instructions",
      "Hold autoclave at 121.0 C for 20 minutes",
      "operator.secret@synthetic.invalid",
      "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw",
      "dbpass_super_secret",
    ];

    logEvent(
      "info",
      "chat.turn_completed\r\n{\"level\":\"error\",\"event\":\"forged_line\"}",
      {
        traceId: "trace-s14-001",
        jobId: "11111111-1111-4111-8111-111111111111",
        stage: "validate",
        outcome: "supported",
        durationMs: 42.5,
        password: forbiddenValues[0],
        nested: {
          secret: forbiddenValues[1],
          access_token: forbiddenValues[2],
          cookie: forbiddenValues[3],
          api_key: forbiddenValues[4],
          signed_url: forbiddenValues[6],
          passages: [{ text: forbiddenValues[7], raw_text: forbiddenValues[7] }],
          prompt: forbiddenValues[8],
          candidate: { answer: forbiddenValues[9] },
          userEmail: forbiddenValues[10],
          private_key: `-----BEGIN PRIVATE KEY-----\n${forbiddenValues[11]}\n-----END PRIVATE KEY-----`,
          body: forbiddenValues[7],
        },
        unstructuredNote:
          `Bearer ${forbiddenValues[2]} key=${forbiddenValues[4]} resend=${forbiddenValues[5]} ` +
          `url=https://storage.local/doc?X-Amz-Signature=deadbeef123456 ` +
          `db=postgresql://sop_app:${forbiddenValues[12]}@postgres:5432/sop_app ` +
          `contact=${forbiddenValues[10]}\r\nFORGED_INJECTION`,
        rawError: new Error(`connect failed postgresql://sop_app:${forbiddenValues[12]}@postgres:5432/sop_app`),
      },
      testLogger,
    );

    expect(capture.lines).toHaveLength(1);
    const rawLine = capture.lines[0];
    expect(rawLine.trim().split(/\r?\n/)).toHaveLength(1);

    for (const secret of forbiddenValues) {
      expect(rawLine).not.toContain(secret);
    }
    expect(rawLine).not.toContain("deadbeef123456");

    const parsed = JSON.parse(rawLine) as Record<string, unknown>;
    expect(parsed.traceId).toBe("trace-s14-001");
    expect(parsed.jobId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.stage).toBe("validate");
    expect(parsed.outcome).toBe("supported");
    expect(parsed.durationMs).toBe(42.5);
    expect(parsed.password).toBe("[REDACTED]");
    expect((parsed.nested as Record<string, unknown>).secret).toBe("[REDACTED]");
    expect((parsed.nested as Record<string, unknown>).passages).toBe("[REDACTED]");
    expect((parsed.nested as Record<string, unknown>).prompt).toBe("[REDACTED]");
    expect((parsed.nested as Record<string, unknown>).userEmail).toBe("[REDACTED]");
    expect((parsed.rawError as Record<string, unknown>).errorName).toBe("Error");
    expect((parsed.rawError as Record<string, unknown>).message).toBeUndefined();
    expect((parsed.rawError as Record<string, unknown>).stack).toBeUndefined();
  });

  it("handles circular references, deep nesting, and PEM blocks safely", () => {
    const circular: Record<string, unknown> = { stage: "extract" };
    circular.self = circular;
    const sanitized = sanitizeLogMetadata({
      circular,
      pemInPlainField: "-----BEGIN RSA PRIVATE KEY-----\nSECRET_BYTES\n-----END RSA PRIVATE KEY-----",
    });

    expect((sanitized.circular as Record<string, unknown>).self).toBe("[CIRCULAR]");
    expect(String(sanitized.pemInPlainField)).not.toContain("SECRET_BYTES");
    expect(String(sanitized.pemInPlainField)).toContain("[REDACTED_PRIVATE_KEY]");
    expect(scrubLogString("line1\r\nline2\u0000line3")).toBe("line1 line2 line3");
  });

  it("accepts clean bounded trace headers and generates a UUID fallback for invalid headers", () => {
    const validRequest = new Request("http://127.0.0.1:3000/api/health/ready", {
      headers: { "X-Request-Id": "req-2026_11.27-01" },
    });
    expect(resolveTraceId(validRequest)).toBe("req-2026_11.27-01");

    const traceHeaderRequest = new Request("http://127.0.0.1:3000/api/health/ready", {
      headers: { "X-Trace-Id": "trace_abcdef1234" },
    });
    expect(resolveTraceId(traceHeaderRequest)).toBe("trace_abcdef1234");

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const badValue of ["short", "a".repeat(65), "bad value with spaces", "bad;header"]) {
      const headers = new Headers();
      headers.set("x-request-id", badValue);
      expect(resolveTraceId(headers)).toMatch(uuidPattern);
    }
    expect(resolveTraceId(undefined)).toMatch(uuidPattern);

    const liveResponse = getLiveHealthRoute(
      new Request("http://127.0.0.1:3000/api/health/live", {
        headers: { "X-Request-Id": "trace-live-s14" },
      }),
    );
    expect(liveResponse.status).toBe(200);
    expect(liveResponse.headers.get("cache-control")).toBe("no-store");
    expect(liveResponse.headers.get("x-request-id")).toBe("trace-live-s14");
  });
});

describe("S14/ADR13 bounded operational telemetry store", () => {
  beforeEach(() => {
    resetOperationalMetrics();
  });

  it("enforces ring-buffer sample bounds and computes p50/p95/max stage timings", () => {
    const totalSamples = maxStageTimingSamples + 150;
    for (let index = 1; index <= totalSamples; index++) {
      recordStageTiming("retrieval", "rerank", index);
    }
    // Invalid values are safely clamped or ignored without throwing.
    recordStageTiming("retrieval", "bad stage name!", 999);
    recordStageTiming("answer", "judge", Number.NaN);
    recordStageTiming("answer", "judge", -15);
    recordStageTiming("answer", "judge", 120);

    const snapshot = snapshotOperationalMetrics();
    const rerank = snapshot.stages["retrieval.rerank"];
    expect(rerank).toBeDefined();
    expect(rerank.count).toBe(totalSamples);
    expect(rerank.sampleCount).toBe(maxStageTimingSamples);
    expect(rerank.maxMs).toBe(totalSamples);
    // Window holds values 151..350 (200 entries): p50 is 250, p95 is 340.
    expect(rerank.p50Ms).toBe(250);
    expect(rerank.p95Ms).toBe(340);
    expect(snapshot.stages["retrieval.bad stage name!"]).toBeUndefined();
    expect(snapshot.stages["answer.judge"]).toEqual({
      count: 3,
      sampleCount: 3,
      p50Ms: 0,
      p95Ms: 120,
      maxMs: 120,
    });
  });

  it("tracks OCR and provider outcomes without storing SOP content or user PII", () => {
    recordOcrMetrics({ pagesTotal: 10, ocrPages: 4 });
    recordOcrMetrics({ pagesTotal: 0, ocrPages: 0, failed: true });
    recordProviderOutcome("openai_embedding", "ok", { tokens: 120 });
    recordProviderOutcome("openai_embedding", "transient_error");
    recordProviderOutcome("openai_judge", "invalid_output");
    recordProviderOutcome("paddleocr", "rejected");

    const snapshot = snapshotOperationalMetrics();
    expect(snapshot.ocr).toEqual({
      runsTotal: 2,
      pagesTotal: 10,
      ocrPagesTotal: 4,
      failedRuns: 1,
    });
    expect(snapshot.providers.openai_embedding).toEqual({
      ok: 1,
      transientError: 1,
      rejected: 0,
      invalidOutput: 0,
      tokensTotal: 120,
    });
    expect(snapshot.providers.openai_judge.invalidOutput).toBe(1);
    expect(snapshot.providers.paddleocr.rejected).toBe(1);
    expect(snapshot.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.process.memoryRssBytes).toBeGreaterThan(0);
    expect(snapshot.process.heapUsedBytes).toBeGreaterThan(0);
    expect(snapshot.process.heapTotalBytes).toBeGreaterThan(0);
  });
});
