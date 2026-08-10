import { z } from "zod";

export const NETWORK_RESOURCE_TYPES = Object.freeze([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "texttrack",
  "xhr",
  "fetch",
  "eventsource",
  "websocket",
  "manifest",
  "other",
]);

// This shape is shared by the lazy capability registry and the hidden browser
// operation so every adapter validates the same request before it reaches CDP.
export const NETWORK_INSPECT_ARGS = Object.freeze({
  tabId: z.number().int().positive(),
  limit: z.number().int().positive().max(200).default(50),
  urlIncludes: z.string().max(500).optional(),
  methods: z.array(z.string().min(1).max(20)).max(12).optional(),
  resourceTypes: z.array(z.enum(NETWORK_RESOURCE_TYPES)).max(NETWORK_RESOURCE_TYPES.length).optional(),
  statusMin: z.number().int().min(100).max(999).optional(),
  statusMax: z.number().int().min(100).max(999).optional(),
  includeHeaders: z.boolean().default(false),
  includeBody: z.enum(["none", "request", "response", "both"]).default("none"),
  bodyMaxChars: z.number().int().positive().max(12000).default(4000),
  includeTiming: z.boolean().default(true),
});

export const NETWORK_INSPECT_SCHEMA = z.object(NETWORK_INSPECT_ARGS).passthrough();

// Discovery metadata is returned only when the agent explicitly asks for the
// network capability pack; it is not part of any default tool schema.
export const NETWORK_INSPECT_MANIFEST = Object.freeze({
  parameters: [
    { name: "tabId", type: "integer", required: true, description: "The controlled tab to inspect." },
    { name: "limit", type: "integer", default: 50, maximum: 200, description: "Maximum completed or pending request records." },
    { name: "urlIncludes", type: "string", description: "Case-insensitive URL substring filter." },
    { name: "methods", type: "string[]", maximumItems: 12, description: "HTTP methods to keep, for example [\"GET\", \"POST\"]." },
    { name: "resourceTypes", type: "string[]", description: "Playwright-style resource types to keep." },
    { name: "statusMin", type: "integer", description: "Inclusive lower HTTP status filter." },
    { name: "statusMax", type: "integer", description: "Inclusive upper HTTP status filter." },
    { name: "includeHeaders", type: "boolean", default: false, description: "Include bounded, redacted request and response headers." },
    { name: "includeBody", type: "enum", values: ["none", "request", "response", "both"], default: "none", description: "Opt into bounded, redacted body previews; may require approval." },
    { name: "bodyMaxChars", type: "integer", default: 4000, maximum: 12000, description: "Maximum characters per body preview." },
    { name: "includeTiming", type: "boolean", default: true, description: "Include CDP timing and transfer-size fields." },
  ],
  notes: [
    "The default response contains lifecycle, URL, method, status, type, failure, and size data only.",
    "Cookies, authorization values, tokens, and secret-shaped fields are redacted before returning data.",
    "The network event buffer is tab-scoped and bounded; body capture is never enabled implicitly.",
  ],
});
