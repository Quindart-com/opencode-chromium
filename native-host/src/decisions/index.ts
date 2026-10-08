import { JevProvider, DEFAULT_DECISION_TIMEOUT_MS, type DecisionRequest, type DecisionResult } from "./provider.js";
import { configureProvider, getProviderSettings, providerKey, providerModel, providerStatus, storeProviderKey } from "./settings.js";
import { saveAndTestProvider } from "./connection.js";
import { decisionUsage, recordDecision } from "./usage.js";
import { decisionBudget } from "./budget.js";

let cached: { key: string; route: string; provider: JevProvider } | undefined;
export async function decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
  const settings = getProviderSettings();
  const key = providerKey(settings);
  if (!providerStatus().ready || !key) return { status: "unavailable", elapsedMs: 0, reason: "provider_not_enabled" };
  if (request.image && (!settings.shareImages || settings.provider !== "openai-decisions")) return { status: "unavailable", elapsedMs: 0, reason: "image_sharing_not_enabled" };
  const identity = `${settings.provider}:${settings.route}:${settings.shareText}:${settings.shareImages}:${providerModel(settings)}`;
  if (!cached || cached.key !== key || cached.route !== identity) cached = { key, route: identity,
    provider: new JevProvider(key, fetch, providerModel(settings)!, DEFAULT_DECISION_TIMEOUT_MS, settings.route) };
  const result = await cached.provider.decide(request, signal);
  recordDecision(result, request.purpose);
  return result;
}
export async function handleDecisionHostMethod(method: string, params: unknown) {
  if (method === "decision.status") return { ...providerStatus(), usage: decisionUsage(), efficiency: decisionBudget.stats() };
  if (method === "decision.saveAndTest") return saveAndTestProvider(params);
  if (method === "decision.removeKey") { storeProviderKey(getProviderSettings().route, null); cached = undefined; return providerStatus(); }
  if (method === "decision.configure") { cached = undefined; return configureProvider(params); }
  if (method === "decision.evaluate") return decide(params as DecisionRequest);
  return undefined;
}
