import fs from "node:fs";
import { z } from "zod";
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/).max(200);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/), text = z.string().max(1000), dtype = z.enum(["q8", "q4", "fp16"]);
const dimensions = z.number().int().min(16).max(8192);
const semantic = z.object({ id, label: text, description: text, parameters: text, contextLength: text, dimensions, role: z.enum(["adaptive", "deep"]),
  embedding: z.object({ id: modelId, baseModel: modelId, dtype, pooling: z.enum(["cls", "last_token", "none"]), dimensions, parameters: text,
    queryPrefix: text.optional(), documentPrefix: text.optional(), task: text.optional(), adapter: z.literal("embeddinggemma").optional(),
    supportedDtypes: z.array(dtype).min(1).max(3).optional(), nativeDimensions: dimensions.optional(), supportedDimensions: z.array(dimensions).min(1).max(10).optional(), defaultDimensions: dimensions.optional(), promptVersion: text.optional() }),
  reranker: z.object({ id: modelId, baseModel: modelId, dtype, fallbackDtype: dtype.optional(), parameters: text, maxLength: z.number().int().min(64).max(32768), instruction: text }).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.dimensions !== value.embedding.dimensions || value.role === "deep" && !value.reranker || value.embedding.supportedDimensions && !value.embedding.supportedDimensions.includes(value.dimensions)) ctx.addIssue({code:"custom",message:"Incompatible embedding dimensions or missing reranker"});
});
const visual = z.object({ id, label: text, description: text, model: modelId, task: z.literal("zero-shot-object-detection"), dtype, device: z.literal("wasm"), defaultLabels: z.array(z.string().max(100)).min(1).max(80) }).strict();
const schema = z.object({ semantic: z.array(semantic).max(32).default([]), visual: z.array(visual).max(16).default([]) }).strict();
export function validateLocalModelCatalog(value: unknown) {
  const catalog = schema.parse(value);
  for (const models of [catalog.semantic, catalog.visual]) if (new Set(models.map(model=>model.id)).size !== models.length) throw new Error("Duplicate model IDs");
  return catalog;
}
export type VisualModel = z.infer<typeof visual>;
let cached: { identity: string; result: z.infer<typeof schema>; status: string } | undefined;
export function localModelCatalog() {
  const file = process.env.OPENCODE_BROWSER_MODEL_CATALOG;
  if (!file) return { semantic: [], visual: [], status: "builtin" };
  try {
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size > 262144) throw new Error("Invalid catalog size");
    const identity = file + ":" + stat.mtimeMs + ":" + stat.size;
    if (!cached || cached.identity !== identity) cached = { identity, result: validateLocalModelCatalog(JSON.parse(fs.readFileSync(file,"utf8"))), status: "custom" };
    return { ...cached.result, status: cached.status };
  } catch { return { semantic: [], visual: [], status: "invalid_custom_catalog" }; }
}
export function mergeModelCatalog<T extends {id:string}>(builtins: readonly T[], additions: readonly T[]): T[] {
  const ids = new Set(builtins.map(model=>model.id));
  // Installed built-ins retain their known adapters. Additional IDs are opt-in.
  return [...builtins, ...additions.filter(model=>!ids.has(model.id))];
}
