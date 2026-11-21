import { generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { callbackClaims, parseEventCursor, syntheticMarker, workflowBounds } from "../../src/server/jobs/contracts";
import { probeCallbackDelayMilliseconds, workflowDispatcherEnabled, workflowDispatchUrl, workflowProbeEnabled } from "../../src/server/jobs/config";
import { verifyCallback } from "../../src/server/jobs/signatures";
import { serializeWorkflowEvent } from "../../src/server/jobs/stream";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
let signingKey: CryptoKey;
beforeAll(async () => { signingKey = await importPKCS8(keys.privateKey, "RS256"); });

function claims() {
  const now = Math.floor(Date.now() / 1000);
  const jobId = randomUUID();
  return { v: 1, workflow: "s03-probe-v1", jobId, attemptId: randomUUID(), attemptNumber: 1,
    dispatchNonce: randomUUID(), jti: randomUUID(), iat: now, nbf: now, exp: now + 30,
    iss: "sop-n8n", aud: "sop-app", purpose: "callback", method: "POST",
    path: `/api/internal/jobs/${jobId}/callback`, executionId: "synthetic-execution", step: 2, outcome: "pass" };
}
async function token(payload = claims()) { return new SignJWT(payload).setProtectedHeader({ alg: "RS256", typ: "JWT" }).sign(signingKey); }

describe("ADR08/19 signed workflow boundary and safe event contracts", () => {
  it("accepts only the pinned direction, algorithm, required claims and bounded freshness", async () => {
    const payload = claims();
    expect(await verifyCallback(await token(payload), keys.publicKey)).toEqual(payload);
    const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    await expect(verifyCallback(await token(payload), otherKeys.publicKey)).rejects.toMatchObject({ status: 401 });
    for (const invalid of [
      { ...payload, iss: "sop-app" }, { ...payload, aud: "sop-n8n" }, { ...payload, purpose: "dispatch" },
      { ...payload, iat: payload.iat - 120, nbf: payload.iat - 120, exp: payload.iat - 60 },
      { ...payload, exp: payload.iat + workflowBounds.tokenSeconds + 1 },
      { ...payload, iat: payload.iat + 30, nbf: payload.iat + 30 },
      { ...payload, draftAnswer: "Never release this procedural trap" },
    ]) await expect(verifyCallback(await token(invalid), keys.publicKey)).rejects.toMatchObject({ status: 401 });
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
    await expect(verifyCallback(unsigned, keys.publicKey)).rejects.toMatchObject({ status: 401 });
    expect(callbackClaims.safeParse({ ...payload, attemptNumber: workflowBounds.maximumAttempts + 1 }).success).toBe(false);
  });

  it("enables the synthetic probe only with explicit flag and local HTTP origin, including Docker production mode", () => {
    expect(workflowProbeEnabled({ SOP_WORKFLOW_PROBE_ENABLED: "1", AUTH_BASE_URL: "http://127.0.0.1:3000", NODE_ENV: "production" })).toBe(true);
    for (const env of [{}, { SOP_WORKFLOW_PROBE_ENABLED: "1", AUTH_BASE_URL: "https://sop.example.invalid" }, { SOP_WORKFLOW_PROBE_ENABLED: "0", AUTH_BASE_URL: "http://localhost:3000" }]) {
      expect(workflowProbeEnabled(env)).toBe(false);
    }
    expect(workflowDispatchUrl({ WORKFLOW_DISPATCH_URL: "http://n8n-main:5678/webhook/sop-s03-probe-v1" })).toContain("n8n-main");
    for (const url of ["http://user:password@n8n-main:5678/webhook/sop-s03-probe-v1", "http://n8n-main/other", "http://n8n-main/webhook/sop-s03-probe-v1?target=evil"]) {
      expect(() => workflowDispatchUrl({ WORKFLOW_DISPATCH_URL: url })).toThrow();
    }
  });

  it("binds reconnect cursors to a specific job and excludes arbitrary event properties from bytes", () => {
    const jobId = randomUUID();
    expect(parseEventCursor(`${jobId}:12`, jobId)).toBe(12);
    expect(parseEventCursor(null, jobId)).toBe(0);
    for (const cursor of [`${randomUUID()}:1`, `${jobId}:-1`, "1", `${jobId}:NaN`]) expect(() => parseEventCursor(cursor, jobId)).toThrow();
    const event = { id: randomUUID(), jobId, attemptId: randomUUID(), sequence: 5, step: 5, kind: "synthetic_completed" as const, createdAt: new Date(), draft: "INJECTED_DRAFT", url: "https://evil.invalid" };
    const bytes = new TextDecoder().decode(serializeWorkflowEvent(event).bytes);
    expect(bytes).toContain(syntheticMarker);
    expect(bytes).toContain('"kind":"synthetic_probe"');
    expect(bytes).not.toMatch(/INJECTED_DRAFT|evil.invalid|judge_passed/);
    expect(new TextDecoder().decode(serializeWorkflowEvent({ ...event, kind: "processing" }).bytes)).not.toContain(syntheticMarker);
  });

  it("keeps dispatcher startup absent during builds and bounds the local-only callback test delay", () => {
    const local = { SOP_WORKFLOW_PROBE_ENABLED: "1", AUTH_BASE_URL: "http://127.0.0.1:3000", WORKFLOW_DISPATCH_ENABLED: "1" };
    expect(workflowDispatcherEnabled(local)).toBe(true);
    expect(workflowDispatcherEnabled({ ...local, NEXT_PHASE: "phase-production-build" })).toBe(false);
    expect(probeCallbackDelayMilliseconds(local)).toBe(0);
    expect(probeCallbackDelayMilliseconds({ ...local, WORKFLOW_PROBE_CALLBACK_DELAY_MS: "2000" })).toBe(2000);
    expect(probeCallbackDelayMilliseconds({ WORKFLOW_PROBE_CALLBACK_DELAY_MS: "2000" })).toBe(0);
    for (const delay of ["-1", "2001", "not-a-number"]) expect(() => probeCallbackDelayMilliseconds({ ...local, WORKFLOW_PROBE_CALLBACK_DELAY_MS: delay })).toThrow();
  });
});
