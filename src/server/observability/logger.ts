import { randomUUID } from "node:crypto";
import pino, { type DestinationStream, type Logger } from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error";

const traceIdPattern = /^[A-Za-z0-9._-]{8,64}$/;
const maxSanitizeDepth = 6;
const maxScrubbedStringLength = 256;
const redactedMarker = "[REDACTED]";

const sensitiveKeySubstrings = [
  "password",
  "secret",
  "token",
  "cookie",
  "authorization",
  "apikey",
  "signedurl",
  "presigned",
  "prompt",
  "passage",
  "text",
  "rawtext",
  "normalizedtext",
  "answer",
  "candidate",
  "question",
  "email",
  "content",
  "privatekey",
  "body",
] as const;

const pinoRedactPaths = [
  "password",
  "secret",
  "token",
  "cookie",
  "authorization",
  "apiKey",
  "api_key",
  "signedUrl",
  "signed_url",
  "presignedUrl",
  "prompt",
  "passage",
  "passages",
  "text",
  "rawText",
  "normalizedText",
  "answer",
  "candidate",
  "question",
  "email",
  "content",
  "privateKey",
  "private_key",
  "body",
  "*.password",
  "*.secret",
  "*.token",
  "*.cookie",
  "*.authorization",
  "*.apiKey",
  "*.api_key",
  "*.signedUrl",
  "*.signed_url",
  "*.presignedUrl",
  "*.prompt",
  "*.passage",
  "*.passages",
  "*.text",
  "*.rawText",
  "*.normalizedText",
  "*.answer",
  "*.candidate",
  "*.question",
  "*.email",
  "*.content",
  "*.privateKey",
  "*.private_key",
  "*.body",
  "req.headers.authorization",
  "req.headers.cookie",
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return sensitiveKeySubstrings.some((part) => normalized.includes(part));
}

export function scrubLogString(value: string): string {
  const singleLine = value.replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim();
  const scrubbed = singleLine
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
      "[REDACTED_PRIVATE_KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|token)=)[^&\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=[^&\s"']+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{4,}|re_[A-Za-z0-9_-]{4,})\b/g, "[REDACTED_KEY]")
    .replace(
      /\b((?:postgres(?:ql)?|rediss?|https?):\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
      "$1[REDACTED]:[REDACTED]@",
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]");

  return scrubbed.length > maxScrubbedStringLength
    ? `${scrubbed.slice(0, maxScrubbedStringLength)}...`
    : scrubbed;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return scrubLogString(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  if (value instanceof Error) {
    const code = "code" in value && typeof value.code === "string"
      ? scrubLogString(value.code)
      : undefined;
    return {
      errorName: scrubLogString(value.name),
      ...(code ? { errorCode: code } : {}),
    };
  }

  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return "[CIRCULAR]";
  if (depth >= maxSanitizeDepth) return "[TRUNCATED]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue;
    if (isSensitiveKey(key)) {
      sanitized[key] = redactedMarker;
      continue;
    }
    sanitized[key] = sanitizeValue(entry, depth + 1, seen);
  }
  return sanitized;
}

export function sanitizeLogMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const result = sanitizeValue(meta, 0, new WeakSet<object>());
  return result && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : {};
}

export function resolveTraceId(request?: Request | Headers | null): string {
  const headers = request instanceof Request ? request.headers : request;
  if (headers) {
    const candidate = headers.get("x-request-id") ?? headers.get("x-trace-id");
    const trimmed = candidate?.trim();
    if (trimmed && traceIdPattern.test(trimmed)) {
      return trimmed;
    }
  }
  return randomUUID();
}

export function createAppLogger(
  destination?: DestinationStream,
  options: { level?: string } = {},
): Logger {
  const config = {
    name: "ai-sop-assistant",
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: pinoRedactPaths,
      censor: redactedMarker,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: "ai-sop-assistant" },
    formatters: {
      level(label: string) {
        return { level: label };
      },
    },
  };
  return destination ? pino(config, destination) : pino(config);
}

export const logger: Logger = createAppLogger(undefined, {
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
});

export function logEvent(
  level: LogLevel,
  event: string,
  meta: Record<string, unknown> = {},
  targetLogger: Logger = logger,
): void {
  try {
    const payload = {
      event: scrubLogString(event),
      ...sanitizeLogMetadata(meta),
    };
    targetLogger[level](payload);
  } catch {
    // Logging must never interrupt or fail application control flow.
  }
}
