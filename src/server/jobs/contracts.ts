import { z } from "zod";

export const workflowVersion = "s03-probe-v1";
export const ingestionWorkflowVersion = "s05-ingestion-v1";
export const chatWorkflowVersion = "s11-chat-v1";
export const syntheticMarker = "S03_SYNTHETIC_VALIDATED";
export const workflowBounds = {
  maximumAttempts: 3, maximumDispatches: 3, dispatchBatch: 5,
  fetchTimeoutMilliseconds: 3000, dispatchLeaseMilliseconds: 5000,
  attemptMilliseconds: 60_000, runLeaseMilliseconds: 15_000,
  tokenSeconds: 60, clockToleranceSeconds: 3, streamMilliseconds: 60_000,
  pollMilliseconds: 250, heartbeatMilliseconds: 10_000, streamQueueBytes: 65_536,
} as const;
export const ingestionBounds = {
  maximumAttempts: 3,
  maximumDispatches: 3,
  attemptMilliseconds: 300_000,
  runLeaseMilliseconds: 210_000,
  sourceRefTokenSeconds: 45,
  callbackTokenSeconds: 60,
  clockToleranceSeconds: 3,
} as const;
export const chatBounds = {
  maximumAttempts: 3,
  maximumDispatches: 3,
  attemptMilliseconds: 90_000,
  runLeaseMilliseconds: 45_000,
  callbackTokenSeconds: 60,
  clockToleranceSeconds: 3,
  streamMilliseconds: 60_000,
  pollMilliseconds: 200,
  heartbeatMilliseconds: 10_000,
  streamQueueBytes: 65_536,
} as const;

export const probeInput = z.object({ requestKey: z.uuid(), scenario: z.enum(["success", "validation_failure"]).default("success") }).strict();
export const emptyWorkflowBody = z.object({}).strict();
const identity = {
  v: z.literal(1), workflow: z.literal(workflowVersion), jobId: z.uuid(), attemptId: z.uuid(),
  attemptNumber: z.number().int().min(1).max(workflowBounds.maximumAttempts), dispatchNonce: z.uuid(),
  jti: z.string().regex(/^[A-Za-z0-9:_-]{16,200}$/), iat: z.number().int(), nbf: z.number().int(), exp: z.number().int(),
  method: z.literal("POST"),
};
export const dispatchClaims = z.object({
  ...identity, iss: z.literal("sop-app"), aud: z.literal("sop-n8n"), purpose: z.literal("dispatch"),
  path: z.literal("/webhook/sop-s03-probe-v1"), scenario: z.enum(["success", "validation_failure"]),
}).strict();
export const callbackClaims = z.object({
  ...identity, iss: z.literal("sop-n8n"), aud: z.literal("sop-app"),
  purpose: z.enum(["claim", "callback"]), path: z.string().max(200),
  executionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  step: z.number().int().min(1).max(5), outcome: z.enum(["pass", "fail"]),
}).strict();
export type CallbackClaims = z.infer<typeof callbackClaims>;

export const ingestionCallbackPurposes = [
  "claim",
  "renew-source-ref",
  "extract",
  "chunk",
  "embed",
  "complete",
  "fail",
] as const;
export type IngestionCallbackPurpose = typeof ingestionCallbackPurposes[number];

const ingestionIdentity = {
  v: z.literal(1),
  workflow: z.literal(ingestionWorkflowVersion),
  jobId: z.uuid(),
  documentId: z.uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  pipelineVersion: z.string().min(1).max(64),
  attemptId: z.uuid(),
  attemptNumber: z.number().int().min(1).max(ingestionBounds.maximumAttempts),
  dispatchNonce: z.uuid(),
  jti: z.string().regex(/^[A-Za-z0-9:_-]{16,200}$/),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  method: z.literal("POST"),
};
export const ingestionDispatchClaims = z.object({
  ...ingestionIdentity,
  iss: z.literal("sop-app"),
  aud: z.literal("sop-n8n"),
  purpose: z.literal("dispatch"),
  path: z.literal("/webhook/sop-s05-ingestion-v1"),
}).strict();
export type IngestionDispatchClaims = z.infer<typeof ingestionDispatchClaims>;

export const ingestionCallbackClaims = z.object({
  ...ingestionIdentity,
  iss: z.literal("sop-n8n"),
  aud: z.literal("sop-app"),
  purpose: z.enum(ingestionCallbackPurposes),
  path: z.string().max(200),
  executionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();
export type IngestionCallbackClaims = z.infer<typeof ingestionCallbackClaims>;

export const sourceRefClaims = z.object({
  v: z.literal(1),
  iss: z.literal("sop-app"),
  aud: z.literal("sop-app-source-ref"),
  purpose: z.literal("source_read"),
  jobId: z.uuid(),
  documentId: z.uuid(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  attemptId: z.uuid(),
  executionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  jti: z.uuid(),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
}).strict();
export type SourceRefClaims = z.infer<typeof sourceRefClaims>;

export const chatCallbackPurposes = [
  "claim",
  "retrieve",
  "generate",
  "validate",
  "fail",
] as const;
export type ChatCallbackPurpose = typeof chatCallbackPurposes[number];

const chatIdentity = {
  v: z.literal(1),
  workflow: z.literal(chatWorkflowVersion),
  jobId: z.uuid(),
  conversationId: z.uuid(),
  requestKey: z.uuid(),
  attemptId: z.uuid(),
  attemptNumber: z.number().int().min(1).max(chatBounds.maximumAttempts),
  dispatchNonce: z.uuid(),
  jti: z.string().regex(/^[A-Za-z0-9:_-]{16,200}$/),
  iat: z.number().int(),
  nbf: z.number().int(),
  exp: z.number().int(),
  method: z.literal("POST"),
};

export const chatDispatchClaims = z.object({
  ...chatIdentity,
  iss: z.literal("sop-app"),
  aud: z.literal("sop-n8n"),
  purpose: z.literal("dispatch"),
  path: z.literal("/webhook/sop-s11-chat-v1"),
}).strict();
export type ChatDispatchClaims = z.infer<typeof chatDispatchClaims>;

export const chatCallbackClaims = z.object({
  ...chatIdentity,
  iss: z.literal("sop-n8n"),
  aud: z.literal("sop-app"),
  purpose: z.enum(chatCallbackPurposes),
  path: z.string().max(200),
  executionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
}).strict();
export type ChatCallbackClaims = z.infer<typeof chatCallbackClaims>;

export function parseEventCursor(value: string | null, jobId: string) {
  if (!value) return 0;
  const match = /^([0-9a-f-]{36}):(0|[1-9][0-9]{0,8})$/.exec(value);
  if (!match || match[1] !== jobId) throw new Error("INVALID_EVENT_CURSOR");
  return Number(match[2]);
}
