import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { versionNotice } from "../extension-src/version-status.ts";
import { MemoryStore } from "../native-host/dist/memory/index.js";
import { saveAndTestProvider } from "../native-host/dist/decisions/connection.js";
import { decisionUsage } from "../native-host/dist/decisions/usage.js";
import { SEMANTIC_MODELS } from "../native-host/dist/semantic-models.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureMessages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(root, "extension-src/public/_locales/en/messages.json"), "utf8"))).map(([key, value]) => [key, value.message]));
const storeFixture = process.argv.includes("--store-fixture");
const fixtureVersion = storeFixture ? JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version : "1.9.1";
fs.mkdirSync(path.join(root, "reports"), { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "popup-verification-"));
const stores = [new MemoryStore({ root: fixture }), new MemoryStore({ root: fixture })];
const [store, other] = stores;
store.enable();
store.profiles.register({ profileId: "primary", profileLabel: "Primary" });
store.profiles.register({ profileId: "secondary", profileLabel: "Secondary" });
store.recordStep({ action: "click", hostname: "fixture.test", profileId: "primary" });
other.recordStep({ action: "click", hostname: "fixture.test", profileId: "secondary" });
other.recordStep({ action: "press", hostname: "fixture.test", profileId: "secondary" });
// Skipped replays must be explained rather than shown as a bare placeholder.
store.usageEvent({ eventType: "replay_rejected", reason: "below_similarity", profileId: "primary" });
store.usageEvent({ eventType: "replay_rejected", reason: "below_similarity", profileId: "primary" });
store.usageEvent({ eventType: "replay_rejected", reason: "step_count_mismatch", profileId: "primary" });
const versionStatus = { state: "connected", versionChecked: true, nativeHostVersion: "1.6.5", clientVersions: ["1.6.5"] };
let decisionSettings = { provider: "jev", route: "openrouter", keyEnv: "OPENROUTER_API_KEY", shareText: true, shareImages: false, ready: true };
if (storeFixture) decisionSettings = { ...decisionSettings, provider: "off", shareText: false, ready: false };
let uploadSettings = { allowWithoutConfirmation: false };
let semanticSettings = { enabled: true, modelId: SEMANTIC_MODELS.find(model => model.role === "adaptive").id, deepModelId: SEMANTIC_MODELS.find(model => model.role === "deep").id, strategyPreference: "auto" };
let runtimeUpdates = { supported: true, enabled: true, state: "waiting", targetVersion: "1.9.3", installedVersion: "1.9.2" };
let harnessConnections = { observedAt: Date.now(), host: { version: fixtureVersion, pid: 42 }, clients: [
  { id: "fixture-codex", harness: "codex", harnessVersion: "1.2.3", runtimeVersion: "1.10.1", transport: "mcp", pid: 43, phase: "used", connectedAt: Date.now(), lastSeenAt: Date.now(), lastActionAt: Date.now(), pending: 0, state: "responding" },
  { id: "fixture-dsh", harness: "dsh", harnessVersion: "0.2.0", runtimeVersion: "1.9.4", transport: "mcp", pid: 44, phase: "initialized", connectedAt: Date.now() - 60000, lastSeenAt: Date.now() - 60000, lastActionAt: null, pending: 0, state: "stale" },
] };
const previousProviderDir = process.env.AGENT_BROWSER_PROVIDER_DIR;
process.env.AGENT_BROWSER_PROVIDER_DIR = path.join(fixture, "providers");
harnessConnections.harnesses = [{ harness: "codex", installed: true, configured: true, version: "1.2.3" }, { harness: "opencode", installed: true, configured: true, version: "2.0.0" }, { harness: "dsh", installed: true, configured: true, version: "0.2.0" }];
harnessConnections.actions = [];
const localJobs = new Map();
fs.mkdirSync(process.env.AGENT_BROWSER_PROVIDER_DIR, { recursive: true });
const usageRows = [];
for (let day = 0; day < 7; day++) for (const [route, provider, tokens] of [["openrouter", "jev", 100], ["openrouter", "openai-decisions", 900], ["openai", "openai-decisions", 50]]) {
  usageRows.push({ at: Date.now() - day * 86400000, route, provider, purpose: "select", status: "selected", elapsedMs: 120, usage: { input_tokens: tokens, output_tokens: 0 } });
}
usageRows.push({ at: Date.UTC(new Date().getUTCFullYear() - 1, 5, 1), route: "openai", provider: "openai-decisions", purpose: "select", status: "selected", elapsedMs: 200, usage: { input_tokens: 1200000, output_tokens: 333 } });
fs.writeFileSync(path.join(process.env.AGENT_BROWSER_PROVIDER_DIR, "usage.jsonl"), usageRows.map(row => JSON.stringify(row)).join("\n") + "\n");
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/fixture-bootstrap.js") { res.setHeader("Content-Type", "text/javascript"); res.end(`globalThis.chrome = { i18n: { getUILanguage: () => "en", getMessage: (key, values) => { let result = (${JSON.stringify(fixtureMessages)})[key] || key; for (const [index, value] of (Array.isArray(values) ? values : values === undefined ? [] : [values]).entries()) result = result.replaceAll("$" + (index + 1), value); return result; } }, storage: { local: { get: async () => ({localModelDeprecationDismissed:${storeFixture}}), set: async () => {} } }, runtime: { id: "fixture", getURL: value => value, getManifest: () => ({version:${JSON.stringify(fixtureVersion)}}), connect: () => ({onMessage:{addListener(){}},onDisconnect:{addListener(){}},disconnect(){}}), sendMessage: message => fetch("/rpc", {method:"POST",body:JSON.stringify(message)}).then(r=>r.json()) } };`); return; }
    if (req.url === "/rpc") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      let result;
      if (message.type === "GET_HARNESS_CONNECTIONS") result = { result: harnessConnections };
      else if (["START_HARNESS_RECONNECT", "RUN_CONNECTION_DOCTOR", "INSTALL_RUNTIME_UPDATE"].includes(message.type)) {
        const job = { id: randomUUID(), kind: message.type === "START_HARNESS_RECONNECT" ? "reconnect" : message.type === "INSTALL_RUNTIME_UPDATE" ? "update" : "diagnose", target: message.params?.target, state: "queued", code: "queued", updatedAt: Date.now() };
        localJobs.set(job.id, job); harnessConnections.actions.unshift(job);
        setTimeout(() => {
          job.state = job.kind === "update" ? "waiting" : "succeeded"; job.code = job.kind === "update" ? "update_waiting" : job.kind === "diagnose" ? "healthy" : "refreshed"; job.updatedAt = Date.now();
          if (job.kind === "reconnect") {
            const row = harnessConnections.clients.find(client => client.harness === job.target);
            if (row) { row.state = "responding"; row.lastSeenAt = Date.now(); }
          }
        }, 200);
        result = { result: job };
      }
      else if (message.type === "GET_LOCAL_ACTION") result = { result: localJobs.get(message.params.id) ?? null };
      else if (message.type === "DISCONNECT_HARNESS") { harnessConnections = { ...harnessConnections, clients: harnessConnections.clients.filter(client => client.id !== message.params.id) }; result = { result: harnessConnections }; }
      else if (message.type === "RECONNECT_NATIVE_HOST") result = { result: { reconnecting: true } };
      else if (message.type === "GET_UPLOAD_SETTINGS") result = { result: uploadSettings };
      else if (message.type === "GET_RUNTIME_UPDATES") result = { result: runtimeUpdates };
      else if (message.type === "SET_RUNTIME_UPDATES") { runtimeUpdates = { ...runtimeUpdates, enabled: message.enabled }; result = { result: runtimeUpdates }; }
      else if (message.type === "SET_UPLOAD_SETTINGS") { uploadSettings = { allowWithoutConfirmation: message.allowWithoutConfirmation === true }; result = { result: uploadSettings }; }
      else if (message.type === "MEMORY_CALL") {
        if (message.method === "memory.profiles") result = { currentProfileId: "primary", profiles: store.profiles.list().map((profile) => ({ ...profile, connected: true })) };
        else if (message.method === "memory.stats") result = store.status(message.params);
        else if (message.method === "memory.configure") result = store.configure(message.params);
        else if (message.method === "memory.enable") result = store.enable();
        else if (message.method === "memory.disable") result = store.disable();
        else throw new Error("Unexpected fixture method");
        result = { ok: true, result };
      } else if (message.type === "GET_PROFILE" || message.type === "GET_PROFILE_DETAILS") result = { profile: { profileId: "primary", profileLabel: storeFixture ? "Example browser" : "Primary" } };
      else if (message.type === "GET_DECISION_SETTINGS") result = { result: { ...decisionSettings, usage: decisionUsage({ provider: message.usage?.provider ?? decisionSettings.route + ":" + decisionSettings.provider, period: message.usage?.period ?? "7d" }) } };
      else if (message.type === "SET_DECISION_SETTINGS") {
        decisionSettings = { ...message.settings, ready: message.settings.shareText };
        result = { result: decisionSettings };
      }
      else if (message.type === "TEST_DECISION_CONNECTION") {
        const check = await saveAndTestProvider({ settings: message.settings, apiKey: message.apiKey }, async (url, init) => {
          if (new Headers(init.headers).get("Authorization")?.includes("invalid-key-fixture")) return new Response("rejected", { status: 401 });
          if (String(url).endsWith("/key")) return new Response("{}");
          if (String(url) === "https://api.openai.com/v1/decisions") return Response.json({ model: "gpt-6-luna", answers: [{ type: "choice", name: "decision", choice: "ready", confidence: 0.99, probabilities: [{ value: "ready", probability: 0.99 }, { value: "__abstain", probability: 0.01 }] }], usage: { input_tokens: 22, output_tokens: 0 } });
          return new Response(JSON.stringify({ model: JSON.parse(String(init.body)).model === "openai/gpt-6-luna-decisions" ? "openai/gpt-6-luna-decisions" : "typesafe/jev-1.13-20260917", answers: { decision: {
            type: "choice", choice: "ready", confidence: 0.99, probabilities: { ready: 0.99, __abstain: 0.01 },
          } }, usage: { input_tokens: 22, output_tokens: 0, cost: 0.000001 } }));
        });
        if (check.ok) decisionSettings = check.settings;
        result = { result: check };
      }
      else if (["GET_SEMANTIC_SETTINGS", "SET_SEMANTIC_SETTINGS"].includes(message.type)) {
        if (message.type === "SET_SEMANTIC_SETTINGS") semanticSettings = { ...semanticSettings, ...Object.fromEntries(Object.entries(message).filter(([key]) => !["type", "preload"].includes(key))) };
        result = { semantic: { settings: semanticSettings, models: SEMANTIC_MODELS.map(model => ({ ...model, cache: { cached: false } })), catalogStatus: "builtin" } };
      }
      else if (message.type === "SNOOZE_VERSION_NOTICE") {
        versionStatus.versionReminder = { key: versionNotice("1.9.1", versionStatus).key, until: Date.now() + 7 * 86400000 };
        result = { ok: true };
      } else result = { status: versionStatus };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    const file = path.resolve(root, "extension", "." + new URL(req.url, "http://localhost").pathname);
    if (!file.startsWith(path.join(root, "extension") + path.sep)) { res.writeHead(403).end(); return; }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" }[path.extname(file)];
    res.setHeader("Content-Type", type ?? "application/octet-stream");
    const data = fs.readFileSync(file);
    res.end(process.argv.includes("--serve") && path.extname(file) === ".html" ? data.toString().replace("<head>", '<head><script src="/fixture-bootstrap.js"></script>') : data);
  } catch { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "Fixture request failed" })); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
console.log("Popup fixture ready at", server.address().port);
if (process.argv.includes("--serve")) {
  versionStatus.nativeHostVersion = fixtureVersion; versionStatus.clientVersions = [fixtureVersion];
  console.log("Live review URL: http://127.0.0.1:" + server.address().port + "/popup.html");
  process.on("SIGINT", () => { server.closeAllConnections(); server.close(); for (const item of stores) item.close(); fs.rmSync(fixture, { recursive: true, force: true }); process.exit(0); });
  await new Promise(() => {});
}
let browser;
try {
  browser = await chromium.launch({ headless: true, timeout: 30000, executablePath: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE || undefined, channel: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE ? undefined : process.env.OPENCODE_TEST_BROWSER_CHANNEL || undefined });
  console.log("Popup browser ready");
  const page = await browser.newPage({ viewport: { width: 380, height: 800 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript((messages) => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { globalThis.fixtureCopiedText = text; } } });
    globalThis.chrome = { i18n: { getUILanguage: () => "en", getMessage: (key, values) => { let result = messages[key] || key; for (const [index, value] of (Array.isArray(values) ? values : values === undefined ? [] : [values]).entries()) result = result.replaceAll("$" + (index + 1), value); return result; } }, storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {
      id: "fixture",
        getURL: value => value,
      getManifest: () => ({ version: globalThis.fixtureCurrentVersion ?? "1.9.1", ...(globalThis.fixtureCurrentVersion ? { version_name: globalThis.fixtureCurrentVersion + " dev preview" } : {}) }),
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
      sendMessage: (message) => fetch("/rpc", { method: "POST", body: JSON.stringify(message) }).then((response) => response.json()),
    } };
  }, fixtureMessages);
  await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  console.log("Popup loaded");
  const connections = page.getByRole("region", { name: "Harness connections", exact: true });
  await connections.getByText("Codex", { exact: true }).waitFor();
  await connections.getByText("DeepSeek Harness", { exact: true }).waitFor();
  await connections.getByText("OpenCode", { exact: true }).waitFor();
  assert.equal(await connections.locator(".agent-row").count(), 3, "only installed or responding harnesses are shown");
  assert.equal(await connections.getByRole("button", { name: "Refresh connections", exact: true }).count(), 0, "automatic polling needs no duplicate refresh button");
  assert.equal(await page.locator("#status-pill").isVisible(), false, "the healthy bridge is reported once in the connection card");
  await connections.locator(".badge-online").waitFor();
  assert.equal(await connections.locator(".badge-online").count(), 1);
  assert.equal(await connections.locator(".badge-offline").count(), 2);
  const badge = connections.locator(".badge-online");
  assert.notEqual(await badge.evaluate(element => getComputedStyle(element).color), await connections.locator(".agent-identity strong").first().evaluate(element => getComputedStyle(element).color), "connected status has a distinct visible color");
  await page.screenshot({ path: path.join(root, "reports", "popup-harness-connections.png"), fullPage: true });
  assert.equal(await connections.locator(".agent-icon img").count(), 3, "each harness has an icon");
  await page.waitForFunction(() => [...document.querySelectorAll('.agent-icon img')].every(image => image.complete && image.naturalWidth > 0));
  await connections.screenshot({ path: path.join(root, "reports", "popup-connections-card.png"), animations: "disabled" });
  const dshRow = connections.locator("li", { hasText: "DeepSeek Harness" });
  await dshRow.getByRole("button", { name: "Connect DeepSeek Harness", exact: true }).click();
  await dshRow.getByText("Connected", { exact: true }).waitFor();
  await connections.getByText("Codex", { exact: true }).waitFor();
  assert.equal(harnessConnections.clients.length, 2, "reconnect preserves existing links");
  assert.equal(harnessConnections.clients.find(client => client.harness === "codex").state, "responding");
  await connections.locator(".connection-troubleshooting > summary").click();
  await connections.getByRole("button", { name: "Run checks", exact: true }).click();
  await connections.getByText("Connection checks passed", { exact: true }).waitFor();
  assert.equal(await connections.getByText("Copy doctor command", { exact: true }).count(), 0);
  harnessConnections.harnesses.push({ harness: "claude-code", installed: true, configured: true, version: "2.1.0" }, { harness: "claude-desktop", installed: false, configured: true, version: null });
  await connections.getByText("Claude Code", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await connections.getByText("Claude Desktop", { exact: true }).count(), 0, "stale desktop configuration is not an installation");
  const claudeCode = connections.locator("li", { hasText: "Claude Code" });
  assert.equal(await claudeCode.locator("img").getAttribute("src"), "/images/harness/claude-code.svg");
  await claudeCode.getByRole("button", { name: "Connect Claude Code" }).click();
  await page.waitForTimeout(400);
  harnessConnections.harnesses.find(row => row.harness === "claude-code").installed = false;
  harnessConnections.harnesses.find(row => row.harness === "claude-desktop").installed = true;
  harnessConnections.clients.push({ id: "fixture-claude", harness: "claude", harnessVersion: null, runtimeVersion: "1.10.1", transport: "mcp", pid: 46, phase: "initialized", connectedAt: Date.now(), lastSeenAt: Date.now(), lastActionAt: null, pending: 0, state: "responding" });
  await connections.getByText("Claude Desktop", { exact: true }).waitFor({ timeout: 10000 });
  const claudeDesktop = connections.locator("li", { hasText: "Claude Desktop" });
  await claudeDesktop.getByText("Claude client not identified").waitFor();
  assert.equal(await claudeDesktop.getByRole("button", { name: "Connect Claude Desktop" }).isDisabled(), true);
  assert.equal(await connections.getByText("Claude Code", { exact: true }).count(), 0);
  harnessConnections.harnesses = harnessConnections.harnesses.filter(row => !row.harness.startsWith("claude-"));
  harnessConnections.clients = harnessConnections.clients.filter(row => row.id !== "fixture-claude");
  const supportedConnections = harnessConnections;
  harnessConnections = { observedAt: Date.now(), host: { version: fixtureVersion, pid: 42 } };
  await page.reload();
  await connections.getByText("Update the CLI to show agent status.", { exact: true }).waitFor();
  assert.equal(await connections.locator(".agent-row").count(), 0, "an older host must not fabricate harness rows");
  assert.equal(await page.getByRole("button", { name: "Update CLI", exact: true }).count(), 1, "the upgrade action appears once");
  harnessConnections = supportedConnections;
  await page.reload();
  await connections.getByText("Codex", { exact: true }).waitFor();
  const dashboard = page.locator(".decision-overview");
  await page.waitForFunction(() => document.querySelector(".usage-metrics dd")?.textContent === "700");
  await dashboard.getByRole("combobox", { name: "Service", exact: true }).selectOption("openai:openai-decisions");
  await page.waitForFunction(() => document.querySelector(".usage-metrics dd")?.textContent === "350");
  await dashboard.getByRole("combobox", { name: "Period", exact: true }).selectOption("last-year");
  await page.waitForFunction(() => document.querySelector(".usage-metrics dd")?.textContent === (1200000).toLocaleString());
  assert.equal(await dashboard.locator(".usage-metrics dd").first().evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; }), 1, "usage numbers must not stack vertically");
  await dashboard.getByRole("combobox", { name: "Period", exact: true }).selectOption("7d");
  await dashboard.getByRole("combobox", { name: "Service", exact: true }).selectOption("all");
  await page.waitForFunction(() => document.querySelector(".usage-metrics dd")?.textContent === (7350).toLocaleString());
  assert.equal(await dashboard.locator(".usage-comparison tbody tr").count(), 3);
  await dashboard.getByRole("img", { name: "Token usage", exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, "reports", "popup-usage-providers.png"), fullPage: true });
  await dashboard.screenshot({ path: path.join(root, "reports", "popup-usage-card.png"), animations: "disabled" });
  await dashboard.getByRole("combobox", { name: "Service", exact: true }).selectOption("current");
  await page.waitForFunction(() => document.querySelector("#memory-executions")?.textContent === "1", null, { timeout: 15000 });
  assert.equal(await page.locator("#memory-replays").textContent(), "0");
  assert.equal(await page.locator("#memory-success").textContent(), "—");
  assert.equal(
    await page.locator("#memory-replay-note").textContent(),
    "Skipped remembered recipes: 3. Most often: no close enough match (2).",
  );
  await page.screenshot({ path: path.join(root, "reports", "popup-replay-note.png"), fullPage: true });
  await page.getByRole("heading", { name: "Update your local browser tools" }).waitFor();
  assert.equal(await page.locator(".update-command").count(), 0);
  await page.screenshot({ path: path.join(root, "reports", "popup-version-notice.png"), fullPage: true });
  await page.locator(".version-notice").getByRole("button", { name: "Update CLI", exact: true }).click();
  await page.locator(".version-notice").getByText("Update ready; activates when browser work is idle", { exact: true }).waitFor();
  assert.equal([...localJobs.values()].filter(job => job.kind === "update").length, 1);
  await page.getByRole("button", { name: "Remind me in a week" }).click();
  await page.waitForFunction(() => !document.querySelector(".version-notice"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Bridge connected");
  assert.equal(await page.locator(".version-notice").count(), 0, "snooze persists across popup reopen");
  await page.getByText("Activity and memory statistics", { exact: true }).click();
  await page.selectOption("#statistics-scope", "all");
  await page.waitForFunction(() => document.querySelector("#memory-executions")?.textContent === "3");
  assert.equal(await page.locator("#memory-actions").textContent(), "2");
  await page.selectOption("#statistics-scope", "selected");
  await page.getByLabel("Secondary", { exact: true }).check();
  await page.waitForFunction(() => document.querySelector("#memory-executions")?.textContent === "2");
  await page.locator("#memory-reindex").click();
  await page.waitForFunction(() => document.querySelector("#memory-feedback")?.textContent === "Fixture request failed");
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  await page.screenshot({ path: path.join(root, "reports", "popup-overview.png"), fullPage: true });
  await page.getByRole("tab", { name: "Profiles", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#connected-profile")?.options.length === 2);
  await page.selectOption("#connected-profile", "secondary");
  assert.equal(await page.locator("#connected-profile").inputValue(), "secondary");
  await page.getByRole("tab", { name: "Settings", exact: true }).click();
  const memoryToggle = page.getByRole("switch", { name: "Action memory", exact: true });
  await page.waitForSelector("#memory-enabled:not(:disabled)");
  assert.equal(await memoryToggle.getAttribute("aria-checked"), "true");
  await memoryToggle.click();
  await page.waitForFunction(() => document.querySelector("#memory-enabled")?.getAttribute("aria-checked") === "false");
  await memoryToggle.click();
  await page.waitForFunction(() => document.querySelector("#memory-enabled")?.getAttribute("aria-checked") === "true");
  const automaticUpdates = page.getByLabel("Keep local browser tools up to date", { exact: false });
  await page.waitForFunction(() => {
    const input = document.querySelector('[aria-labelledby="runtime-updates-title"] input');
    return input && !input.disabled;
  });
  await automaticUpdates.uncheck();
  await page.getByText("Update preference saved.", { exact: true }).waitFor();
  assert.equal(runtimeUpdates.enabled, false);
  const enabledSaved = page.waitForResponse(response => response.url().endsWith("/rpc") && response.request().postDataJSON()?.type === "SET_RUNTIME_UPDATES");
  await automaticUpdates.check();
  await enabledSaved;
  await page.getByText("Update preference saved.", { exact: true }).waitFor();
  assert.equal(runtimeUpdates.enabled, true);
  const uploadPreference = page.getByRole("checkbox", { name: "Allow uploads without confirmation", exact: true });
  await uploadPreference.waitFor();
  await page.waitForFunction(() => !document.querySelector('.upload-preference input')?.disabled);
  assert.equal(await uploadPreference.isChecked(), false);
  await uploadPreference.check();
  await page.waitForFunction(() => document.querySelector('.upload-preference input')?.checked && !document.querySelector('.upload-preference input')?.disabled);
  assert.equal(uploadSettings.allowWithoutConfirmation, true);
  await uploadPreference.uncheck();
  await page.waitForFunction(() => !document.querySelector('.upload-preference input')?.checked && !document.querySelector('.upload-preference input')?.disabled);
  assert.equal(uploadSettings.allowWithoutConfirmation, false);
  await page.locator(".memory-settings-details > summary").filter({ hasText: "Cleanup" }).click();
  await page.waitForSelector("#purge-days:not(:disabled)");
  assert.equal(await page.locator(".version-notice").isVisible(), true, "instructions stay available in Settings");
  assert.equal(await page.getByRole("button", { name: "Update CLI", exact: true }).count(), 0, "Settings uses its Updates section instead of a duplicate update action");
  await page.locator("#purge-days").fill("21");
  await page.waitForTimeout(2800);
  assert.equal(await page.locator("#purge-days").inputValue(), "21", "polling must preserve an unsaved edit");
  assert.equal(await page.locator("#semantic-model-list").isVisible(), false);
  await page.locator("#decision-provider:not(:disabled)").waitFor();
  assert.equal(await page.locator("#decision-provider").inputValue(), "jev-openrouter");
  const jevImages = page.getByRole("checkbox", { name: /Allow experimental image fallback/ });
  assert.equal(await jevImages.isChecked(), false);
  await jevImages.check();
  assert.equal(await page.locator("#decision-key-env").isVisible(), false, "connection details start collapsed");
  assert.equal(await page.getByText("Embedded models are deprecated", { exact: false }).isVisible(), false, "migration details start collapsed");
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator(".provider-settings").screenshot({ path: path.join(root, "reports", "popup-provider-light.png"), animations: "disabled" });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.locator(".provider-settings").screenshot({ path: path.join(root, "reports", "popup-provider-dark.png"), animations: "disabled" });
  await page.screenshot({ path: path.join(root, "reports", "popup-settings-dark.png"), fullPage: true });
  await page.locator("#decision-api-key").fill("invalid-key-fixture");
  await page.getByRole("button", { name: "Save & test connection", exact: true }).click();
  await page.getByText("API key rejected. Check the key and selected service.", { exact: false }).waitFor();
  assert.equal(await page.locator(".provider-feedback-error").count(), 1);
  await page.locator("#decision-api-key").fill(`fixture-${randomUUID()}`);
  await page.getByRole("button", { name: "Save & test connection", exact: true }).click();
  await page.getByText("Connected. API key and decision model verified.", { exact: false }).waitFor();
  assert.equal(await page.locator(".provider-feedback-ok").count(), 1);
  assert.equal(await page.locator("#decision-api-key").inputValue(), "", "clear the key after saving");
  assert.match(await page.locator(".provider-timing").textContent(), /Key check \d+ ms · Decision \d+ ms/);
  assert.equal(decisionSettings.shareText, true, "enabling Jev authorizes the documented bounded context");
  assert.equal(decisionSettings.shareImages, true, "Jev image sharing persists only after explicit opt-in and save");
  await page.locator(".provider-settings").screenshot({ path: path.join(root, "reports", "popup-provider-success.png"), animations: "disabled" });
  await page.selectOption("#decision-provider", "openai-decisions");
  const images = page.getByLabel("Allow screenshots for ambiguous visual targets", { exact: false });
  await images.waitFor(); assert.equal(await images.isChecked(), false);
  await images.check();
  await page.getByRole("button", { name: "Save & test connection", exact: true }).click();
  await page.getByText("Connected. API key and decision model verified.", { exact: false }).waitFor();
  assert.equal(decisionSettings.shareImages, true);
  await page.selectOption("#decision-provider", "openai-direct");
  assert.equal(await images.isChecked(), false);
  await page.locator("#decision-api-key").fill(`fixture-openai-${randomUUID()}`);
  await page.getByRole("button", { name: "Save & test connection", exact: true }).click();
  await page.getByText("Connected. API key and decision model verified.", { exact: false }).waitFor();
  assert.equal(decisionSettings.route, "openai");
  assert.equal(decisionSettings.keyEnv, "OPENAI_API_KEY");
  assert.equal(await page.locator(".provider-consent").textContent().then(text => text.includes("OpenAI Platform")), true);
  await page.selectOption("#decision-provider", "jev-typesafe");
  assert.equal(await jevImages.isChecked(), false, "switching service resets screenshot consent");
  await page.getByText("Advanced settings", { exact: true }).click();
  assert.equal(await page.locator("#decision-key-env").inputValue(), "TYPESAFE_API_KEY");
  await page.selectOption("#decision-provider", "off");
  assert.equal(await page.locator("#decision-api-key").count(), 0);
  await page.selectOption("#decision-provider", "jev-openrouter");
  assert.equal(await page.locator("#decision-api-key").getAttribute("placeholder"), fixtureMessages.replaceKey, "switching service recognizes its saved key");
  assert.equal(await page.locator(".provider-feedback").textContent().then(text => text.includes(fixtureMessages.decisionEnabled)), false, "unsaved service changes are not presented as active");
  await page.getByText("Advanced settings", { exact: true }).click();
  assert.equal(await page.locator("#decision-key-env").inputValue(), "OPENROUTER_API_KEY");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "popup must fit the viewport");
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "popup must fit narrow windows");
  await page.screenshot({ path: path.join(root, "reports", "popup-settings-narrow.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Decision assistance", exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, "reports", "popup-overview-dark.png"), fullPage: true, animations: "disabled" });
  versionStatus.nativeHostVersion = "1.10.0";
  versionStatus.clientVersions = ["1.10.0"];
  await page.reload();
  await page.getByRole("heading", { name: "Your extension is behind your local tools" }).waitFor();
  assert.equal(await page.locator(".update-command").count(), 0, "do not recommend downgrading newer local tools");
  versionStatus.nativeHostVersion = "1.9.1";
  versionStatus.clientVersions = ["1.9.1"];
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Bridge connected");
  assert.equal(await page.locator(".version-notice").count(), 0, "matching versions clear the notice");
  const reviewDirectory = path.join(root, "reports", "popup-review");
  fs.mkdirSync(reviewDirectory, { recursive: true });
  const currentVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  versionStatus.nativeHostVersion = currentVersion; versionStatus.clientVersions = [currentVersion];
  harnessConnections.host.version = currentVersion;
  runtimeUpdates = { ...runtimeUpdates, installedVersion: currentVersion, targetVersion: currentVersion, state: "idle" };
  await page.addInitScript(version => { globalThis.fixtureCurrentVersion = version; }, currentVersion);
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Bridge connected");
  for (const width of [320, 420]) {
    await page.setViewportSize({ width, height: 600 });
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme });
      const measuredWidths = [];
      for (const view of ["Overview", "Profiles", "Settings"]) {
        await page.getByRole("tab", { name: view, exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.view-panel:not([hidden]) button[disabled]#decision-provider'));
        measuredWidths.push(await page.locator('main').evaluate(element => element.getBoundingClientRect().width));
        let detailCount = -1, stableDetails = 0;
        for (let attempt = 0; attempt < 20 && stableDetails < 3; attempt++) {
          const details = await page.locator('.view-panel:not([hidden])').evaluate(panel => {
            const rows = [...panel.querySelectorAll('details')];
            for (const row of rows) row.open = true;
            return { count: rows.length,closed: rows.filter(row => !row.open).length };
          });
          stableDetails = details.count === detailCount && details.closed === 0 ? stableDetails + 1 : 0;
          detailCount = details.count;
          if (stableDetails < 3) await page.waitForTimeout(50);
        }
        assert.equal(stableDetails, 3, "full-page review includes every asynchronously loaded expandable feature");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${view} fits ${width}px ${theme}`);
        await page.screenshot({ path: path.join(reviewDirectory, `${view.toLowerCase()}-${width}-${theme}.png`), fullPage: true, animations: "disabled" });
      }
      assert.ok(Math.max(...measuredWidths) - Math.min(...measuredWidths) < 1, `all views share a stable width at ${width}px ${theme}`);
    }
  }
  decisionSettings = { ...decisionSettings, provider: "openai-decisions", route: "openai", shareText: true, ready: false };
  await page.reload();
  await page.locator(".decision-provider-line").getByText("OpenAI Platform · Luna", { exact: true }).waitFor();
  await page.getByText("Connection needed.", { exact: false }).waitFor();
  versionStatus.state = "disconnected";
  versionStatus.error = "Native bridge unavailable.";
  await page.setViewportSize({ width: 320, height: 600 });
  await page.reload();
  await page.getByRole("heading", { name: "Connect your browser", exact: true }).waitFor();
  await page.getByRole("button", { name: "Copy setup command", exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.fixtureCopiedText), "npx -y opencode-chromium@latest setup --all");
  await page.screenshot({ path: path.join(reviewDirectory, "disconnected-320-dark.png"), fullPage: true, animations: "disabled" });
  await page.getByText("Connection details", { exact: true }).click();
  await page.getByText("Native bridge unavailable.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Popup verified: scoped SQLite totals, shared-action deduplication, profile dropdown, preserved edits, collapsed model settings, no page errors.");
} catch (error) { console.error("Popup verification failed:", error); throw error; } finally {
  server.closeAllConnections();
  if (previousProviderDir === undefined) delete process.env.AGENT_BROWSER_PROVIDER_DIR;
  else process.env.AGENT_BROWSER_PROVIDER_DIR = previousProviderDir;
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  for (const item of stores) item.close();
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith("popup-verification-"));
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
