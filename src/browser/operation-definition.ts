import { z } from "zod";
import type { BrowserContext } from "../core/tool-definition.ts";

export interface BrowserOperation {
  description: string;
  args: z.ZodRawShape;
  capabilityOnly?: boolean;
  execute(input: unknown, context: BrowserContext): Promise<string>;
}

export function defineBrowserOperation<S extends z.ZodRawShape>(definition: {
  description: string;
  args: S;
  execute(input: z.output<z.ZodObject<S>>, context: BrowserContext): string | Promise<string>;
}): BrowserOperation {
  const schema = z.object(definition.args);
  return { ...definition, async execute(input, context) { return definition.execute(schema.parse(input), context); } };
}

export function defineObjectOperation<S extends z.ZodRawShape>(definition: {
  args: S; description?: string; capabilityOnly?: boolean;
  execute(input: z.output<z.ZodObject<S>>, context: import("../core/tool-definition.ts").BrowserContext): unknown | Promise<unknown>;
}): BrowserOperation {
  const schema = z.object(definition.args);
  return { ...definition, description: definition.description ?? "Inspect the controlled browser.",
    async execute(input, context) { return JSON.stringify(await definition.execute(schema.parse(input), context)); } };
}
