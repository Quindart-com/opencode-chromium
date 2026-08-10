import { z } from "zod";

const sessionFields = {
  sessionId: z.string().min(1).max(160).optional(),
  profile: z.string().min(1).max(160).optional(),
};

const targetSchema = z.object({
  nodeId: z.string().optional(),
  selector: z.string().optional(),
  query: z.string().optional(),
  fromStep: z.string().optional(),
  index: z.number().int().min(0).optional(),
  x: z.number().optional(),
  y: z.number().optional(),
}).optional();

const settleSchema = z.object({
  condition: z.enum(["dom-quiet", "exists", "not-exists", "contains"]),
  target: targetSchema,
  value: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
}).optional();

const observationSchema = z.object({
  mode: z.enum(["search", "inspect", "visual", "extract", "events", "downloads", "screenshot", "raw-snapshot", "capabilities", "artifact"]),
  target: targetSchema,
  query: z.string().optional(),
  pack: z.string().max(64).optional(),
  uri: z.string().max(300).optional(),
  detail: z.enum(["lean", "compact", "full", "debug"]).optional(),
  limit: z.number().int().positive().optional(),
  fullPage: z.boolean().optional(),
  searchStrategy: z.enum(["snowflake", "auto", "lexical", "deep"]).optional(),
}).optional();

const stepSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
  action: z.enum([
    "navigate", "reload", "back", "forward", "find", "click", "doubleClick", "hover", "focus",
    "fill", "replaceText", "fillForm", "type", "press", "select", "scroll", "drag",
    "assert", "upload", "clipboardRead", "clipboardWrite", "handleDialog", "screenshot", "close", "capability",
  ]),
  target: targetSchema,
  url: z.string().url().refine((value) => /^https?:\/\//i.test(value) || value === "about:blank", {
    message: "Navigation supports http://, https://, and about:blank only",
  }).optional(),
  value: z.string().optional(),
  capability: z.string().max(160).optional(),
  input: z.any().optional(),
  key: z.string().optional(),
  fields: z.record(z.string(), z.string()).optional(),
  files: z.array(z.string()).max(20).optional(),
  path: z.array(z.object({ x: z.number(), y: z.number() })).max(100).optional(),
  scrollX: z.number().optional(),
  scrollY: z.number().optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  waitUntil: z.enum(["none", "domcontentloaded", "load"]).optional(),
  condition: z.enum(["exists", "not-exists", "contains", "equals"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  settle: settleSchema,
  delivery: z.enum(["artifact", "inline"]).optional(),
  fullPage: z.boolean().optional(),
  retry: z.number().int().min(0).max(3).optional(),
  onError: z.enum(["stop", "continue"]).optional(),
  bypassCache: z.boolean().optional(),
});

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  uncertain: z.boolean(),
});

const resultSchema = z.object({
  ok: z.boolean(),
  status: z.string(),
  sessionId: z.string(),
  error: errorSchema.optional(),
}).passthrough();

export function createCoreRegistry(runtime) {
  return {
    browser_run: {
      description: "Run an action chain with settle and post-observation.",
      inputSchema: z.object({
        ...sessionFields,
        tab: z.object({
          mode: z.enum(["current", "new", "claim"]).optional(),
          tabId: z.number().int().positive().optional(),
        }).optional(),
        steps: z.array(stepSchema).max(20).optional(),
        approvalToken: z.string().optional(),
        postObserve: observationSchema,
        returnMode: z.enum(["last", "all", "summary"]).optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      outputSchema: resultSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
      execute: (args, context) => runtime.run(args, context),
    },
    browser_observe: {
      description: "Observe compact browser evidence.",
      inputSchema: z.object({
        ...sessionFields,
        mode: z.enum(["search", "inspect", "visual", "extract", "events", "downloads", "screenshot", "raw-snapshot", "capabilities", "artifact"]),
        tabId: z.number().int().positive().optional(),
        target: targetSchema,
        query: z.string().optional(),
        detail: z.enum(["lean", "compact", "full", "debug"]).optional(),
        limit: z.number().int().positive().optional(),
        fullPage: z.boolean().optional(),
        delivery: z.enum(["artifact", "inline"]).optional(),
        searchStrategy: z.enum(["snowflake", "auto", "lexical", "deep"]).optional(),
        pack: z.string().max(64).optional(),
        uri: z.string().max(300).optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
      execute: (args, context) => runtime.observe(args, context),
    },
    browser_session: {
      description: "Manage a named-profile browser session.",
      inputSchema: z.object({
        ...sessionFields,
        action: z.enum(["open", "new-tab", "claim-tab", "release-tab", "name"]),
        tabId: z.number().int().positive().optional(),
        name: z.string().min(1).max(120).optional(),
        scope: z.enum(["session", "user"]).optional(),
      }),
      outputSchema: resultSchema,
      annotations: { openWorldHint: true },
      execute: (args, context) => runtime.session(args, context),
    },
    browser_finalize: {
      description: "Finalize a browser session.",
      inputSchema: z.object({
        ...sessionFields,
        keep: z.array(z.union([
          z.number().int().positive(),
          z.object({ tabId: z.number().int().positive(), status: z.enum(["handoff", "deliverable"]).optional() }),
        ])).max(50).optional(),
      }),
      outputSchema: resultSchema,
      annotations: { destructiveHint: true, openWorldHint: true },
      execute: (args, context) => runtime.finalize(args, context),
    },
  };
}

export { observationSchema, resultSchema, settleSchema, stepSchema, targetSchema };
