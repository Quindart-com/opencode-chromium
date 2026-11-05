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
let updateStartCode = null, bridgeReconnects = 0;
let profileLabel = "Primary";
const failedSummaryTypes = new Set();
let additionalProfiles = [];
const updateParams = [];
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
      if (failedSummaryTypes.has(message.type)) throw new Error("Synthetic unavailable summary");
      let result;
      if (message.type === "GET_HARNESS_CONNECTIONS") result = { result: harnessConnections };
      else if (["START_HARNESS_RECONNECT", "RUN_CONNECTION_DOCTOR", "INSTALL_RUNTIME_UPDATE"].includes(message.type)) {
        const job = { id: randomUUID(), kind: message.type === "START_HARNESS_RECONNECT" ? "reconnect" : message.type === "INSTALL_RUNTIME_UPDATE" ? "update" : "diagnose", target: message.params?.target, state: "queued", code: "queued", updatedAt: Date.now() };
        if (job.kind === "update") {
          updateParams.push(message.params);
          if (updateStartCode && !(updateStartCode === "major_approval_required" && message.params?.approvedMajor === true)) { job.state = "blocked"; job.code = updateStartCode; }
        }
        localJobs.set(job.id, job); harnessConnections.actions.unshift(job);
        setTimeout(() => {
          if (job.state === "blocked") return;
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
      else if (message.type === "RECONNECT_NATIVE_HOST") { bridgeReconnects++; result = { result: { reconnecting: true } }; }
      else if (message.type === "GET_UPLOAD_SETTINGS") result = { result: uploadSettings };
      else if (message.type === "GET_RUNTIME_UPDATES") result = { result: runtimeUpdates };
      else if (message.type === "SET_RUNTIME_UPDATES") { runtimeUpdates = { ...runtimeUpdates, enabled: message.enabled }; result = { result: runtimeUpdates }; }
      else if (message.type === "SET_UPLOAD_SETTINGS") { uploadSettings = { allowWithoutConfirmation: message.allowWithoutConfirmation === true }; result = { result: uploadSettings }; }
      else if (message.type === "MEMORY_CALL") {
        if (message.method === "memory.profiles") result = { currentProfileId: "primary", profiles: [...store.profiles.list().map((profile) => ({ ...profile, connected: true })), ...additionalProfiles] };
        else if (message.method === "memory.stats") result = store.status(message.params);
        else if (message.method === "memory.configure") result = store.configure(message.params);
        else if (message.method === "memory.enable") result = store.enable();
        else if (message.method === "memory.disable") result = store.disable();
        else throw new Error("Unexpected fixture method");
        result = { ok: true, result };
      } else if (message.type === "GET_PROFILE" || message.type === "GET_PROFILE_DETAILS") result = { profile: { profileId: "primary", profileLabel: storeFixture ? "Example browser" : profileLabel } };
      else if (message.type === "SET_PROFILE_LABEL") { profileLabel = message.label; result = { profile: { profileId: "primary", profileLabel } }; }
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
  const page = await browser.newPage({ viewport: { width: 380, height: 580 } });
  page.setDefaultTimeout(15000);
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith("/rpc")) requests.push(request.postDataJSON()); });
  const currentVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  versionStatus.nativeHostVersion = currentVersion; versionStatus.clientVersions = [currentVersion];
  await page.addInitScript(({ messages, version }) => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { globalThis.fixtureCopiedText = text; } } });
    globalThis.chrome = { i18n: { getUILanguage: () => globalThis.fixtureLocale ?? "en", getMessage: (key, values) => {
      let result = (globalThis.fixtureMessages ?? messages)[key];
      if (!result) throw new Error("Missing translation: " + key);
      for (const [index, value] of (Array.isArray(values) ? values : values === undefined ? [] : [values]).entries()) result = result.replaceAll("$" + (index + 1), value);
      return result;
    } }, storage: { local: { get: async () => ({ localModelDeprecationDismissed: true }), set: async () => {} } }, runtime: {
      id: "fixture", getURL: value => value, getManifest: () => ({ version }),
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
      sendMessage: message => fetch("/rpc", { method: "POST", body: JSON.stringify(message) }).then(response => response.json()),
    } };
  }, { messages: fixtureMessages, version: currentVersion });
  const screenshotDir = path.join(root, process.argv.includes("--screenshots") ? "docs/images/extension" : "reports/popup-review");
  fs.mkdirSync(screenshotDir, { recursive: true });
  async function capture(name) {
    await page.locator(".popup-scroll").evaluate(element => { element.scrollTop = 0; });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator("main").evaluate(element => Math.round(element.getBoundingClientRect().top)), 0, "the native popup stays anchored while forms scroll");
    if (await page.locator(".subpage-header").count()) assert.equal(await page.locator(".subpage-header").evaluate(element => Math.round(element.getBoundingClientRect().top)), 16);
    await page.screenshot({ path: path.join(screenshotDir, name + ".png"), animations: "disabled" });
  }
  const home = async () => { while (await page.locator(".back-button").count()) await page.locator(".back-button").click(); };
  const settings = async () => { await home(); await page.getByRole("button", { name: "Settings", exact: true }).click(); };
  const section = async title => { await settings(); await page.locator(".settings-list").getByRole("button", { name: title, exact: false }).click(); };
  await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  const connections = page.getByRole("region", { name: "Harness connections", exact: true });
  await connections.getByText("Codex", { exact: true }).waitFor();
  assert.equal(await page.getByRole("tablist").count(), 0, "compact navigation has no tab bar");
  assert.equal(await connections.locator(".agent-row").count(), 3, "only installed or responding harnesses are shown");
  const gearAlignment = await page.locator("#open-settings").evaluate(button => { const outer = button.getBoundingClientRect(), icon = button.querySelector("img").getBoundingClientRect(); return Math.abs((outer.left + outer.right - icon.left - icon.right) / 2); });
  assert.ok(gearAlignment < 1, "settings icon is centered in its button");
  assert.equal(await connections.locator(".badge-online").count(), 1);
  assert.equal(await connections.getByRole("button", { name: "Reconnect Codex", exact: true }).count(), 0, "healthy connections use plain status text");
  assert.equal(await page.locator(".popup-scroll").evaluate(el => el.scrollHeight <= el.clientHeight), true, "the normal home fits without a scrollbar");
  const alignment = await connections.locator(".agent-row").evaluateAll(rows => rows.map(row => ({ name: row.querySelector("strong").getBoundingClientRect().x, right: row.lastElementChild.getBoundingClientRect().right })));
  assert.equal(new Set(alignment.map(row => row.name)).size, 1);
  assert.equal(new Set(alignment.map(row => row.right)).size, 1);
  await capture("home");

  await page.locator(".profile-trigger").click();
  await page.getByRole("radio", { name: /Secondary/ }).click();
  await page.getByRole("button", { name: "Copy selector", exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.fixtureCopiedText), JSON.stringify({ profile: "secondary" }));
  await capture("profiles");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".profile-trigger").evaluate(el => el === document.activeElement), true);
  await page.locator(".profile-trigger").click();
  await page.getByRole("button", { name: "Rename this profile", exact: true }).click();
  assert.equal(await page.getByRole("heading", { name: "Browser profile" }).evaluate(el => el === document.activeElement), true);
  assert.equal(requests.filter(request => request.type === "GET_PROFILE_DETAILS").length, 0, "identifiers stay hidden before an explicit reveal or copy");
  await page.getByLabel("Profile label", { exact: true }).fill("Testing");
  await page.getByRole("button", { name: "Save label", exact: true }).click();
  await page.getByText(fixtureMessages.profileSaved, { exact: true }).waitFor();
  await capture("profile");
  await home();
  await page.locator(".profile-trigger").getByText("Testing", { exact: false }).waitFor();
  profileLabel = "Primary";

  const dsh = connections.locator("li", { hasText: "DeepSeek Harness" });
  await dsh.getByRole("button", { name: "Connect DeepSeek Harness" }).click();
  await dsh.getByText("Connected", { exact: true }).waitFor();
  assert.equal(harnessConnections.clients.find(client => client.harness === "codex").state, "responding", "reconnect preserves other sessions");
  await section("Connection help");
  await page.getByRole("button", { name: fixtureMessages.runConnectionChecks, exact: true }).click();
  await page.getByText(fixtureMessages.actionHealthy, { exact: true }).waitFor();
  await page.getByRole("button", { name: fixtureMessages.reconnectBridge, exact: true }).click();
  assert.equal(bridgeReconnects, 1);
  const inventory = harnessConnections;
  harnessConnections = { observedAt: Date.now(), host: inventory.host, clients: inventory.clients, controllerSupported: true };
  await home(); await page.reload(); await section("Connection help");
  assert.equal(await page.locator(".connection-upgrade").count(), 0, "current controllers need no legacy inventory upgrade");
  harnessConnections = inventory;

  await home(); await page.getByRole("button", { name: "View", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".usage-metrics dd")?.textContent === (7350).toLocaleString());
  await page.waitForFunction(() => document.querySelector("#memory-actions")?.textContent === "1");
  assert.equal(await page.locator("#memory-replays").textContent(), "0");
  assert.equal(await page.locator("#memory-success").textContent(), "—");
  await capture("activity");
  await page.getByRole("combobox", { name: "Service", exact: true }).selectOption("openai:openai-decisions");
  await page.waitForFunction(() => document.querySelector(".usage-metrics dd")?.textContent === "350");
  await page.getByRole("combobox", { name: "Period", exact: true }).selectOption("last-year");
  await page.waitForFunction(() => document.querySelector(".usage-metrics dd")?.textContent === (1200000).toLocaleString());
  await page.getByText("More statistics", { exact: true }).click();
  await page.selectOption("#statistics-scope", "all");
  await page.waitForFunction(() => document.querySelector("#memory-executions")?.textContent === "3");
  assert.equal(await page.locator("#memory-actions").textContent(), "2");
  await page.selectOption("#statistics-scope", "selected");
  await page.getByLabel("Secondary", { exact: true }).check();
  await page.waitForFunction(() => document.querySelector("#memory-executions")?.textContent === "2");
  await page.locator("#memory-reindex").click();
  await page.getByText("Fixture request failed", { exact: false }).waitFor();

  await settings();
  await page.waitForSelector("#memory-enabled:not(:disabled)");
  await capture("settings");
  const memoryToggle = page.getByRole("switch", { name: "Action memory", exact: true });
  await memoryToggle.click();
  await page.waitForFunction(() => document.querySelector("#memory-enabled")?.getAttribute("aria-checked") === "false");
  await memoryToggle.click();
  await page.waitForFunction(() => document.querySelector("#memory-enabled")?.getAttribute("aria-checked") === "true");
  const uploads = page.getByRole("switch", { name: "Allow uploads without confirmation", exact: true });
  assert.equal(await uploads.getAttribute("aria-checked"), "false");
  await uploads.click();
  await page.waitForFunction(() => document.querySelector(".compact-upload button")?.getAttribute("aria-checked") === "true");
  assert.equal(uploadSettings.allowWithoutConfirmation, true);
  await uploads.click();
  await page.waitForFunction(() => document.querySelector(".compact-upload button")?.getAttribute("aria-checked") === "false");

  await section("Storage & cleanup");
  await page.locator("#purge-days").fill("21");
  await page.waitForTimeout(2800);
  assert.equal(await page.locator("#purge-days").inputValue(), "21", "polling preserves unsaved edits");
  await page.locator("#purge-days").blur();
  await page.getByText(fixtureMessages.purgeAfter.replace("$1", "21"), { exact: true }).waitFor();
  await settings();
  await page.getByRole("button", { name: /Storage & cleanup.*21/ }).waitFor();

  await section("Local search and models");
  await page.locator("#search-model:not(:disabled)").waitFor();
  await capture("models");
  await page.getByRole("switch", { name: fixtureMessages.enableSemantic, exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#semantic-enabled")?.getAttribute("aria-checked") === "false");
  await page.getByText(fixtureMessages.advancedSearch, { exact: true }).click();
  assert.equal(await page.locator("#search-mode").isDisabled(), true);
  await page.getByRole("switch", { name: fixtureMessages.enableSemantic, exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#semantic-enabled")?.getAttribute("aria-checked") === "true" && !document.querySelector("#semantic-enabled")?.disabled);
  const countSaved = page.waitForResponse(response => response.url().endsWith("/rpc") && response.request().postDataJSON()?.agentResultCount === 8);
  await page.locator("#result-count").selectOption("8");
  await countSaved;
  assert.equal(semanticSettings.agentResultCount, 8);

  await section("Decision assistance");
  await page.locator("#decision-provider:not(:disabled)").waitFor();
  assert.equal(await page.locator("#decision-key-env").isVisible(), false);
  const images = page.getByRole("checkbox", { name: "Allow screenshots", exact: false });
  assert.equal(await images.isChecked(), false);
  await images.check();
  await page.locator("#decision-api-key").fill("invalid-key-fixture");
  await page.getByRole("button", { name: fixtureMessages.saveTest, exact: true }).click();
  await page.locator(".provider-feedback-error").waitFor();
  assert.match(await page.locator(".provider-feedback-error").textContent(), /API key rejected/);
  await capture("provider-error");
  await page.locator("#decision-api-key").fill(`fixture-${randomUUID()}`);
  await page.getByRole("button", { name: fixtureMessages.saveTest, exact: true }).click();
  await page.locator(".provider-feedback-ok").waitFor();
  assert.equal(await page.locator("#decision-api-key").inputValue(), "", "saved keys clear from the input");
  assert.equal(decisionSettings.shareImages, true);
  await page.selectOption("#decision-provider", "openai-direct");
  assert.equal(await images.isChecked(), false, "switching services resets screenshot consent");
  await page.locator("#decision-api-key").fill(`fixture-${randomUUID()}`);
  await page.getByRole("button", { name: fixtureMessages.saveTest, exact: true }).click();
  await page.locator(".provider-feedback-ok").waitFor();
  assert.equal(decisionSettings.route, "openai");
  assert.equal(decisionSettings.keyEnv, "OPENAI_API_KEY");
  await capture("provider");
  await page.selectOption("#decision-provider", "off");
  await page.getByRole("button", { name: fixtureMessages.saveSettings, exact: true }).click();
  await page.getByText(fixtureMessages.decisionOff, { exact: false }).waitFor();

  await section("Updates");
  const automatic = page.getByLabel(fixtureMessages.keepUpdated, { exact: false });
  await page.waitForSelector('[aria-labelledby="runtime-updates-title"] input:not(:disabled)');
  await automatic.uncheck();
  await page.getByText(fixtureMessages.updatePrefSaved, { exact: true }).waitFor();
  assert.equal(runtimeUpdates.enabled, false);
  await automatic.check();
  await page.getByText(fixtureMessages.updatePrefSaved, { exact: true }).waitFor();
  assert.equal(runtimeUpdates.enabled, true);
  await page.getByRole("button", { name: fixtureMessages.checkInstallUpdates, exact: true }).click();
  await page.getByText(fixtureMessages.actionUpdateWaiting, { exact: true }).waitFor();
  updateStartCode = "major_approval_required";
  await page.getByRole("button", { name: fixtureMessages.checkInstallUpdates, exact: true }).click();
  await page.getByText(fixtureMessages.runtimeApprovalRequired, { exact: true }).waitFor();
  const beforeApproval = updateParams.length;
  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: fixtureMessages.checkInstallUpdates, exact: true }).click();
  assert.equal(updateParams.length, beforeApproval);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: fixtureMessages.checkInstallUpdates, exact: true }).click();
  await page.getByText(fixtureMessages.actionUpdateWaiting, { exact: true }).waitFor();
  assert.equal(updateParams.at(-1).approvedMajor, true);
  updateStartCode = null;
  runtimeUpdates = { ...runtimeUpdates, supported: false, controllerSupported: false, state: "bridge_required" };
  await section("Updates");
  await page.locator(".runtime-setup").waitFor();
  assert.equal(await page.getByRole("button", { name: fixtureMessages.checkInstallUpdates, exact: true }).count(), 0);
  await page.getByRole("button", { name: fixtureMessages.copySetup, exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.fixtureCopiedText), "npx -y opencode-chromium@latest setup --all");

  // A failed bridge must show recovery, not plausible-looking empty statistics.
  versionStatus.state = "disconnected";
  await home(); await page.reload();
  await page.getByText("Local bridge not connected", { exact: true }).waitFor();
  await capture("disconnected");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  assert.equal(bridgeReconnects, 2);

  // Long labels and every shipped locale must fit the native popup widths.
  versionStatus.state = "connected";
  failedSummaryTypes.add("GET_DECISION_SETTINGS");
  failedSummaryTypes.add("GET_SEMANTIC_SETTINGS");
  failedSummaryTypes.add("GET_RUNTIME_UPDATES");
  await page.reload();
  await page.getByText(fixtureMessages.assistanceStatusUnavailable, { exact: true }).waitFor();
  await capture("summary-unavailable");
  failedSummaryTypes.clear();
  await page.locator(".home-decision").getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Local search on · Cloud off", { exact: true }).waitFor();
  failedSummaryTypes.add("GET_DECISION_SETTINGS");
  failedSummaryTypes.add("GET_SEMANTIC_SETTINGS");
  failedSummaryTypes.add("GET_RUNTIME_UPDATES");
  await settings();
  await page.getByText(fixtureMessages.settingsStatusUnavailable, { exact: true }).waitFor();
  await capture("settings-unavailable");
  failedSummaryTypes.clear();
  await page.locator(".settings-list").getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("Automatic updates on", { exact: true }).waitFor();
  additionalProfiles = Array.from({ length: 12 }, (_, index) => ({ profileId: `example-${index}`, profileLabel: `Example profile ${index + 1} with a long descriptive label`, connected: true }));
  await home(); await page.reload();
  await page.getByText("Codex", { exact: true }).waitFor();
  await page.locator(".profile-trigger").click();
  await page.getByRole("radio", { name: /Example profile 12 / }).click();
  await page.getByRole("button", { name: "Copy selector", exact: true }).click();
  assert.equal(await page.evaluate(() => globalThis.fixtureCopiedText), JSON.stringify({ profile: "example-11" }));
  assert.equal(await page.locator(".profile-popover").evaluate(element => element.getBoundingClientRect().height <= 360 && element.scrollHeight > element.clientHeight), true);
  await capture("profiles-many");
  await page.getByRole("button", { name: "Rename this profile", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Browser profile", exact: true }).waitFor();
  additionalProfiles = [];
  profileLabel = "A deliberately long browser profile label for a compact popup layout check";
  for (const locale of ["en", "fr", "es", "pt_BR", "ru", "zh_CN"]) {
    const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(root, "extension-src/public/_locales", locale, "messages.json"), "utf8"))).map(([key, value]) => [key, value.message]));
    await page.addInitScript(({ messages, locale }) => { globalThis.fixtureMessages = messages; globalThis.fixtureLocale = locale; }, { messages, locale });
    for (const width of [320, 380]) {
      await page.setViewportSize({ width, height: 580 }); await page.reload();
      await page.getByText("Codex", { exact: true }).waitFor();
      await page.locator(".profile-trigger").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${locale} fits ${width}px`);
      await page.keyboard.press("Escape");
      await page.locator("#open-settings").click();
      assert.equal(await page.locator(".settings-list").evaluate(el => el.scrollWidth <= el.clientWidth), true, `${locale} settings fit ${width}px`);
      for (const row of await page.locator(".settings-list > button").all()) {
        await row.click();
        assert.equal(await page.locator(".popup-scroll").evaluate(el => el.scrollWidth <= el.clientWidth), true, `${locale} detail fits ${width}px`);
        await page.locator(".section-collapse").click();
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log("Popup verified: compact navigation, aligned rows, profiles, scoped SQLite totals, provider consent and key errors, upload safety, local models, storage edits, runtime recovery and major approval, six locales at 320/380px; no page errors.");
} catch (error) { console.error("Popup verification failed:", error); throw error; } finally {
  server.closeAllConnections();
  if (previousProviderDir === undefined) delete process.env.AGENT_BROWSER_PROVIDER_DIR;
  else process.env.AGENT_BROWSER_PROVIDER_DIR = previousProviderDir;
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  for (const item of stores) item.close();
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith("popup-verification-"));
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
