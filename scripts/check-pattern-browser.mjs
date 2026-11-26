// Run with Node 24's type stripping. The controlled page is fulfilled entirely by the fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromiumExtensionFixture } from "./fixtures/chromium-extension.js";
import { MemoryStore } from "../src/memory/index.ts";
import { createBrowserAgent } from "../src/adapters/sdk/index.ts";
process.env.OPENCODE_BROWSER_MEMORY_EMBED = "0";
const fixture = await chromiumExtensionFixture({ executablePath: process.argv[2] });
let memory, agent;
try {
  const runtime = path.join(fixture.fixture, "runtime");
  // Only a grant-local identifier. The test disables sharing before the idle worker sends.
  fs.writeFileSync(path.join(runtime, "site-registry-origin"), "https://offline-pattern-fixture.convex.site");
  process.env.OPENCODE_BROWSER_RUNTIME_DIR = runtime;
  process.env.OPENCODE_BROWSER_MEMORY_DIR = path.join(fixture.fixture, "memory");
  // An existing user who already turned on Action Memory before task patterns existed.
  memory = new MemoryStore({});
  memory.enable();
  const base = "chrome-extension://" + fixture.extensionId;
  const state = () => memory.db.prepare("SELECT count(*) AS n FROM pattern_tasks_v1").get().n;
  const grants = () => memory.db.prepare("SELECT count(*) AS n FROM pattern_consent_v1 WHERE profile=?").get(fixture.profileId).n;
  assert.equal(grants(), 0);
  const { context } = fixture;
  // Chromium disables a reloaded unpacked extension unless Developer mode is on.
  const extensions = await context.newPage();
  await extensions.goto("chrome://extensions");
  await extensions.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await extensions.close();
  async function extensionPage(version) {
    const until = Date.now() + 30000;
    let page, current, lastError;
    while (current !== version && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 150));
      try {
        if (!page || page.isClosed()) page = await context.newPage();
        await page.goto(base + "/welcome.html", { waitUntil: "domcontentloaded", timeout: 3000 });
        current = await page.evaluate(() => chrome.runtime.getManifest().version);
      } catch (error) { lastError = error.message; }
    }
    assert.equal(current, version, "Chromium loaded version " + version + ": " + (lastError ?? ""));
    return page;
  }
  async function upgrade() {
    const file = path.join(fixture.fixture, "extension", "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const parts = manifest.version.split(".").map(Number);
    parts[parts.length - 1]++;
    manifest.version = parts.join(".");
    fs.writeFileSync(file, JSON.stringify(manifest));
    const trigger = await context.newPage();
    await trigger.goto(base + "/welcome.html");
    // Keep the hosted release-notes tab out of the page check below.
    await trigger.evaluate(() => chrome.storage.local.set({ showReleaseNotes: false }));
    const before = new Set(context.pages());
    await trigger.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 20); });
    const probe = await extensionPage(manifest.version);
    await newTab();
    const opened = context.pages().filter(page => !before.has(page) && page !== probe).map(page => page.url())
      .filter(value => value !== "about:blank");
    assert.deepEqual(opened, [], "The update opens no page");
    assert.equal(grants(), 0, "An update never turns on task patterns");
    await probe.close();
  }
  await context.route("https://www.npmjs.com/**", route =>
    route.fulfill({ contentType: "text/html", body: "<title>Public fixture</title><main><button>License</button><p>MIT</p><p>Version 1.0.0</p></main>" }));
  const url = "https://www.npmjs.com/package/react";
  agent = createBrowserAgent();
  const sessionId = "pattern-test", profile = fixture.profileId;
  const call = async (tool, args) => {
    const result = await agent.call(tool, { sessionId, profile, ...args });
    assert.equal(result.ok, true, JSON.stringify(result)); return result;
  };
  // A started or reloaded extension reconnects its native host before the profile is usable.
  async function newTab() {
    const until = Date.now() + 30000;
    let result;
    do {
      result = await agent.call("browser_session", { sessionId, profile, action: "new-tab" });
      if (result.ok) return result;
      await new Promise(resolve => setTimeout(resolve, 500));
    } while (Date.now() < until);
    assert.fail(JSON.stringify(result));
  }
  await newTab();
  await call("browser_run", { steps: [{ action: "navigate", url }] });
  const find = () => call("browser_run", { steps: [{ action: "find", target: { query: "license" } }] });
  const observe = query => call("browser_observe", { mode: "read", query });
  await find(); await observe("version"); assert.equal(state(), 0);
  await upgrade();
  await call("browser_run", { steps: [{ action: "navigate", url }] });
  await find(); await observe("version");
  assert.equal(state(), 0, "Existing Action Memory users start with task patterns off");

  const panel = await context.newPage();
  await panel.goto(base + "/popup.html");
  await panel.locator("#open-settings").click();
  const checked = name => panel.locator(`[aria-label="${name}"]`).getAttribute("aria-checked");
  const waitChecked = (selector, value) => panel.waitForFunction(([selector, value]) =>
    document.querySelector(selector)?.getAttribute("aria-checked") === value, [selector, value]);
  const contribute = '[aria-label="Contribute task patterns"]', memorySwitch = "#memory-enabled";
  const note = () => panel.locator(".memory-toggle-row small").innerText();
  await waitChecked(contribute, "false");
  await waitChecked(memorySwitch, "true");
  assert.equal(await panel.getByRole("switch", { name: "Shared site reads" }).isDisabled(), true, "Shared reads need task patterns");
  assert.doesNotMatch(await note(), /Also shares/, "No sharing note while Action Memory is already on and sharing is off");

  // Turning Action Memory on beside the note is the agreement.
  await panel.locator(memorySwitch).click();
  await waitChecked(memorySwitch, "false");
  await panel.waitForFunction(() => /Also shares/.test(document.querySelector(".memory-toggle-row small")?.textContent ?? ""));
  await panel.locator(memorySwitch).click();
  await waitChecked(memorySwitch, "true");
  await waitChecked(contribute, "true");
  assert.equal(grants(), 1);
  assert.equal(await panel.getByRole("switch", { name: "Shared site reads" }).isDisabled(), false);
  assert.equal(await checked("Shared site reads"), "false", "Shared reads stay opt-in");

  await call("browser_run", { steps: [{ action: "navigate", url }] });
  await find(); await find();
  assert.equal(state(), 1);
  await observe("version"); await observe("version");
  assert.equal(state(), 2);

  // Turning task patterns off clears the queue and removes shared reads.
  await panel.getByRole("switch", { name: "Shared site reads" }).click();
  await waitChecked('[aria-label="Shared site reads"]', "true");
  await panel.getByRole("switch", { name: "Contribute task patterns" }).click();
  await waitChecked(contribute, "false");
  await waitChecked('[aria-label="Shared site reads"]', "false");
  assert.equal(grants(), 0);
  assert.equal(state(), 0);

  // The saved choice survives Action Memory changes and later updates.
  await panel.locator(memorySwitch).click();
  await waitChecked(memorySwitch, "false");
  await panel.locator(memorySwitch).click();
  await waitChecked(memorySwitch, "true");
  assert.equal(grants(), 0);
  assert.doesNotMatch(await note(), /Also shares/);
  await call("browser_finalize", { keep: [] });
  await upgrade();
  assert.equal(grants(), 0);
  console.log("PASS: updates never turn on task patterns, existing Action Memory users start off, turning Action Memory on beside the note agrees, shared reads need task patterns, and an opt-out survives Action Memory changes and updates.");
} finally {
  memory?.close();
  await fixture.cleanup();
}
