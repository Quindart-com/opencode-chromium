import type { UsageReport } from "../../../src/shared/decision-usage.ts";
export type DecisionSettings = {
  provider: "off" | "jev" | "openai-decisions"; route: "typesafe" | "openrouter" | "openai";
  shareText: boolean; shareImages: boolean; keyEnv: string; ready?: boolean; credentialConfigured?: boolean;
  usage?: UsageReport;
  efficiency?: { skipped: number; cacheHits: number; coalesced: number; budgetSkipped: number; called: number;
    lastSkipReason: string | null; cacheEntries: number; inFlight: number };
};
