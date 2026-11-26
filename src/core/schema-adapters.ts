import { z } from "zod";
import { record } from "../shared/values.ts";
import { finalizeInputSchema,observeInputSchema,resultSchema,runInputSchema,sessionInputSchema } from "./registry.ts";
import type { BrowserContext,RuntimeTool } from "./tool-definition.ts";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function sanitizeJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeJsonSchema);
  if (!node || typeof node !== "object") return node;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "maximum" && value === MAX_SAFE) continue;
    if (key === "minimum" && value === -MAX_SAFE) continue;
    output[key] = sanitizeJsonSchema(value);
  }
  return output;
}

export function jsonSchemaFor(schema: z.ZodType) {
  return record(sanitizeJsonSchema(z.toJSONSchema(schema, { target: "draft-7" })));
}

export function fullToolInput(name?: string) {
  const schemas = new Map([["browser_run", runInputSchema as z.ZodType], ["browser_observe", observeInputSchema], ["browser_session", sessionInputSchema], ["browser_finalize", finalizeInputSchema]]);
  const schema = name && schemas.get(name);
  if (name && !schema) throw new Error("Unknown core browser tool");
  return schema ? { name, inputSchema: jsonSchemaFor(schema) } : { tools: [...schemas.keys()], hint: "Pass the tool name as query." };
}

// Keep advanced overrides callable. Only their documentation is loaded on demand.
function advertise(value: unknown, fields: string[]) {
  const schema = record(value), properties = record(schema.properties);
  return { ...schema, additionalProperties: true,
    properties: Object.fromEntries(fields.filter(key => Object.hasOwn(properties, key)).map(key => [key, properties[key]])) };
}

export function agentInputSchema(name: string, input: z.ZodType) {
  const full = jsonSchemaFor(input);
  const session = ["sessionId", "profile"];
  const observation = ["mode", "query", "source", "target", "fullPage", "pack", "uri"];
  if (name === "browser_session") return advertise(full, [...session, "action", "tabId", "scope", "name"]);
  if (name === "browser_observe") return advertise(full, [...session, ...observation, "tabId", "delivery"]);
  if (name !== "browser_run") return full;
  const schema = advertise(full, [...session, "tab", "steps", "postObserve", "approvalToken", "approvalDecision", "returnMode"]);
  const steps = record(schema.properties.steps);
  schema.properties.steps = { ...steps, items: advertise(steps.items, ["id", "action", "target", "url", "value", "key", "fields", "capability", "input", "settle"]) };
  schema.properties.postObserve = advertise(schema.properties.postObserve, observation);
  return schema;
}

function baseDefinition(name: string, definition: RuntimeTool) {
  return {
    name,
    description: definition.description,
    input: agentInputSchema(name, definition.inputSchema),
    output: jsonSchemaFor(definition.outputSchema),
  };
}

export function toolDefinitionsForDialect(registry: Record<string, RuntimeTool>, dialect = "mcp") {
  return Object.entries(registry).map(([name, definition]) => {
    const base = baseDefinition(name, definition);
    if (dialect === "mcp") {
      // MCP output schemas are optional. Result validation remains enforced at
      // execution time; omitting the repeated envelope saves substantial tool
      // context without weakening runtime validation.
      return { name, description: base.description, inputSchema: base.input, annotations: definition.annotations };
    }
    if (dialect === "openai") {
      return { type: "function", name, description: base.description, parameters: base.input, strict: false };
    }
    if (dialect === "anthropic") {
      return { name, description: base.description, input_schema: base.input };
    }
    if (dialect === "gemini") {
      return { name, description: base.description, parameters: base.input };
    }
    throw new Error(`Unsupported tool schema dialect: ${dialect}`);
  });
}

export async function dispatchBrowserTool(registry: Record<string, RuntimeTool>, name: string, args: unknown, context: BrowserContext = {}) {
  const definition = registry[name];
  if (!definition) throw new Error(`Unknown browser tool: ${name}`);
  return resultSchema.parse(definition.outputSchema.parse(await definition.execute(args ?? {}, context)));
}
