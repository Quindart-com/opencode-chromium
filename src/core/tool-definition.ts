import { z } from "zod";
import type { FilePolicy } from "../browser/file-policy.ts";
import type { UrlPolicy } from "../browser/url-policy.ts";

export interface BrowserContext {
  sessionId?: string;
  sessionID?: string;
  session_id?: string;
  messageID?: string;
  messageId?: string;
  turnID?: string;
  turnId?: string;
  requestID?: string;
  requestId?: string;
  urlPolicy?: UrlPolicy;
  filePolicy?: FilePolicy;
  signal?: AbortSignal;
  agent?: string;
}
export interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }
export interface RuntimeTool {
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  execute(input: unknown, context: BrowserContext): Promise<unknown>;
}

/** Retain the schema/input relationship inside a closure when tools enter a heterogeneous registry. */
export function defineRuntimeTool<S extends z.ZodType>(definition: {
  description: string;
  inputSchema: S;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
  execute(input: z.output<S>, context: BrowserContext): unknown | Promise<unknown>;
}): RuntimeTool {
  return { ...definition, async execute(input, context) { return definition.execute(definition.inputSchema.parse(input), context); } };
}
