import { JevProvider, UnavailableProvider, type DecisionRequest, type DecisionResult } from "./provider.js";
import { configureProvider, getProviderSettings, providerStatus } from "./settings.js";

let cached: { key: string; route: string; provider: JevProvider } | undefined;
export async function decide(request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResult> {
  const settings = getProviderSettings();
  if (settings.provider === "openai-decisions") return new UnavailableProvider().decide();
  const key = process.env[settings.keyEnv];
  if (settings.provider !== "jev" || !settings.shareText || !key) return { status: "unavailable", elapsedMs: 0, reason: "provider_not_enabled" };
  if (!cached || cached.key !== key || cached.route !== settings.route) cached = { key, route: settings.route,
    provider: new JevProvider(key, fetch, settings.route === "openrouter" ? "typesafe/jev-1.13-20260917" : "jev-1.13.0", 5000, settings.route) };
  return cached.provider.decide(request, signal);
}
export async function handleDecisionHostMethod(method: string, params: unknown) {
  if (method === "decision.status") return providerStatus();
  if (method === "decision.configure") return configureProvider(params);
  if (method === "decision.evaluate") return decide(params as DecisionRequest);
  return undefined;
}
