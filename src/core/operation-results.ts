import { z } from "zod";
import { record } from "../shared/values.ts";
const tabSchema = z.looseObject({ id: z.number().int().positive().optional(), tabId: z.number().int().positive().optional(), url: z.string().nullable().optional(), title: z.string().nullable().optional() })
  .refine(tab => tab.id !== undefined || tab.tabId !== undefined, "Missing tab identity").transform(tab => ({ ...tab, id: tab.id ?? tab.tabId! }));
export const candidateSchema = z.looseObject({ frameId: z.string().optional(), node_id: z.union([z.string(), z.number()]).nullable().optional(), nodeId: z.union([z.string(), z.number()]).nullable().optional(), id: z.union([z.string(), z.number()]).nullable().optional(), selector: z.string().nullable().optional(),
  role: z.string().nullable().optional(), name: z.string().nullable().optional(), text: z.string().nullable().optional(), kind: z.string().nullable().optional(), tagName: z.string().nullable().optional(),
  x: z.number().optional(), y: z.number().optional(), score: z.number().nullable().optional(), interactive: z.boolean().optional() });
export const screenshotResultSchema = z.looseObject({ base64: z.string(), mimeType: z.string() });
export const operationResultSchemas = {
  browser_get_tab: tabSchema, browser_new_tab: tabSchema, browser_claim_tab: tabSchema,
  browser_selected_tab: z.preprocess(value => value == null || (!record(value).id && !record(value).tabId) ? null : value, tabSchema.nullable()),
  browser_list_tabs: z.looseObject({ tabs: z.array(tabSchema) }),
  browser_dom_snapshot: z.looseObject({ url: z.string().optional(), nodes: z.array(candidateSchema).optional(), viewport: z.object({ width: z.number(), height: z.number() }).optional() }),
  browser_page_search: z.looseObject({ results: z.array(candidateSchema) }),
  browser_locator_count: z.looseObject({ count: z.number() }), browser_locator_text: z.looseObject({ text: z.string() }),
  browser_screenshot: screenshotResultSchema,
  browser_trace_record: z.looseObject({ trace: z.string().optional(), traceEventCount: z.number().optional() }),
};
type KnownOperation = keyof typeof operationResultSchemas;
export type OperationResult<K extends string> = K extends KnownOperation ? z.output<typeof operationResultSchemas[K]> : unknown;
export function parseOperationResult<K extends string>(name: K, value: unknown): OperationResult<K> {
  const schema = operationResultSchemas[name as KnownOperation];
  return (schema ? schema.parse(value) : value) as OperationResult<K>;
}
