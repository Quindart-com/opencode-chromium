import { z } from "zod";
import { JevProvider } from "./provider.js";
import { configureProvider, providerKey, providerModel, providerSettingsSchema, providerStatus, storeProviderKey } from "./settings.js";
import { recordDecision } from "./usage.js";

const inputSchema = z.object({ settings: providerSettingsSchema,
  apiKey: z.string().trim().min(8).max(1024).optional() });
const messages: Record<string, string> = {
  invalid_key: "API key rejected. Check the key and selected service.",
  access_denied: "This key does not have access to the decision model.",
  insufficient_credit: "Add credits or increase your API key's spending limit.",
  rate_limited: "Service rate limit reached. Try the test again later.",
  timeout: "Connection timed out. Check your network and try again.",
};
export async function saveAndTestProvider(params: unknown, fetcher: typeof fetch = fetch) {
  const parsed = inputSchema.safeParse(params);
  if (!parsed.success) return { ok: false, message: "Check your provider settings and API key.", elapsedMs: 0 };
  const { settings, apiKey } = parsed.data;
  if (settings.provider === "jev" && settings.shareImages) return { ok: false, message: "Jev supports text decisions only.", elapsedMs: 0 };
  if (settings.provider === "openai-decisions" && settings.route !== "openrouter") return { ok: false, message: "Luna requires OpenRouter.", elapsedMs: 0 };
  if (settings.provider === "off") { configureProvider(settings); return { ok: true, settings: providerStatus() }; }
  const key = apiKey ?? providerKey(settings);
  if (!key) return { ok: false, message: "Enter an API key or configure the environment variable in Advanced settings.", elapsedMs: 0 };
  const started = performance.now();
  let authMs: number | undefined;
  if (settings.route === "openrouter") {
    try {
      const response = await fetcher("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000),
      });
      authMs = performance.now() - started;
      await response.body?.cancel();
      if (!response.ok) return { ok: false, elapsedMs: authMs,
        message: messages[({ 401: "invalid_key", 403: "access_denied", 429: "rate_limited" } as Record<number, string>)[response.status] ?? ""] ?? "OpenRouter is unavailable. Try again later." };
    } catch { return { ok: false, elapsedMs: performance.now() - started, message: "Could not reach OpenRouter. Check your network and try again." }; }
  }
  // One explicitly requested synthetic probe verifies model access as well as
  // authentication. Never send browsing data during setup or retry this call.
  const model = providerModel(settings)!;
  const result = await new JevProvider(key, fetcher, model, 5000, settings.route).decide({
    purpose: "verify", context: "Connection test: select the ready option.",
    instructions: "Select ready.", candidates: [{ id: "ready", description: "Ready" }],
  });
  recordDecision(result, "test");
  const check = { elapsedMs: result.elapsedMs, authMs, model: result.model, usage: result.usage };
  if (result.status !== "selected" || result.candidateId !== "ready") return { ...check, ok: false,
    message: messages[result.reason ?? ""] ?? "The decision test failed. Settings were not changed; try again later." };
  if (apiKey) storeProviderKey(settings.route, apiKey);
  configureProvider(settings);
  return { ...check, ok: true, settings: providerStatus(), message: "Connected. API key and decision model verified." };
}
