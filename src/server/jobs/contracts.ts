import { z } from "zod";

export const workflowVersion = "s03-probe-v1";
export const syntheticMarker = "S03_SYNTHETIC_VALIDATED";
export const workflowBounds = {
  maximumAttempts: 3, maximumDispatches: 3, dispatchBatch: 5,
  fetchTimeoutMilliseconds: 3000, dispatchLeaseMilliseconds: 5000,
  attemptMilliseconds: 60_000, runLeaseMilliseconds: 15_000,
  tokenSeconds: 60, clockToleranceSeconds: 3, streamMilliseconds: 60_000,
  pollMilliseconds: 250, heartbeatMilliseconds: 10_000, streamQueueBytes: 65_536,
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

export function parseEventCursor(value: string | null, jobId: string) {
  if (!value) return 0;
  const match = /^([0-9a-f-]{36}):(0|[1-9][0-9]{0,8})$/.exec(value);
  if (!match || match[1] !== jobId) throw new Error("INVALID_EVENT_CURSOR");
  return Number(match[2]);
}
