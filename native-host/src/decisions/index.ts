import { decisionBudget } from "./budget.js";
import { saveAndTestProvider } from "./connection.js";
import { reserveImageRequest } from "./image-budget.js";
import { DEFAULT_DECISION_TIMEOUT_MS,JevProvider,type DecisionRequest,type DecisionResult } from "./provider.js";
import { configureProvider,getProviderSettings,providerKey,providerModel,providerStatus,storeProviderKey } from "./settings.js";
import { decisionUsage,recordDecision } from "./usage.js";

let cached: { key: string; route: string; provider: JevProvider } | undefined;
export async function decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
  const settings = getProviderSettings();
  const key = providerKey(settings);
  if (!providerStatus().ready || !key) return { status: "unavailable", elapsedMs: 0, reason: "provider_not_enabled" };
  if (request.image && !settings.shareImages) return { status: "unavailable", elapsedMs: 0, reason: "image_sharing_not_enabled" };
  if (signal?.aborted) return { status: "abstained", elapsedMs: 0, reason: "cancelled" };
  if (request.image && !reserveImageRequest()) return { status: "unavailable", elapsedMs: 0, reason: "image_budget_exhausted" };
  const model = providerModel(settings, !!request.image)!;
  const identity = `${settings.provider}:${settings.route}:${settings.shareText}:${settings.shareImages}:${model}`;
  if (!cached || cached.key !== key || cached.route !== identity) cached = { key, route: identity,
    provider: new JevProvider(key, fetch, model, DEFAULT_DECISION_TIMEOUT_MS, settings.route, () => {
      const current = getProviderSettings();
      return current.provider === settings.provider && current.route === settings.route && current.keyEnv === settings.keyEnv &&
        current.shareText && current.shareImages === settings.shareImages && providerKey(current) === key;
    }) };
  const result = await cached.provider.decide(request, signal);
  recordDecision(result, request.purpose, !!request.image);
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
