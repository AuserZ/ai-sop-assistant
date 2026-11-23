import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { z } from "zod";

const nodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  typeVersion: z.number(),
  parameters: z.record(z.string(), z.unknown()),
  onError: z.literal("stopWorkflow"),
  credentials: z.record(z.string(), z.object({ id: z.string(), name: z.string() })).optional(),
});

export const ingestionWorkflow = z.object({
  id: z.literal("sop-s05-ingestion-v1"),
  active: z.literal(false),
  nodes: z.array(nodeSchema),
  connections: z.record(
    z.string(),
    z.object({
      main: z.array(z.array(z.object({ node: z.string(), type: z.literal("main"), index: z.number() }))),
    }),
  ),
  settings: z.object({
    saveDataErrorExecution: z.literal("none"),
    saveDataSuccessExecution: z.literal("none"),
    saveManualExecutions: z.literal(false),
    saveExecutionProgress: z.literal(false),
    executionTimeout: z.literal(300),
  }),
}).parse(JSON.parse(readFileSync("n8n/s05-ingestion.v1.json", "utf8")));

export function ingestionWorkflowNode(name: string) {
  const node = ingestionWorkflow.nodes.find((value) => value.name === name);
  if (!node) throw new Error(`Missing ingestion workflow node: ${name}`);
  return node;
}

export function ingestionExpressionValue(expression: string, context: Record<string, unknown>) {
  if (!expression.startsWith("={{") || !expression.endsWith("}}")) {
    throw new Error("Expected an n8n expression.");
  }
  return runInNewContext(expression.slice(3, -2), context, { timeout: 1000 }) as unknown;
}

export function ingestionIngressAccepts(payload: unknown, body: unknown = {}, query: unknown = {}) {
  const conditions = ingestionWorkflowNode("Validate dispatch policy").parameters.conditions as {
    conditions: Array<{ leftValue: string }>;
  };
  return ingestionExpressionValue(conditions.conditions[0].leftValue, { $json: { jwtPayload: payload, body, query }, Date }) === true;
}

export function ingestionCallbackFromWorkflow(name: string, payload: unknown) {
  const expression = ingestionWorkflowNode(name).parameters.jsonOutput as string;
  const value = ingestionExpressionValue(expression, {
    $execution: { id: "synthetic-ingestion-exec" },
    $: () => ({ first: () => ({ json: { jwtPayload: payload } }) }),
    Date,
  });
  return JSON.parse(String(value)) as unknown;
}

export function evaluateWorkflowCondition(nodeName: string, json: unknown) {
  const conditions = ingestionWorkflowNode(nodeName).parameters.conditions as {
    conditions: Array<{ leftValue: string }>;
  };
  return ingestionExpressionValue(conditions.conditions[0].leftValue, { $json: json, Date }) === true;
}
