import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWLISTED_PROGRESS_STAGES = new Set([
  "accepted",
  "retrieving",
  "reranking",
  "generating",
  "validating",
]);

export const ALLOWED_PROGRESS_PAYLOAD_KEYS = new Set([
  "v",
  "requestId",
  "conversationId",
  "jobId",
  "stage",
]);

export const NO_EVIDENCE_FALLBACK = "No SOP found for this question";

const AUTH_BOUNDARY_PATHS = [
  "/api/documents",
  "/api/users",
  "/api/chat/conversations",
  "/api/health/ops",
];

const INTERNAL_BLOCKED_PATH =
  "/api/internal/chat/00000000-0000-4000-8000-000000000000/claim";

const DEFAULT_SYNTHETIC_SMOKE_QUESTION =
  "What is the verified synthetic autoclave pre-cycle check procedure?";

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  const modulePath = resolve(fileURLToPath(moduleUrl));
  const entryPath = resolve(process.argv[1]);
  return process.platform === "win32"
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

export function parseSseFrames(rawText) {
  const normalized = String(rawText ?? "").replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const frames = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    let id = null;
    let event = null;
    const dataLines = [];
    let hasField = false;

    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      hasField = true;
      const colonIndex = line.indexOf(":");
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "id") {
        id = value;
      } else if (field === "event") {
        event = value;
      } else if (field === "data") {
        dataLines.push(value);
      }
    }

    if (!hasField) continue;
    const rawData = dataLines.join("\n");
    let data = null;
    let parseError = null;
    if (rawData.length > 0) {
      try {
        data = JSON.parse(rawData);
      } catch (error) {
        parseError = error instanceof Error ? error.message : "Invalid JSON payload";
      }
    }

    frames.push({ id, event, data, rawData, parseError });
  }

  return frames;
}

export function verifyCheckedAnswerSseSafety(frames) {
  const violations = [];
  const progressStages = [];
  let terminalEvent = null;
  let sourceCount = 0;
  let exactFallbackMatched = false;

  if (!Array.isArray(frames) || frames.length === 0) {
    return {
      ok: false,
      violations: ["SSE stream produced zero event frames."],
      progressStages,
      terminalEvent,
      sourceCount,
      exactFallbackMatched,
    };
  }

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const eventName = frame?.event ?? "";

    if (terminalEvent !== null) {
      violations.push(`Unexpected SSE frame "${eventName}" received after terminal "${terminalEvent}".`);
      continue;
    }

    if (frame?.parseError || !frame?.data || typeof frame.data !== "object" || Array.isArray(frame.data)) {
      violations.push(`SSE frame ${index} ("${eventName}") did not contain a valid JSON object payload.`);
      continue;
    }

    if (ALLOWLISTED_PROGRESS_STAGES.has(eventName)) {
      progressStages.push(eventName);
      if (frame.data.stage !== eventName) {
        violations.push(
          `Progress frame "${eventName}" had mismatched stage "${String(frame.data.stage)}".`,
        );
      }
      const unexpectedKeys = Object.keys(frame.data).filter(
        (key) => !ALLOWED_PROGRESS_PAYLOAD_KEYS.has(key),
      );
      if (unexpectedKeys.length > 0) {
        violations.push(
          `Progress frame "${eventName}" leaked disallowed fields: ${unexpectedKeys.join(", ")}.`,
        );
      }
      continue;
    }

    if (eventName === "completed") {
      terminalEvent = "completed";
      if (typeof frame.data.answer !== "string" || frame.data.answer.trim().length === 0) {
        violations.push('Terminal "completed" frame is missing a non-empty answer.');
      }
      if (!Array.isArray(frame.data.sources) || frame.data.sources.length === 0) {
        violations.push('Terminal "completed" frame must include at least one verified source citation.');
      } else {
        sourceCount = frame.data.sources.length;
        for (const source of frame.data.sources) {
          const validSourcePath =
            typeof source?.sourcePath === "string" && source.sourcePath.startsWith("/api/documents/");
          if (
            !source ||
            typeof source.documentId !== "string" ||
            typeof source.chunkId !== "string" ||
            typeof source.sopTitle !== "string" ||
            typeof source.section !== "string" ||
            !validSourcePath
          ) {
            violations.push('Terminal "completed" frame contains an invalid source citation mapping.');
            break;
          }
        }
      }
      continue;
    }

    if (eventName === "no_evidence") {
      terminalEvent = "no_evidence";
      if (frame.data.message !== NO_EVIDENCE_FALLBACK) {
        violations.push(
          'Terminal "no_evidence" frame did not return the exact required fallback string.',
        );
      } else {
        exactFallbackMatched = true;
      }
      if (!Array.isArray(frame.data.sources) || frame.data.sources.length !== 0) {
        violations.push('Terminal "no_evidence" frame must return an empty sources array.');
      }
      continue;
    }

    violations.push(`Disallowed or non-passing SSE event "${eventName}" received.`);
  }

  if (progressStages.length === 0) {
    violations.push("SSE stream emitted zero allowlisted progress stages before completion.");
  }
  if (terminalEvent !== "completed" && terminalEvent !== "no_evidence") {
    violations.push('SSE stream did not conclude with a terminal "completed" or "no_evidence" event.');
  }

  return {
    ok: violations.length === 0,
    violations,
    progressStages,
    terminalEvent,
    sourceCount,
    exactFallbackMatched,
  };
}

function roundMs(value) {
  return Number(Math.max(0, value).toFixed(2));
}

function createTimeoutError(timeoutMs) {
  const error = new Error(`Smoke check request exceeded timeout of ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  error.code = "SMOKE_TIMEOUT";
  return error;
}

async function withRequestTimeout(timeoutMs, operation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(createTimeoutError(timeoutMs)), timeoutMs);
  timer.unref?.();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? createTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function raceWithSignal(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort?.();
    return Promise.reject(signal.reason ?? createTimeoutError(0));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const handleAbort = () => {
      onAbort?.();
      rejectPromise(signal.reason ?? createTimeoutError(0));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", handleAbort);
        rejectPromise(error);
      },
    );
  });
}

async function fetchJsonWithTimeout(fetchImpl, url, init, timeoutMs) {
  return withRequestTimeout(timeoutMs, async (signal) => {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal,
    });
    const text = await raceWithSignal(response.text(), signal);
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { response, body };
  });
}

async function fetchStatusWithTimeout(fetchImpl, url, init, timeoutMs) {
  return withRequestTimeout(timeoutMs, async (signal) => {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal,
    });
    await response.body?.cancel?.().catch(() => undefined);
    return response.status;
  });
}

async function readSseResponseWithTimings(response, startedAtMs, clock, signal) {
  let firstProgressMs = null;
  let firstAnswerMs = null;
  let rawText = "";

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await raceWithSignal(reader.read(), signal, () => {
          reader.cancel().catch(() => undefined);
        });
        if (done) break;
        const chunkText = decoder.decode(value, { stream: true });
        rawText += chunkText;
        buffer += chunkText.replace(/\r\n/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const block = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const parsed = parseSseFrames(`${block}\n\n`);
          const nowElapsed = roundMs(clock() - startedAtMs);
          for (const frame of parsed) {
            if (firstProgressMs === null && ALLOWLISTED_PROGRESS_STAGES.has(frame.event ?? "")) {
              firstProgressMs = nowElapsed;
            }
            if (
              firstAnswerMs === null &&
              (frame.event === "completed" || frame.event === "no_evidence")
            ) {
              firstAnswerMs = nowElapsed;
            }
          }
          separatorIndex = buffer.indexOf("\n\n");
        }
      }
      const trailing = decoder.decode();
      if (trailing) rawText += trailing;
    } finally {
      reader.releaseLock();
    }
  } else {
    rawText = await raceWithSignal(response.text(), signal);
    const elapsed = roundMs(clock() - startedAtMs);
    const parsed = parseSseFrames(rawText);
    for (const frame of parsed) {
      if (firstProgressMs === null && ALLOWLISTED_PROGRESS_STAGES.has(frame.event ?? "")) {
        firstProgressMs = elapsed;
      }
      if (
        firstAnswerMs === null &&
        (frame.event === "completed" || frame.event === "no_evidence")
      ) {
        firstAnswerMs = elapsed;
      }
    }
  }

  const completedMs = roundMs(clock() - startedAtMs);
  return { rawText, firstProgressMs, firstAnswerMs, completedMs };
}

export async function runDeploySmokeChecks(options = {}) {
  const baseUrl = String(options.baseUrl ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
  const origin = new URL(baseUrl).origin;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Number(options.timeoutMs ?? 35_000);
  const healthOnly = Boolean(options.healthOnly);
  const sessionCookie = typeof options.sessionCookie === "string" ? options.sessionCookie.trim() : "";
  const question = String(options.question ?? DEFAULT_SYNTHETIC_SMOKE_QUESTION);
  const clock = options.clock ?? (() => performance.now());
  const overallStart = clock();

  // 1. Live probe + security headers capture
  let liveCheck;
  let securityHeadersCheck;
  try {
    const start = clock();
    const { response, body } = await fetchJsonWithTimeout(
      fetchImpl,
      `${baseUrl}/api/health/live`,
      { method: "GET" },
      timeoutMs,
    );
    const requestId = response.headers.get("x-request-id") ?? "";
    const cacheControl = (response.headers.get("cache-control") ?? "").toLowerCase();

    liveCheck = {
      ok:
        response.status === 200 &&
        body?.status === "ok" &&
        requestId.trim().length > 0 &&
        cacheControl.includes("no-store"),
      statusCode: response.status,
      hasRequestId: requestId.trim().length > 0,
      hasNoStoreCacheControl: cacheControl.includes("no-store"),
      latencyMs: roundMs(clock() - start),
    };

    const nosniff = (response.headers.get("x-content-type-options") ?? "").trim().toLowerCase() === "nosniff";
    const frameDeny = (response.headers.get("x-frame-options") ?? "").trim().toUpperCase() === "DENY";
    const noReferrer = (response.headers.get("referrer-policy") ?? "").trim().toLowerCase() === "no-referrer";
    const missingHeaders = [];
    if (!nosniff) missingHeaders.push("X-Content-Type-Options: nosniff");
    if (!frameDeny) missingHeaders.push("X-Frame-Options: DENY");
    if (!noReferrer) missingHeaders.push("Referrer-Policy: no-referrer");

    securityHeadersCheck = {
      ok: missingHeaders.length === 0,
      missingHeaders,
    };
  } catch (error) {
    liveCheck = {
      ok: false,
      statusCode: null,
      error: error instanceof Error ? error.name : "FETCH_ERROR",
    };
    securityHeadersCheck = {
      ok: false,
      missingHeaders: [
        "X-Content-Type-Options: nosniff",
        "X-Frame-Options: DENY",
        "Referrer-Policy: no-referrer",
      ],
    };
  }

  // 2. Ready probe (PostgreSQL + pgvector)
  let readyCheck;
  try {
    const start = clock();
    const { response, body } = await fetchJsonWithTimeout(
      fetchImpl,
      `${baseUrl}/api/health/ready`,
      { method: "GET" },
      timeoutMs,
    );
    readyCheck = {
      ok: response.status === 200 && body?.status === "ready",
      statusCode: response.status,
      status: body?.status ?? null,
      latencyMs: roundMs(clock() - start),
    };
  } catch (error) {
    readyCheck = {
      ok: false,
      statusCode: null,
      error: error instanceof Error ? error.name : "FETCH_ERROR",
    };
  }

  // 3. Unauthenticated auth boundary
  const authResults = [];
  for (const path of AUTH_BOUNDARY_PATHS) {
    try {
      const statusCode = await fetchStatusWithTimeout(
        fetchImpl,
        `${baseUrl}${path}`,
        { method: "GET" },
        timeoutMs,
      );
      authResults.push({ path, statusCode, ok: statusCode === 401 });
    } catch {
      authResults.push({ path, statusCode: null, ok: false });
    }
  }
  const authBoundaryCheck = {
    ok: authResults.every((item) => item.ok),
    endpoints: authResults,
  };

  // 4. Internal callback route blocked externally
  let internalRouteBlockedCheck;
  try {
    const statusCode = await fetchStatusWithTimeout(
      fetchImpl,
      `${baseUrl}${INTERNAL_BLOCKED_PATH}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      timeoutMs,
    );
    internalRouteBlockedCheck = {
      ok: statusCode === 404,
      statusCode,
      path: INTERNAL_BLOCKED_PATH,
    };
  } catch {
    internalRouteBlockedCheck = {
      ok: false,
      statusCode: null,
      path: INTERNAL_BLOCKED_PATH,
    };
  }

  // 5. Checked-answer SSE smoke check (timeout spans fetch + entire stream read)
  let checkedAnswerSseCheck;
  if (!sessionCookie) {
    checkedAnswerSseCheck = {
      ok: false,
      executed: false,
      ...(healthOnly ? { skippedByHealthOnly: true } : {}),
      reason: "No authorized synthetic session cookie supplied; checked-answer SSE was not executed.",
    };
  } else {
    const sseStart = clock();
    try {
      checkedAnswerSseCheck = await withRequestTimeout(timeoutMs, async (signal) => {
        const response = await fetchImpl(`${baseUrl}/api/chat/messages`, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            Origin: origin,
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            requestKey: randomUUID(),
            question,
          }),
        });

        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        if (response.status !== 200 || !contentType.includes("text/event-stream")) {
          await response.body?.cancel?.().catch(() => undefined);
          return {
            ok: false,
            executed: true,
            statusCode: response.status,
            contentType,
            violations: ["Expected HTTP 200 text/event-stream response from /api/chat/messages."],
          };
        }

        const streamCapture = await readSseResponseWithTimings(response, sseStart, clock, signal);
        const frames = parseSseFrames(streamCapture.rawText);
        const safety = verifyCheckedAnswerSseSafety(frames);

        return {
          ok: safety.ok,
          executed: true,
          statusCode: response.status,
          progressStages: safety.progressStages,
          terminalEvent: safety.terminalEvent,
          sourceCount: safety.sourceCount,
          exactFallbackMatched: safety.exactFallbackMatched,
          violations: safety.violations,
          timingsMs: {
            firstProgressMs: streamCapture.firstProgressMs,
            firstAnswerMs: streamCapture.firstAnswerMs,
            completedMs: streamCapture.completedMs,
          },
        };
      });
    } catch (error) {
      checkedAnswerSseCheck = {
        ok: false,
        executed: true,
        violations: [`Checked-answer SSE probe failed: ${error instanceof Error ? error.name : "FETCH_ERROR"}`],
      };
    }
  }

  const baseHealthy =
    liveCheck.ok &&
    readyCheck.ok &&
    authBoundaryCheck.ok &&
    internalRouteBlockedCheck.ok &&
    securityHeadersCheck.ok;

  const ok = healthOnly ? baseHealthy : baseHealthy && checkedAnswerSseCheck.ok;

  return {
    ok,
    mode: healthOnly ? "health_only" : "full_checked_answer",
    baseUrl,
    checkedAt: new Date().toISOString(),
    checks: {
      live: liveCheck,
      ready: readyCheck,
      authBoundary: authBoundaryCheck,
      internalRouteBlocked: internalRouteBlockedCheck,
      securityHeaders: securityHeadersCheck,
      checkedAnswerSse: checkedAnswerSseCheck,
    },
    timingsMs: {
      totalMs: roundMs(clock() - overallStart),
    },
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

    const result = await runDeploySmokeChecks({
      baseUrl: args["base-url"] ? String(args["base-url"]) : "http://127.0.0.1:3000",
      sessionCookie,
      question: args.question ? String(args.question) : undefined,
      healthOnly: Boolean(args["health-only"]),
      timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : 35_000,
    });

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        errorCode: error?.code ?? "SMOKE_CHECK_ERROR",
        message: error instanceof Error ? error.name : "Smoke check execution failed.",
      }),
    );
    process.exitCode = 1;
  }
}
