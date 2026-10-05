export type DecisionSettings = {
  provider: "off" | "jev" | "openai-decisions"; route: "typesafe" | "openrouter";
  shareText: boolean; shareImages: boolean; keyEnv: string; ready?: boolean; credentialConfigured?: boolean;
  usage?: { calls: number; selected: number; abstained: number; tests: number; inputTokens: number; outputTokens: number;
    reportedCost: number; costReportedCalls: number; usageReportedCalls: number; averageMs: number; lastMs: number; window: string };
  efficiency?: { skipped: number; cacheHits: number; coalesced: number; budgetSkipped: number; called: number;
    lastSkipReason: string | null; cacheEntries: number; inFlight: number };
};
