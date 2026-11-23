import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ingestionCallbackClaims } from "../../src/server/jobs/contracts";
import {
  evaluateWorkflowCondition,
  ingestionCallbackFromWorkflow,
  ingestionIngressAccepts,
  ingestionWorkflow,
  ingestionWorkflowNode,
} from "../workflows/ingestion-contract";

function dispatchPayload() {
  const now = Math.floor(Date.now() / 1000);
  const dispatchNonce = randomUUID();
  return {
    v: 1,
    workflow: "s05-ingestion-v1",
    purpose: "dispatch",
    iss: "sop-app",
    aud: "sop-n8n",
    method: "POST",
    path: "/webhook/sop-s05-ingestion-v1",
    jobId: randomUUID(),
    documentId: randomUUID(),
    sourceSha256: "a".repeat(64),
    pipelineVersion: "document-ingestion-v1",
    attemptId: randomUUID(),
    attemptNumber: 1,
    dispatchNonce,
    jti: dispatchNonce,
    iat: now,
    nbf: now,
    exp: now + 30,
  };
}

describe("D3/ADR08 exported S05 ingestion n8n workflow contract", () => {
  it("enforces strict signed dispatch claims and rejects forged/extra fields or non-empty body/query", () => {
    const payload = dispatchPayload();
    expect(ingestionIngressAccepts(payload)).toBe(true);
    for (const invalid of [
      { ...payload, iss: "foreign" },
      { ...payload, aud: "foreign" },
      { ...payload, workflow: "s03-probe-v1" },
      { ...payload, path: "/webhook/other" },
      { ...payload, documentId: "not-a-uuid" },
      { ...payload, sourceSha256: "ZZZZ" },
      { ...payload, attemptNumber: 4 },
      { ...payload, jti: randomUUID() },
      { ...payload, exp: payload.iat + 61 },
      { ...payload, status: "ACTIVE" },
    ]) {
      expect(ingestionIngressAccepts(invalid)).toBe(false);
    }
    for (const body of [{ status: "ACTIVE" }, [], null, "raw"]) {
      expect(ingestionIngressAccepts(payload, body)).toBe(false);
    }
    expect(ingestionIngressAccepts(payload, {}, { redirect: "https://evil.invalid" })).toBe(false);
  });

  it("uses only native allowlisted nodes, fixed app destinations, no redirects, no secrets and no saved executions", () => {
    const allowed = ["webhook", "if", "stopAndError", "set", "jwt", "httpRequest"].map((name) => `n8n-nodes-base.${name}`);
    expect(ingestionWorkflow.nodes.every((node) => allowed.includes(node.type))).toBe(true);

    const ingress = ingestionWorkflowNode("Signed dispatch");
    expect(ingress.parameters).toMatchObject({
      httpMethod: "POST",
      authentication: "jwtAuth",
      path: "sop-s05-ingestion-v1",
      responseMode: "onReceived",
    });
    expect(ingress.credentials?.jwtAuth.id).toBe("sop-s03-dispatch-v1");

    for (const node of ingestionWorkflow.nodes.filter((entry) => entry.type === "n8n-nodes-base.jwt")) {
      expect(node.parameters).toMatchObject({ operation: "sign", useJson: true, options: { algorithm: "RS256" } });
      expect(node.credentials?.jwtAuth.id).toBe("sop-s03-callback-v1");
    }

    for (const node of ingestionWorkflow.nodes.filter((entry) => entry.type === "n8n-nodes-base.httpRequest")) {
      expect(node.parameters).toMatchObject({ method: "POST", contentType: "json", specifyBody: "json" });
      expect(node.parameters.options).toMatchObject({ redirect: { redirect: { followRedirects: false } } });
      expect(node.parameters.url).toMatch(/^=\{\{ 'http:\/\/app:3000' \+/);
    }

    expect(JSON.stringify(ingestionWorkflow)).not.toMatch(/BEGIN PRIVATE KEY|\$env|process\.env|require\(|readFile|credentialSecret|OPENAI_API_KEY/);
  });

  it("produces unique signed callbacks per stage and wires expired fileRefToken renewal into chunking", () => {
    const payload = dispatchPayload();
    const builders = [
      { name: "Build claim", purpose: "claim" },
      { name: "Build extract", purpose: "extract" },
      { name: "Build renew source ref", purpose: "renew-source-ref" },
      { name: "Build extract retry", purpose: "extract" },
      { name: "Build chunk", purpose: "chunk" },
      { name: "Build embed", purpose: "embed" },
      { name: "Build complete", purpose: "complete" },
    ] as const;

    const nonces = new Set<string>();
    for (const builder of builders) {
      const claims = ingestionCallbackClaims.parse(ingestionCallbackFromWorkflow(builder.name, payload));
      expect(claims).toMatchObject({
        jobId: payload.jobId,
        documentId: payload.documentId,
        sourceSha256: payload.sourceSha256,
        pipelineVersion: payload.pipelineVersion,
        attemptId: payload.attemptId,
        dispatchNonce: payload.dispatchNonce,
        purpose: builder.purpose,
        path: `/api/internal/ingestion/${payload.jobId}/${builder.purpose}`,
        executionId: "synthetic-ingestion-exec",
      });
      nonces.add(claims.jti);
    }
    expect(nonces.size).toBe(builders.length);

    expect(evaluateWorkflowCondition("Check extract ref expired", { statusCode: 401, body: { error: { code: "SOURCE_REF_EXPIRED" } } })).toBe(true);
    expect(evaluateWorkflowCondition("Check extract ref expired", { statusCode: 200, body: { accepted: true } })).toBe(false);
    expect(evaluateWorkflowCondition("Check extract ok", { statusCode: 200, body: { accepted: true } })).toBe(true);
    expect(evaluateWorkflowCondition("Check extract ok", { statusCode: 503, body: { error: { code: "OCR_WORKER_TRANSIENT" } } })).toBe(false);

    expect(ingestionWorkflow.connections["Validate dispatch policy"].main[1][0].node).toBe("Reject invalid dispatch");
    expect(ingestionWorkflow.connections["Check extract ref expired"].main[0][0].node).toBe("Build renew source ref");
    expect(ingestionWorkflow.connections["Check extract ref expired"].main[1][0].node).toBe("Check extract ok");
    expect(ingestionWorkflow.connections["Send extract retry"].main[0][0].node).toBe("Build chunk");
    expect(ingestionWorkflow.connections["Check extract ok"].main[0][0].node).toBe("Build chunk");
    expect(ingestionWorkflow.connections["Check extract ok"].main[1][0].node).toBe("Stop extract error");
  });
});
