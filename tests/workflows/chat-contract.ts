import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { z } from "zod";

export const chatWorkflowId = "sop-s11-chat-v1";
export const chatWorkflowVersion = "s11-chat-v1";
export const chatCallbackPurposes = ["claim", "retrieve", "generate", "validate", "fail"] as const;
export type ChatCallbackPurpose = (typeof chatCallbackPurposes)[number];

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const chatIdentity = {
  v: z.literal(1),
  workflow: z.literal(chatWorkflowVersion),
  jobId: z.string().regex(uuidV4Pattern),
  conversationId: z.string().regex(uuidV4Pattern),
  requestKey: z.string().regex(uuidV4Pattern),
  attemptId: z.string().regex(uuidV4Pattern),
  attemptNumber: z.number().int().min(1).max(3),
  dispatchNonce: z.string().regex(uuidV4Pattern),
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

const nodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  typeVersion: z.number(),
  parameters: z.record(z.string(), z.unknown()),
  onError: z.enum(["stopWorkflow", "continueErrorOutput"]),
  credentials: z.record(z.string(), z.object({ id: z.string(), name: z.string() })).optional(),
  webhookId: z.string().optional(),
});

export const chatWorkflow = z.object({
  id: z.literal(chatWorkflowId),
  name: z.literal("S11 Safe SOP chat orchestration"),
  active: z.literal(false),
  nodes: z.array(nodeSchema),
  connections: z.record(
    z.string(),
    z.object({
      main: z.array(z.array(z.object({ node: z.string(), type: z.literal("main"), index: z.number() }))),
    }),
  ),
  settings: z.object({
    executionOrder: z.literal("v1"),
    saveDataErrorExecution: z.literal("none"),
    saveDataSuccessExecution: z.literal("none"),
    saveManualExecutions: z.literal(false),
    saveExecutionProgress: z.literal(false),
    executionTimeout: z.literal(120),
  }),
}).parse(JSON.parse(readFileSync("n8n/s11-chat.v1.json", "utf8")));

export function chatWorkflowNode(name: string) {
  const node = chatWorkflow.nodes.find((value) => value.name === name);
  if (!node) throw new Error(`Missing chat workflow node: ${name}`);
  return node;
}

export function chatExpressionValue(expression: string, context: Record<string, unknown>) {
  if (!expression.startsWith("={{") || !expression.endsWith("}}")) {
    throw new Error("Expected an n8n expression.");
  }
  return runInNewContext(expression.slice(3, -2), context, { timeout: 1000 }) as unknown;
}

export function chatIngressAccepts(
  payload: unknown,
  body: unknown = {},
  query: unknown = {},
  nowMilliseconds: number = Date.now(),
) {
  const conditions = chatWorkflowNode("Validate dispatch policy").parameters.conditions as {
    conditions: Array<{ leftValue: string }>;
  };
  return chatExpressionValue(conditions.conditions[0].leftValue, {
    $json: { jwtPayload: payload, body, query },
    Date: { now: () => nowMilliseconds },
  }) === true;
}

export function chatCallbackFromWorkflow(name: string, payload: unknown, executionId = "synthetic-chat-exec") {
  const expression = chatWorkflowNode(name).parameters.jsonOutput as string;
  const value = chatExpressionValue(expression, {
    $execution: { id: executionId },
    $: () => ({ first: () => ({ json: { jwtPayload: payload } }) }),
    Date,
  });
  return JSON.parse(String(value)) as unknown;
}

export function evaluateChatCondition(nodeName: string, json: unknown) {
  const conditions = chatWorkflowNode(nodeName).parameters.conditions as {
    conditions: Array<{ leftValue: string }>;
  };
  return chatExpressionValue(conditions.conditions[0].leftValue, { $json: json, Date }) === true;
}

export function chatHttpNodeUrl(callNodeName: string, buildNodeName: string, payload: unknown, executionId = "synthetic-chat-exec") {
  const built = chatCallbackFromWorkflow(buildNodeName, payload, executionId);
  const urlExpression = chatWorkflowNode(callNodeName).parameters.url as string;
  return String(
    chatExpressionValue(urlExpression, {
      $: (nodeName: string) => {
        if (nodeName !== buildNodeName) throw new Error(`Unexpected node reference: ${nodeName}`);
        return { first: () => ({ json: built }) };
      },
      Date,
    }),
  );
}
