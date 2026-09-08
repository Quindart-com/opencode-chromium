import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { versionNotice } from "../extension-src/version-status.ts";
import { MemoryStore } from "../native-host/dist/memory/store.js";

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
const versionStatus = { state: "connected", versionChecked: true, nativeHostVersion: "1.6.5", clientVersions: ["1.6.5"] };
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/rpc") {
      let text = "";
      for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      let result;
      if (message.type === "MEMORY_CALL") {
        if (message.method === "memory.profiles") result = { currentProfileId: "primary", profiles: store.profiles.list().map((profile) => ({ ...profile, connected: true })) };
        else if (message.method === "memory.stats") result = store.status(message.params);
        else if (message.method === "memory.configure") result = store.configure(message.params);
        else throw new Error("Unexpected fixture method");
        result = { ok: true, result };
      } else if (message.type === "GET_PROFILE" || message.type === "GET_PROFILE_DETAILS") result = { profile: { profileId: "primary", profileLabel: "Primary" } };
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
  const page = await browser.newPage({ viewport: { width: 420, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { globalThis.fixtureCopiedText = text; } } });
    globalThis.chrome = { runtime: {
      id: "fixture",
      getManifest: () => ({ version: "1.7.1" }),
      connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
      sendMessage: (message) => fetch("/rpc", { method: "POST", body: JSON.stringify(message) }).then((response) => response.json()),
    } };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/popup.html`);
  await page.waitForFunction(() => document.querySelector("#memory-executions")?.textContent === "1");
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
  await page.waitForSelector("#purge-days:not(:disabled)");
  assert.equal(await page.locator(".version-notice").isVisible(), true, "instructions stay available in Settings");
  await page.locator("#purge-days").fill("21");
  await page.waitForTimeout(2800);
  assert.equal(await page.locator("#purge-days").inputValue(), "21", "polling must preserve an unsaved edit");
  assert.equal(await page.locator("#semantic-model-list").isVisible(), false);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: path.join(root, "reports", "popup-settings-dark.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "popup must fit the viewport");
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
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  for (const item of stores) item.close();
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith("popup-verification-"));
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
