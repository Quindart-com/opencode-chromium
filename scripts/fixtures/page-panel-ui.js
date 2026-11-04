import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

/** Packaged rendering only: this fixture does not establish extension authorization. */
export async function pagePanelUiFixture(origin) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync("extension/_locales/en/messages.json", "utf8"))).map(([key, value]) => [key, value.message]));
  await context.exposeBinding("__openPagePanelFixture", async () => {
    const website = context.pages().find(page => page.url() === origin + "/");
    if (!website) return { error: "pagePanelUnavailable" };
    await website.addScriptTag({ path: path.resolve("extension/page-panel.js") });
    await website.evaluate(() => {
      for (const listener of globalThis.__panelFixtureMessages) listener({ type: "PAGE_PANEL_SHOW", instance: "fixture-instance" }, { id: "fixture" }, () => {});
    });
    return { ok: true };
  });
  await context.exposeBinding("__openTrustedPanelFixture", async (_source, view) => {
    const page = await context.newPage(); await page.goto(`${origin}/popup.html#${view}`);
  });
  await context.addInitScript(({ origin, messages }) => {
    const summary = { connected: true, harnessesKnown: true, harnesses: [{ id: "codex", connected: true, version: "1.2.3" }, { id: "opencode", connected: false, version: "2.0.0" }, { id: "dsh", connected: false, version: "0.2.0" }], assistance: true, usage: { input: 700, output: 0, calls: 7, cost: null, days: Array.from({ length: 7 }, (_, day) => ({ date: `2026-01-${String(day + 1).padStart(2, "0")}`, inputTokens: 100, outputTokens: 0, calls: 1 })) }, memory: { enabled: true, actions: 2, recipes: 1 } };
    globalThis.__panelFixtureMessages = [];
    globalThis.chrome = {
      i18n: { getUILanguage: () => "en", getMessage(key, substitutions) { let value = messages[key] || key; for (const [index, item] of (Array.isArray(substitutions) ? substitutions : substitutions === undefined ? [] : [substitutions]).entries()) value = value.replaceAll("$" + (index + 1), item); return value; } },
      runtime: {
        id: "fixture", getURL: value => origin + value, getManifest: () => ({ version: "2.0.3" }),
        onMessage: { addListener: listener => globalThis.__panelFixtureMessages.push(listener), removeListener: listener => { globalThis.__panelFixtureMessages = globalThis.__panelFixtureMessages.filter(item => item !== listener); } },
        connect({ name }) {
          const receivers = [], disconnected = []; let closed = false;
          const port = { onMessage: { addListener: listener => receivers.push(listener) }, onDisconnect: { addListener: listener => disconnected.push(listener) },
            postMessage(value) { if (value.type === "open") void globalThis.__openTrustedPanelFixture(value.view); if (value.type === "refresh") receivers.forEach(listener => listener({ type: "snapshot", data: summary })); },
            disconnect() { if (closed) return; closed = true; disconnected.forEach(listener => listener()); },
          };
          queueMicrotask(() => receivers.forEach(listener => listener(name.startsWith("page-panel:") ? { type: "snapshot", data: summary } : { type: "NATIVE_STATUS", status: { state: "connected" } })));
          return port;
        },
        sendMessage: async value => value.type === "PAGE_PANEL_OPEN" ? globalThis.__openPagePanelFixture() : { status: { state: "connected" } },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
  }, { origin, messages });
  return { context, extensionId: "fixture", cleanup: () => browser.close() };
}
