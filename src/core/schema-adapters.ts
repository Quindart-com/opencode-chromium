import { z } from "zod";
import { record } from "../shared/values.ts";
import { resultSchema } from "./registry.ts";
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

function baseDefinition(name: string, definition: RuntimeTool) {
  return {
    name,
    description: definition.description,
    input: jsonSchemaFor(definition.inputSchema),
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
