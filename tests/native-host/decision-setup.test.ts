import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAndTestProvider } from "../../native-host/src/decisions/connection.ts";
import { configureProvider, credentialPath, providerKey, providerStatus, storeProviderKey } from "../../native-host/src/decisions/settings.ts";
import { decisionUsage, recordDecision } from "../../native-host/src/decisions/usage.ts";
import { selectRecipe } from "../../native-host/src/decisions/recipes.ts";

const settings = { provider: "jev" as const, route: "openrouter" as const, shareText: true, shareImages: false, keyEnv: "SYNTHETIC_DECISION_KEY" };
let root: string;
const original = process.env.AGENT_BROWSER_PROVIDER_DIR;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "decision-setup-")); process.env.AGENT_BROWSER_PROVIDER_DIR = root; });
afterEach(() => { process.env.AGENT_BROWSER_PROVIDER_DIR = original; if (original === undefined) delete process.env.AGENT_BROWSER_PROVIDER_DIR; fs.rmSync(root, { recursive: true, force: true }); });
const secret = "synthetic-secret-for-tests";
const answer = (id = "ready") => new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917",
  answers: { decision: { type: "choice", choice: id, confidence: 0.99, probabilities: { [id]: 0.99, __abstain: 0.01 } } },
  usage: { input_tokens: 22, output_tokens: 0, cost: 0.000001 } }));

test("pasted key verifies auth and decision, saves privately, never echoes key", async () => {
  const calls: string[] = [];
  const fetcher = (async (url, init) => {
    calls.push(String(url)); expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${secret}`);
    return calls.length === 1 ? new Response("{}") : answer();
  }) as typeof fetch;
  const result = await saveAndTestProvider({ settings, apiKey: ` ${secret} ` }, fetcher);
  expect(result.ok).toBe(true); expect(result.settings?.ready).toBe(true);
  expect(calls).toEqual(["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/alpha/decisions"]);
  expect(providerKey(settings)).toBe(secret);
  expect(JSON.stringify(result) + JSON.stringify(providerStatus()) + fs.readFileSync(path.join(root, "usage.jsonl"), "utf8")).not.toContain(secret);
  if (process.platform === "win32") expect(fs.readFileSync(credentialPath(), "utf8")).not.toContain(secret);
  else expect(fs.statSync(credentialPath()).mode & 0o777).toBe(0o600);
  expect(decisionUsage().tests).toBe(1);
}, 15000);

test("rejected key makes no billable call and preserves previous key and settings", async () => {
  configureProvider({ provider: "off" });
  storeProviderKey("openrouter", secret);
  let calls = 0;
  const result = await saveAndTestProvider({ settings, apiKey: "invalid-but-allowed-input" }, (async () => { calls++; return new Response(secret, { status: 401 }); }) as typeof fetch);
  expect(result.ok).toBe(false); expect(result.message).toContain("API key rejected"); expect(calls).toBe(1);
  expect(providerStatus().provider).toBe("off"); expect(providerKey(settings)).toBe(secret);
  expect(JSON.stringify(result)).not.toContain(secret);
}, 15000);

test("credits or model failure never retries or commits new settings", async () => {
  let calls = 0;
  const result = await saveAndTestProvider({ settings, apiKey: secret }, (async () => {
    calls++; return calls === 1 ? new Response("{}") : new Response("private provider message", { status: 402 });
  }) as typeof fetch);
  expect(result.ok).toBe(false); expect(result.message).toContain("credits"); expect(calls).toBe(2);
  expect(providerStatus().provider).toBe("off"); expect(fs.existsSync(credentialPath())).toBe(false);
});

test("usage keeps known costs separate from missing costs and includes abstentions", () => {
  recordDecision({ status: "selected", elapsedMs: 100, usage: { input_tokens: 10, output_tokens: 0, cost: 0.00002 } }, "rank");
  recordDecision({ status: "abstained", elapsedMs: 300 }, "select");
  expect(decisionUsage()).toMatchObject({ calls: 2, selected: 1, abstained: 1, inputTokens: 10, costReportedCalls: 1, usageReportedCalls: 1, averageMs: 200 });
});

test("recipe decisions resolve finite IDs and reject stale or uncertain recipes", async () => {
  configureProvider(settings); process.env.SYNTHETIC_DECISION_KEY = secret;
  try {
    const recipe = { id: 7, signature: "Open settings", steps: [{ action: "click" }], failed_count: 0 };
    const valid = async () => ({ status: "selected" as const, candidateId: "7", confidence: 0.99, elapsedMs: 1 });
    expect((await selectRecipe("Open settings", () => [recipe], valid))?.match?.id).toBe(7);
    expect((await selectRecipe("Open settings", () => [recipe], async () => ({ ...await valid(), candidateId: "999" })))?.match).toBe(null);
    expect((await selectRecipe("Open settings", () => [recipe], async () => ({ ...await valid(), confidence: 0.9 })))?.match).toBe(null);
    let reads = 0;
    expect((await selectRecipe("Open settings", () => ++reads === 1 ? [recipe] : [], valid))?.match).toBe(null);
  } finally { delete process.env.SYNTHETIC_DECISION_KEY; }
});
