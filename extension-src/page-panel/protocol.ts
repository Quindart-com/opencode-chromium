import { z } from "zod/mini";
import { harnessTargets,type HarnessTarget } from "../../src/shared/harnesses.ts";
import type { UsageDay } from "../../src/shared/decision-usage.ts";
import { record } from "../../src/shared/values.ts";

export const pagePanelView = z.enum(["overview", "profiles", "settings"]);
export type PagePanelView = z.infer<typeof pagePanelView>;
export const pagePanelUsage = z.strictObject({ period: z.enum(["7d", "30d", "last-week", "last-year", "all"]), provider: z.enum(["current", "all", "openrouter:jev", "typesafe:jev", "openai:openai-decisions", "openrouter:openai-decisions"]) });
export type PagePanelUsage = z.infer<typeof pagePanelUsage>;
export const pagePanelRequest = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("refresh"), usage: z.optional(pagePanelUsage) }),
  z.strictObject({ type: z.literal("open"), view: pagePanelView }),
  z.strictObject({ type: z.literal("close") }),
  z.strictObject({ type: z.literal("hidden"), id: z.string() }),
]);
export interface PagePanelSnapshot {
  connected: boolean;
  harnessesKnown: boolean;
  harnesses: Array<{ id: HarnessTarget; connected: boolean; version: string | null }>;
  assistance: boolean | null;
  usage: { input: number; output: number; calls: number; cost: number | null; days: UsageDay[] } | null;
  memory: { enabled: boolean; actions: number; recipes: number } | null;
}
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const version = (value: unknown): string | null => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]{1,32})?$/.test(value) ? value : null;

/** Explicit output projection: no raw errors, profile IDs, keys, paths, or client metadata. */
export function projectPagePanel(connected: boolean, connections: unknown, decision: unknown, memory: unknown): PagePanelSnapshot {
  const links = record(connections), settings = record(decision), stats = record(memory), counts = record(stats.counts), usage = record(settings.usage);
  const clients = Array.isArray(links.clients) ? links.clients.map(record) : [];
  const installed = Array.isArray(links.harnesses) ? links.harnesses.map(record) : [];
  return {
    connected,
    harnessesKnown: Array.isArray(links.clients) || Array.isArray(links.harnesses),
    harnesses: harnessTargets.filter(id => installed.some(row => row.harness === id && row.installed === true) || clients.some(row => row.harness === id && row.state === "responding")).map(id => ({
      id, connected: connected && clients.some(row => row.harness === id && row.state === "responding"),
      version: version(installed.find(row => row.harness === id)?.version),
    })),
    assistance: typeof settings.ready === "boolean" ? settings.ready : settings.provider === "off" ? false : null,
    usage: settings.usage && typeof settings.usage === "object" ? { input: count(usage.inputTokens), output: count(usage.outputTokens), calls: count(usage.calls), cost: count(usage.costReportedCalls) > 0 ? count(usage.reportedCost) : null, days: Array.isArray(usage.daily) ? usage.daily.slice(-366).map(record).filter(row => date(row.date)).map(row => ({ date: row.date as string, ...(date(row.endDate) ? { endDate: row.endDate } : {}), inputTokens: count(row.inputTokens), outputTokens: count(row.outputTokens), calls: count(row.calls), selected: 0, abstained: 0, tests: 0, reportedCost: 0, costReportedCalls: 0, usageReportedCalls: 0, averageMs: 0, lastMs: 0 })) : [] } : null,
    memory: typeof stats.enabled === "boolean" ? { enabled: stats.enabled, actions: count(counts.actions_v2 ?? counts.signatures), recipes: count(counts.chains_v2 ?? counts.chains) } : null,
  };
}

export function isPagePanelUrl(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !["chromewebstore.google.com", "chrome.google.com", "addons.mozilla.org"].includes(url.hostname) && !url.pathname.toLowerCase().endsWith(".pdf");
  } catch { return false; }
}
