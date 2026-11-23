import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chatCallbackClaims,
  chatCallbackFromWorkflow,
  chatDispatchClaims,
  chatHttpNodeUrl,
  chatIngressAccepts,
  chatWorkflow,
  chatWorkflowId,
  chatWorkflowNode,
  evaluateChatCondition,
} from "../workflows/chat-contract";

function dispatchPayload() {
  const now = Math.floor(Date.now() / 1000);
  const dispatchNonce = randomUUID();
  return {
    v: 1,
    workflow: "s11-chat-v1",
    purpose: "dispatch",
    iss: "sop-app",
    aud: "sop-n8n",
    method: "POST",
    path: "/webhook/sop-s11-chat-v1",
    jobId: randomUUID(),
    conversationId: randomUUID(),
    requestKey: randomUUID(),
    attemptId: randomUUID(),
    attemptNumber: 1,
    dispatchNonce,
    jti: dispatchNonce,
    iat: now,
    nbf: now,
    exp: now + 60,
  };
}

describe("C1-C5/ADR08/18/19 exported S11 safe chat n8n workflow contract", () => {
  it("enforces strict 17-claim signed dispatch policy and rejects tampered JWTs or non-empty body/query", () => {
    const payload = dispatchPayload();
    expect(chatDispatchClaims.parse(payload)).toEqual(payload);
    expect(chatIngressAccepts(payload)).toBe(true);
    expect(chatIngressAccepts(payload, {}, undefined)).toBe(true);

    const missingConversation = { ...payload } as Record<string, unknown>;
    delete missingConversation.conversationId;
    const missingRequestKey = { ...payload } as Record<string, unknown>;
    delete missingRequestKey.requestKey;

    const nonV4Uuid = "550e8400-e29b-11d4-a716-446655440000";

    for (const invalid of [
      null,
      [],
      missingConversation,
      missingRequestKey,
      { ...payload, v: 2 },
      { ...payload, workflow: "s05-ingestion-v1" },
      { ...payload, purpose: "claim" },
      { ...payload, iss: "foreign" },
      { ...payload, aud: "foreign" },
      { ...payload, method: "GET" },
      { ...payload, path: "/webhook/other" },
      { ...payload, jobId: "not-a-uuid" },
      { ...payload, jobId: nonV4Uuid },
      { ...payload, conversationId: "not-a-uuid" },
      { ...payload, requestKey: nonV4Uuid },
      { ...payload, attemptId: "not-a-uuid" },
      { ...payload, dispatchNonce: "not-a-uuid", jti: "not-a-uuid" },
      { ...payload, jti: randomUUID() },
      { ...payload, attemptNumber: 0 },
      { ...payload, attemptNumber: 4 },
      { ...payload, attemptNumber: 1.5 },
      { ...payload, iat: payload.iat + 4, nbf: payload.iat + 4, exp: payload.iat + 34 },
      { ...payload, iat: payload.iat - 61, nbf: payload.iat - 61, exp: payload.iat - 1 },
      { ...payload, nbf: payload.iat + 1 },
      { ...payload, exp: payload.iat },
      { ...payload, exp: payload.iat + 61 },
      { ...payload, exp: payload.iat - 10 },
      { ...payload, iat: payload.iat + 0.5 },
      { ...payload, sopPassage: "UNTRUSTED SOP TEXT" },
      { ...payload, draftAnswer: "INJECTED PROCEDURAL TEXT" },
    ]) {
      expect(chatIngressAccepts(invalid, {}, {}, payload.iat * 1000)).toBe(false);
    }

    for (const body of [{ question: "override" }, { terminal: true }, [], null, "raw"]) {
      expect(chatIngressAccepts(payload, body)).toBe(false);
    }
    for (const query of [{ redirect: "https://evil.invalid" }, [], null, "raw"]) {
      expect(chatIngressAccepts(payload, {}, query)).toBe(false);
    }

    const rejectNode = chatWorkflowNode("Reject invalid dispatch");
    expect(rejectNode.type).toBe("n8n-nodes-base.stopAndError");
    expect(rejectNode.parameters).toMatchObject({
      errorType: "errorMessage",
      errorMessage: "INVALID_WORKFLOW_DISPATCH",
    });
    expect(chatWorkflow.connections["Validate dispatch policy"].main[1][0].node).toBe("Reject invalid dispatch");
  });

  it("uses only native allowlisted nodes, RS256 credentials, no redirects, empty callback bodies and no secrets", () => {
    const allowed = ["webhook", "if", "stopAndError", "set", "jwt", "httpRequest"].map((name) => `n8n-nodes-base.${name}`);
    const forbidden = ["code", "executeCommand", "localFileTrigger", "readWriteFile"].map((name) => `n8n-nodes-base.${name}`);
    expect(chatWorkflow.nodes.every((node) => allowed.includes(node.type))).toBe(true);
    expect(chatWorkflow.nodes.some((node) => forbidden.includes(node.type))).toBe(false);

    const ingress = chatWorkflowNode("Signed dispatch");
    expect(ingress.webhookId).toBe(chatWorkflowId);
    expect(ingress.parameters).toMatchObject({
      httpMethod: "POST",
      path: chatWorkflowId,
      authentication: "jwtAuth",
      responseMode: "onReceived",
    });
    expect(ingress.credentials?.jwtAuth.id).toBe("sop-s03-dispatch-v1");

    const jwtNodes = chatWorkflow.nodes.filter((node) => node.type === "n8n-nodes-base.jwt");
    expect(jwtNodes).toHaveLength(5);
    for (const node of jwtNodes) {
      expect(node.parameters).toMatchObject({
        operation: "sign",
        useJson: true,
        headerClaims: "{\"typ\":\"JWT\"}",
        options: { algorithm: "RS256" },
      });
      expect(node.credentials?.jwtAuth.id).toBe("sop-s03-callback-v1");
    }

    const httpNodes = chatWorkflow.nodes.filter((node) => node.type === "n8n-nodes-base.httpRequest");
    expect(httpNodes).toHaveLength(5);
    for (const node of httpNodes) {
      expect(node.parameters).toMatchObject({
        method: "POST",
        sendHeaders: true,
        sendBody: true,
        contentType: "json",
        specifyBody: "json",
        jsonBody: "{}",
      });
      expect(node.parameters.options).toMatchObject({
        redirect: { redirect: { followRedirects: false } },
      });
      expect(node.parameters.url).toMatch(/^=\{\{ 'http:\/\/app:3000' \+/);
    }

    expect(chatWorkflowNode("Call claim").parameters.options).toMatchObject({ timeout: 10_000 });
    expect(chatWorkflowNode("Call retrieve").parameters.options).toMatchObject({ timeout: 30_000 });
    expect(chatWorkflowNode("Call generate").parameters.options).toMatchObject({ timeout: 30_000 });
    expect(chatWorkflowNode("Call validate").parameters.options).toMatchObject({ timeout: 30_000 });
    expect(chatWorkflowNode("Call fail").parameters.options).toMatchObject({ timeout: 10_000 });

    const serialized = JSON.stringify(chatWorkflow);
    expect(serialized).not.toMatch(/BEGIN PRIVATE KEY|\$env|process\.env|require\(|readFile|credentialSecret|OPENAI_API_KEY|https:\/\//);
  });

  it("produces unique RS256 callback claims, enforces terminal short-circuits and wires stage errors to fail", () => {
    const payload = dispatchPayload();
    const stages = [
      { build: "Build claim", call: "Call claim", purpose: "claim" },
      { build: "Build retrieve", call: "Call retrieve", purpose: "retrieve" },
      { build: "Build generate", call: "Call generate", purpose: "generate" },
      { build: "Build validate", call: "Call validate", purpose: "validate" },
      { build: "Build fail", call: "Call fail", purpose: "fail" },
    ] as const;

    const jtis = new Set<string>();
    for (const stage of stages) {
      const claims = chatCallbackClaims.parse(chatCallbackFromWorkflow(stage.build, payload));
      expect(claims).toMatchObject({
        v: 1,
        workflow: "s11-chat-v1",
        purpose: stage.purpose,
        iss: "sop-n8n",
        aud: "sop-app",
        method: "POST",
        path: `/api/internal/chat/${payload.jobId}/${stage.purpose}`,
        jobId: payload.jobId,
        conversationId: payload.conversationId,
        requestKey: payload.requestKey,
        attemptId: payload.attemptId,
        attemptNumber: payload.attemptNumber,
        dispatchNonce: payload.dispatchNonce,
        executionId: "synthetic-chat-exec",
        jti: `${payload.attemptId}:synthetic-chat-exec:${stage.purpose}`,
      });
      expect(claims.exp - claims.iat).toBe(60);
      expect(claims.nbf).toBe(claims.iat);
      expect(chatHttpNodeUrl(stage.call, stage.build, payload)).toBe(
        `http://app:3000/api/internal/chat/${payload.jobId}/${stage.purpose}`,
      );
      jtis.add(claims.jti);
    }
    expect(jtis.size).toBe(stages.length);

    expect(evaluateChatCondition("Check retrieve terminal", { terminal: true })).toBe(true);
    expect(evaluateChatCondition("Check retrieve terminal", { terminal: false })).toBe(false);
    expect(evaluateChatCondition("Check retrieve terminal", { terminal: "true" })).toBe(false);
    expect(evaluateChatCondition("Check retrieve terminal", {})).toBe(false);
    expect(evaluateChatCondition("Check generate terminal", { terminal: true })).toBe(true);
    expect(evaluateChatCondition("Check generate terminal", { terminal: false })).toBe(false);

    expect(chatWorkflow.connections["Call claim"].main[0][0].node).toBe("Build retrieve");
    expect(chatWorkflow.connections["Call retrieve"].main[0][0].node).toBe("Check retrieve terminal");
    expect(chatWorkflow.connections["Check retrieve terminal"].main[0]).toEqual([]);
    expect(chatWorkflow.connections["Check retrieve terminal"].main[1][0].node).toBe("Build generate");
    expect(chatWorkflow.connections["Call generate"].main[0][0].node).toBe("Check generate terminal");
    expect(chatWorkflow.connections["Check generate terminal"].main[0]).toEqual([]);
    expect(chatWorkflow.connections["Check generate terminal"].main[1][0].node).toBe("Build validate");
    expect(chatWorkflow.connections["Call validate"].main[0]).toEqual([]);

    for (const nodeName of ["Call claim", "Call retrieve", "Call generate", "Call validate"]) {
      expect(chatWorkflowNode(nodeName).onError).toBe("continueErrorOutput");
      expect(chatWorkflow.connections[nodeName].main[1][0].node).toBe("Build fail");
    }

    expect(chatWorkflowNode("Call fail").onError).toBe("stopWorkflow");
    expect(chatWorkflow.connections["Build fail"].main[0][0].node).toBe("Sign fail");
    expect(chatWorkflow.connections["Sign fail"].main[0][0].node).toBe("Call fail");
    expect(chatWorkflow.connections["Call fail"]).toBeUndefined();
  });

  it("registers sop-s11-chat-v1 in n8n bootstrap and chat dispatch/fixture flags in Docker Compose", () => {
    const bootstrapSource = readFileSync("infra/n8n/bootstrap.mjs", "utf8");
    expect(bootstrapSource).toContain(`{ id: "sop-s11-chat-v1", path: "/opt/sop/workflows/s11-chat.v1.json" }`);

    const composeSource = readFileSync("docker-compose.yml", "utf8");
    expect(composeSource).toContain('CHAT_DISPATCH_ENABLED: "1"');
    expect(composeSource).toContain("CHAT_DISPATCH_URL: http://n8n-main:5678/webhook/sop-s11-chat-v1");

    const storageFixtureCompose = readFileSync("infra/storage-fixture/compose.yml", "utf8");
    expect(storageFixtureCompose).toContain('SOP_LOCAL_RETRIEVAL_FIXTURE_ENABLED: "1"');
    expect(storageFixtureCompose).toContain('SOP_LOCAL_ANSWER_FIXTURE_ENABLED: "1"');
  });
});
