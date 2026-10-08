import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { versionNotice } from "../extension-src/version-status.ts";
import { MemoryStore } from "../native-host/dist/memory/store.js";
import { saveAndTestProvider } from "../native-host/dist/decisions/connection.js";
import { decisionUsage } from "../native-host/dist/decisions/usage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
let uploadSettings = { allowWithoutConfirmation: false };
const previousProviderDir = process.env.AGENT_BROWSER_PROVIDER_DIR;
process.env.AGENT_BROWSER_PROVIDER_DIR = path.join(fixture, "providers");
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/rpc") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      let result;
      if (message.type === "GET_UPLOAD_SETTINGS") result = { result: uploadSettings };
      else if (message.type === "SET_UPLOAD_SETTINGS") { uploadSettings = { allowWithoutConfirmation: message.allowWithoutConfirmation === true }; result = { result: uploadSettings }; }
      else if (message.type === "MEMORY_CALL") {
        if (message.method === "memory.profiles") result = { currentProfileId: "primary", profiles: store.profiles.list().map((profile) => ({ ...profile, connected: true })) };
        else if (message.method === "memory.stats") result = store.status(message.params);
        else if (message.method === "memory.configure") result = store.configure(message.params);
        else throw new Error("Unexpected fixture method");
        result = { ok: true, result };
      } else if (message.type === "GET_PROFILE" || message.type === "GET_PROFILE_DETAILS") result = { profile: { profileId: "primary", profileLabel: "Primary" } };
      else if (message.type === "GET_DECISION_SETTINGS") result = { result: { ...decisionSettings, usage: decisionUsage() } };
      else if (message.type === "SET_DECISION_SETTINGS") {
        decisionSettings = { ...message.settings, ready: message.settings.shareText };
        result = { result: decisionSettings };
      }
      else if (message.type === "TEST_DECISION_CONNECTION") {
        const check = await saveAndTestProvider({ settings: message.settings, apiKey: message.apiKey }, async (url, init) => {
          if (new Headers(init.headers).get("Authorization")?.includes("invalid-key-fixture")) return new Response("rejected", { status: 401 });
          if (String(url).endsWith("/key")) return new Response("{}");
          return new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: { decision: {
            type: "choice", choice: "ready", confidence: 0.99, probabilities: { ready: 0.99, __abstain: 0.01 },
          } }, usage: { input_tokens: 22, output_tokens: 0, cost: 0.000001 } }));
        });
        if (check.ok) decisionSettings = check.settings;
        result = { result: check };
      }
      else if (message.type === "GET_SEMANTIC_SETTINGS") result = { semantic: { settings: { enabled: true, strategyPreference: "auto" }, models: [] } };
      else if (message.type === "SNOOZE_VERSION_NOTICE") {
        versionStatus.versionReminder = { key: versionNotice("1.7.1", versionStatus).key, until: Date.now() + 7 * 86400000 };
        result = { ok: true };
      } else result = { status: versionStatus };
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    const file = path.resolve(root, "extension", "." + new URL(req.url, "http://localhost").pathname);
    if (!file.startsWith(path.join(root, "extension") + path.sep)) { res.writeHead(403).end(); return; }
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(file)];
    res.setHeader("Content-Type", type ?? "application/octet-stream");
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "Fixture request failed" })); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 800 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { globalThis.fixtureCopiedText = text; } } });
    globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: {
      id: "fixture",
      getManifest: () => ({ version: "1.7.1" }),
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
      sendMessage: (message) => fetch("/rpc", { method: "POST", body: JSON.stringify(message) }).then((response) => response.json()),
    } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  await page.waitForFunction(() => document.querySelector("#memory-executions")?.textContent === "1", null, { timeout: 15000 });
  assert.equal(await page.locator("#memory-replays").textContent(), "0");
  assert.equal(await page.locator("#memory-success").textContent(), "—");
  assert.equal(
    await page.locator("#memory-replay-note").textContent(),
    "Skipped 3 remembered recipes. Most often: no close enough match (2).",
  );
  await page.screenshot({ path: path.join(root, "reports", "popup-replay-note.png"), fullPage: true });
  await page.getByRole("heading", { name: "Update your local browser tools" }).waitFor();
  assert.match(await page.locator(".update-command").textContent(), /opencode-chromium@1.7.1/);
  await page.screenshot({ path: path.join(root, "reports", "popup-version-notice.png"), fullPage: true });
  await page.getByText("How to update", { exact: true }).click();
  await page.getByRole("button", { name: "Copy update command" }).click();
  assert.equal(await page.evaluate(() => globalThis.fixtureCopiedText), "npm install -g opencode-chromium@1.7.1");
  await page.getByRole("button", { name: "Remind me in a week" }).click();
  await page.waitForFunction(() => !document.querySelector(".version-notice"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "connected");
  assert.equal(await page.locator(".version-notice").count(), 0, "snooze persists across popup reopen");
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
  await page.waitForSelector("#purge-days:not(:disabled)");
  assert.equal(await page.locator(".version-notice").isVisible(), true, "instructions stay available in Settings");
  await page.locator("#purge-days").fill("21");
  await page.waitForTimeout(2800);
  assert.equal(await page.locator("#purge-days").inputValue(), "21", "polling must preserve an unsaved edit");
  assert.equal(await page.locator("#semantic-model-list").isVisible(), false);
  await page.locator("#decision-provider:not(:disabled)").waitFor();
  assert.equal(await page.locator("#decision-provider").inputValue(), "jev-openrouter");
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
  await page.locator(".provider-settings").screenshot({ path: path.join(root, "reports", "popup-provider-success.png"), animations: "disabled" });
  await page.selectOption("#decision-provider", "jev-typesafe");
  await page.getByText("Advanced · Environment variable", { exact: true }).click();
  assert.equal(await page.locator("#decision-key-env").inputValue(), "TYPESAFE_API_KEY");
  await page.selectOption("#decision-provider", "off");
  assert.equal(await page.locator("#decision-api-key").count(), 0);
  await page.selectOption("#decision-provider", "jev-openrouter");
  await page.getByText("Advanced · Environment variable", { exact: true }).click();
  assert.equal(await page.locator("#decision-key-env").inputValue(), "OPENROUTER_API_KEY");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "popup must fit the viewport");
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "popup must fit narrow windows");
  await page.screenshot({ path: path.join(root, "reports", "popup-settings-narrow.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Jev usage", exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, "reports", "popup-overview-dark.png"), fullPage: true, animations: "disabled" });
  versionStatus.nativeHostVersion = "1.8.0";
  versionStatus.clientVersions = ["1.8.0"];
  await page.reload();
  await page.getByRole("heading", { name: "Your extension is behind your local tools" }).waitFor();
  assert.equal(await page.locator(".update-command").count(), 0, "do not recommend downgrading newer local tools");
  versionStatus.nativeHostVersion = "1.7.1";
  versionStatus.clientVersions = ["1.7.1"];
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "connected");
  assert.equal(await page.locator(".version-notice").count(), 0, "matching versions clear the notice");
  assert.deepEqual(errors, []);
  console.log("Popup verified: scoped SQLite totals, shared-action deduplication, profile dropdown, preserved edits, collapsed model settings, no page errors.");
} finally {
  if (previousProviderDir === undefined) delete process.env.AGENT_BROWSER_PROVIDER_DIR;
  else process.env.AGENT_BROWSER_PROVIDER_DIR = previousProviderDir;
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  for (const item of stores) item.close();
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith("popup-verification-"));
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
