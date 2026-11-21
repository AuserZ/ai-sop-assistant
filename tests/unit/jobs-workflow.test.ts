import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { callbackClaims } from "../../src/server/jobs/contracts";
import { callbackFromWorkflow, ingressAccepts, syntheticWorkflow, workflowNode } from "../workflows/probe-contract";

function dispatch() {
  const now = Math.floor(Date.now() / 1000);
  const dispatchNonce = randomUUID();
  return { v: 1, workflow: "s03-probe-v1", purpose: "dispatch", iss: "sop-app", aud: "sop-n8n", method: "POST",
    path: "/webhook/sop-s03-probe-v1", jobId: randomUUID(), attemptId: randomUUID(), attemptNumber: 1,
    dispatchNonce, jti: dispatchNonce, scenario: "success", iat: now, nbf: now, exp: now + 30 };
}

describe("ADR08/19 exported synthetic n8n workflow contract", () => {
  it("rejects forged application claims and unsigned duplicate authority before claiming work", () => {
    const payload = dispatch();
    expect(ingressAccepts(payload)).toBe(true);
    for (const invalid of [
      { ...payload, iss: "foreign" }, { ...payload, aud: "foreign" }, { ...payload, purpose: "callback" },
      { ...payload, path: "/other" }, { ...payload, method: "GET" }, { ...payload, v: 2 },
      { ...payload, workflow: "unapproved" }, { ...payload, attemptNumber: 4 },
      { ...payload, jobId: "not-a-uuid" }, { ...payload, jti: randomUUID() },
      { ...payload, iat: undefined }, { ...payload, exp: payload.iat - 60 },
      { ...payload, exp: payload.iat + 61 }, { ...payload, nbf: payload.iat + 30 },
      { ...payload, draftAnswer: "INJECTED PROCEDURAL TEXT" },
    ]) expect(ingressAccepts(invalid)).toBe(false);
    for (const body of [[], { step: 5 }, { answer: "INJECTED PROCEDURAL TEXT" }, null, ""]) expect(ingressAccepts(payload, body)).toBe(false);
    expect(ingressAccepts(payload, {}, { redirect: "https://evil.invalid" })).toBe(false);
  });

  it("uses only native credential-backed nodes, fixed destinations, empty bodies and no saved executions", () => {
    const allowed = ["webhook", "if", "stopAndError", "set", "jwt", "httpRequest"].map((name) => `n8n-nodes-base.${name}`);
    expect(syntheticWorkflow.nodes.every((node) => allowed.includes(node.type))).toBe(true);
    const ingress = workflowNode("Signed dispatch");
    expect(ingress.parameters).toMatchObject({ httpMethod: "POST", authentication: "jwtAuth", path: "sop-s03-probe-v1", responseMode: "onReceived" });
    expect(ingress.credentials?.jwtAuth.id).toBe("sop-s03-dispatch-v1");
    expect(JSON.stringify(ingress.parameters)).not.toContain("onlyRunIf");
    for (const node of syntheticWorkflow.nodes.filter((value) => value.type === "n8n-nodes-base.jwt")) {
      expect(node.parameters).toMatchObject({ operation: "sign", useJson: true, options: { algorithm: "RS256" } });
      expect(node.credentials?.jwtAuth.id).toBe("sop-s03-callback-v1");
    }
    for (const node of syntheticWorkflow.nodes.filter((value) => value.type === "n8n-nodes-base.httpRequest")) {
      expect(node.parameters).toMatchObject({ method: "POST", contentType: "json", specifyBody: "json", jsonBody: "{}" });
      expect(node.parameters.options).toMatchObject({ redirect: { redirect: { followRedirects: false } }, timeout: 5000 });
      expect(node.parameters.url).toMatch(/^=\{\{ 'http:\/\/app:3000' \+/);
    }
    expect(JSON.stringify(syntheticWorkflow)).not.toMatch(/BEGIN PRIVATE KEY|\$env|process\.env|require\(|readFile|credentialSecret/);
  });

  it("signs each authoritative callback field and separates the negative gate from completion", () => {
    const payload = dispatch();
    const names = ["Build claim", "Build processing", "Build deterministic check", "Build judge stub", "Build synthetic completion"];
    const nonces = new Set<string>();
    for (const [index, name] of names.entries()) {
      const claims = callbackClaims.parse(callbackFromWorkflow(name, payload));
      expect(claims).toMatchObject({ jobId: payload.jobId, attemptId: payload.attemptId, dispatchNonce: payload.dispatchNonce,
        executionId: "synthetic-execution", step: index + 1, purpose: index === 0 ? "claim" : "callback" });
      nonces.add(claims.jti);
    }
    expect(nonces.size).toBe(5);
    const negative = callbackClaims.parse(callbackFromWorkflow("Build deterministic check", { ...payload, scenario: "validation_failure" }));
    expect(negative.outcome).toBe("fail");
    expect(syntheticWorkflow.connections["Validate dispatch policy"].main[1][0].node).toBe("Reject invalid dispatch");
    expect(syntheticWorkflow.connections["Continue only after synthetic pass"].main[0][0].node).toBe("Build judge stub");
    expect(syntheticWorkflow.connections["Continue only after synthetic pass"].main[1] ?? []).toHaveLength(0);
  });
});
