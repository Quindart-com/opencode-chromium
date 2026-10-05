import { JevProvider, UnavailableProvider, DEFAULT_DECISION_TIMEOUT_MS, type DecisionRequest, type DecisionResult } from "./provider.js";
import { configureProvider, getProviderSettings, providerKey, providerStatus, storeProviderKey } from "./settings.js";
import { saveAndTestProvider } from "./connection.js";
import { decisionUsage, recordDecision } from "./usage.js";
import { decisionBudget } from "./budget.js";

let cached: { key: string; route: string; provider: JevProvider } | undefined;
export async function decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
  const settings = getProviderSettings();
  if (settings.provider === "openai-decisions") return new UnavailableProvider().decide();
  const key = providerKey(settings);
  if (settings.provider !== "jev" || !settings.shareText || !key) return { status: "unavailable", elapsedMs: 0, reason: "provider_not_enabled" };
  if (!cached || cached.key !== key || cached.route !== settings.route) cached = { key, route: settings.route,
    provider: new JevProvider(key, fetch, settings.route === "openrouter" ? "typesafe/jev-1.13-20260917" : "jev-1.13.0", DEFAULT_DECISION_TIMEOUT_MS, settings.route) };
  const result = await cached.provider.decide(request, signal);
  recordDecision(result, request.purpose);
  return result;
}
export async function handleDecisionHostMethod(method: string, params: unknown) {
  if (method === "decision.status") return { ...providerStatus(), usage: decisionUsage(), efficiency: decisionBudget.stats() };
  if (method === "decision.saveAndTest") return saveAndTestProvider(params);
  if (method === "decision.removeKey") { storeProviderKey(getProviderSettings().route, null); cached = undefined; return providerStatus(); }
  if (method === "decision.configure") return configureProvider(params);
  if (method === "decision.evaluate") return decide(params as DecisionRequest);
  return undefined;
}
