import { z } from "zod";
export const callFrameSchema = z.object({ functionName: z.string().optional(), url: z.string().optional(), lineNumber: z.number().optional(), columnNumber: z.number().optional() });
export const stackTraceSchema = z.object({ callFrames: z.array(callFrameSchema).default([]) });
const consoleArgumentSchema = z.object({ value: z.unknown(), description: z.string().optional(), preview: z.object({ description: z.string().optional() }).optional(), type: z.string().optional() });
const entrySchema = z.object({ text: z.string().optional(), level: z.string().optional(), url: z.string().optional(), source: z.string().optional(), stackTrace: stackTraceSchema.optional() });
export const eventSchema = z.looseObject({ method: z.string(), time: z.union([z.string(), z.number()]).optional(), tabId: z.number().optional(), params: z.looseObject({
  args: z.array(consoleArgumentSchema).optional(), entry: entrySchema.optional(), text: z.string().optional(), type: z.string().optional(), stackTrace: stackTraceSchema.optional(),
  message: z.string().optional(), url: z.string().optional(), hasBrowserHandler: z.boolean().optional(), defaultPrompt: z.string().optional(), result: z.boolean().optional(), userInput: z.string().optional(),
  timestamp: z.number().optional(), requestId: z.string().optional(), request: z.looseObject({ url: z.string().optional(), method: z.string().optional() }).optional(),
  response: z.looseObject({ url: z.string().optional(), status: z.number().optional(), mimeType: z.string().optional() }).optional(), documentURL: z.string().optional(),
  errorText: z.string().optional(), blockedReason: z.string().optional(),
}).default({}) });
export const eventResponseSchema = z.looseObject({ events: z.array(eventSchema).default([]) });
export type BrowserEvent = z.infer<typeof eventSchema>;
export type BrowserEvents = z.infer<typeof eventResponseSchema>;
export const browserTabSchema = z.looseObject({ id: z.number().int().positive(), tabId: z.number().int().positive().optional(), url: z.string().optional(), title: z.string().optional() });
export const extensionResultSchemas = {
  getTab: browserTabSchema, createTab: browserTabSchema, claimUserTab: browserTabSchema, getSelectedTab: browserTabSchema.nullable(),
  getTabs: z.looseObject({ tabs: z.array(browserTabSchema) }), getUserTabs: z.looseObject({ tabs: z.array(browserTabSchema) }),
  getEvents: eventResponseSchema, getCdpEvents: eventResponseSchema,
  "trace.collect": z.looseObject({ complete: z.boolean(), chunks: z.array(z.string()), eventCount: z.number(), chunkCount: z.number(), overflowed: z.boolean().optional() }), uploadPolicy: z.looseObject({ version: z.number() }),
};
export type ExtensionMethod = keyof typeof extensionResultSchemas;
export type ExtensionResult<K extends string> = K extends ExtensionMethod ? z.output<typeof extensionResultSchemas[K]> : Record<string, unknown>;
