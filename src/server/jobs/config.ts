import { readServerSecret } from "../auth/config";

type Environment = Readonly<Record<string, string | undefined>>;

export function workflowProbeEnabled(env: Environment = process.env) {
  if (env.SOP_WORKFLOW_PROBE_ENABLED !== "1" || !env.AUTH_BASE_URL) return false;
  try {
    const base = new URL(env.AUTH_BASE_URL);
    return base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  } catch { return false; }
}

export function workflowDispatchUrl(env: Environment = process.env) {
  const url = new URL(env.WORKFLOW_DISPATCH_URL ?? "");
  if (url.username || url.password || url.search || url.hash ||
      !["http:", "https:"].includes(url.protocol) || url.pathname !== "/webhook/sop-s03-probe-v1") {
    throw new Error("Invalid workflow dispatch configuration.");
  }
  return url.toString();
}

export function ingestionDispatchEnabled(env: Environment = process.env) {
  return env.NEXT_PHASE !== "phase-production-build" && env.INGESTION_DISPATCH_ENABLED === "1";
}

export function ingestionDispatchUrl(env: Environment = process.env) {
  const raw = env.INGESTION_DISPATCH_URL ??
    (env.WORKFLOW_DISPATCH_URL ? new URL("/webhook/sop-s05-ingestion-v1", env.WORKFLOW_DISPATCH_URL).toString() : "");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash ||
      !["http:", "https:"].includes(url.protocol) || url.pathname !== "/webhook/sop-s05-ingestion-v1") {
    throw new Error("Invalid ingestion dispatch configuration.");
  }
  return url.toString();
}

export function chatDispatchEnabled(env: Environment = process.env) {
  return env.NEXT_PHASE !== "phase-production-build" && env.CHAT_DISPATCH_ENABLED === "1";
}

export function chatDispatchUrl(env: Environment = process.env) {
  const raw = env.CHAT_DISPATCH_URL ??
    (env.INGESTION_DISPATCH_URL
      ? new URL("/webhook/sop-s11-chat-v1", env.INGESTION_DISPATCH_URL).toString()
      : env.WORKFLOW_DISPATCH_URL
        ? new URL("/webhook/sop-s11-chat-v1", env.WORKFLOW_DISPATCH_URL).toString()
        : "");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash ||
      !["http:", "https:"].includes(url.protocol) || url.pathname !== "/webhook/sop-s11-chat-v1") {
    throw new Error("Invalid chat dispatch configuration.");
  }
  return url.toString();
}

export function dispatchPrivateKey() { return readServerSecret("WORKFLOW_DISPATCH_PRIVATE_KEY"); }
export function callbackPublicKey() { return readServerSecret("WORKFLOW_CALLBACK_PUBLIC_KEY"); }

export function probeCallbackDelayMilliseconds(env: Environment = process.env) {
  if (!workflowProbeEnabled(env)) return 0;
  const value = env.WORKFLOW_PROBE_CALLBACK_DELAY_MS ?? "0";
  if (!/^\d+$/.test(value) || Number(value) > 2000) throw new Error("Invalid synthetic callback delay.");
  return Number(value);
}

export function workflowDispatcherEnabled(env: Environment = process.env) {
  if (env.NEXT_PHASE === "phase-production-build") return false;
  return (env.WORKFLOW_DISPATCH_ENABLED === "1" && workflowProbeEnabled(env)) ||
    ingestionDispatchEnabled(env) ||
    chatDispatchEnabled(env);
}
