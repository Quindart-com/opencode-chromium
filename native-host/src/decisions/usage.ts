import fs from "node:fs";
import path from "node:path";
import type { DecisionResult } from "./provider.js";
import { providerSettingsPath,type ProviderSettings } from "./settings.js";
import { usageReport } from "./usage-ledger.js";
import type { UsageQuery } from "../../../src/shared/decision-usage.ts";

const file = () => path.join(path.dirname(providerSettingsPath()), "usage.jsonl");
export const usageProviderId = (settings: Pick<ProviderSettings, "provider" | "route">) => settings.route + ":" + settings.provider;
export function recordDecision(result: DecisionResult, purpose: string, image = false, settings?: Pick<ProviderSettings, "provider" | "route">): void {
  // Capture the service at dispatch, including failed/setup calls before a switch.
  // No key, query, page text, recipe or candidate ID is retained.
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file(), JSON.stringify({ at: Date.now(), purpose, status: result.status, elapsedMs: result.elapsedMs, image,
      provider: settings?.provider, route: settings?.route, model: result.model, usage: result.usage }) + "\n", { mode: 0o600 });
  } catch { /* Accounting failure must never retry a billed request. */ }
}
export function decisionUsage(query: UsageQuery = {}, now = Date.now()) { return usageReport(file(), query, now); }
