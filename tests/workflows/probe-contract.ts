import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { z } from "zod";

const nodeSchema = z.object({
  id: z.string(), name: z.string(), type: z.string(), typeVersion: z.number(),
  parameters: z.record(z.string(), z.unknown()), onError: z.literal("stopWorkflow"),
  credentials: z.record(z.string(), z.object({ id: z.string(), name: z.string() })).optional(),
});
export const syntheticWorkflow = z.object({
  id: z.literal("sop-s03-probe-v1"), active: z.literal(false), nodes: z.array(nodeSchema),
  connections: z.record(z.string(), z.object({ main: z.array(z.array(z.object({ node: z.string(), type: z.literal("main"), index: z.number() }))) })),
  settings: z.object({ saveDataErrorExecution: z.literal("none"), saveDataSuccessExecution: z.literal("none"),
    saveManualExecutions: z.literal(false), saveExecutionProgress: z.literal(false), executionTimeout: z.literal(60) }),
}).parse(JSON.parse(readFileSync("n8n/s03-probe.v1.json", "utf8")));

export function workflowNode(name: string) {
  const node = syntheticWorkflow.nodes.find((value) => value.name === name);
  if (!node) throw new Error(`Missing workflow node: ${name}`);
  return node;
}

export function expressionValue(expression: string, context: Record<string, unknown>) {
  if (!expression.startsWith("={{") || !expression.endsWith("}}")) throw new Error("Expected an n8n expression.");
  return runInNewContext(expression.slice(3, -2), context, { timeout: 1000 }) as unknown;
}

export function ingressAccepts(payload: unknown, body: unknown = {}, query: unknown = {}) {
  const conditions = workflowNode("Validate dispatch policy").parameters.conditions as { conditions: Array<{ leftValue: string }> };
  return expressionValue(conditions.conditions[0].leftValue, { $json: { jwtPayload: payload, body, query }, Date }) === true;
}

export function callbackFromWorkflow(name: string, payload: unknown) {
  const expression = workflowNode(name).parameters.jsonOutput as string;
  const value = expressionValue(expression, { $execution: { id: "synthetic-execution" },
    $: () => ({ first: () => ({ json: { jwtPayload: payload } }) }), Date });
  return JSON.parse(String(value)) as unknown;
}
