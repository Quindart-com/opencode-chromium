import { z } from "zod";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function sanitizeJsonSchema(node) {
  if (Array.isArray(node)) return node.map(sanitizeJsonSchema);
  if (!node || typeof node !== "object") return node;
  const output = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "maximum" && value === MAX_SAFE) continue;
    if (key === "minimum" && value === -MAX_SAFE) continue;
    output[key] = sanitizeJsonSchema(value);
  }
  return output;
}

export function jsonSchemaFor(schema) {
  return sanitizeJsonSchema(z.toJSONSchema(schema, { target: "draft-7" }));
}

function baseDefinition(name, definition) {
  return {
    name,
    description: definition.description,
    input: jsonSchemaFor(definition.inputSchema),
    output: jsonSchemaFor(definition.outputSchema),
  };
}

export function toolDefinitionsForDialect(registry, dialect = "mcp") {
  return Object.entries(registry).map(([name, definition]) => {
    const base = baseDefinition(name, definition);
    if (dialect === "mcp") {
      return { name, description: base.description, inputSchema: base.input, outputSchema: base.output, annotations: definition.annotations };
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

export async function dispatchBrowserTool(registry, name, args, context = {}) {
  const definition = registry[name];
  if (!definition) throw new Error(`Unknown browser tool: ${name}`);
  const parsed = definition.inputSchema.parse(args ?? {});
  return definition.outputSchema.parse(await definition.execute(parsed, context));
}
