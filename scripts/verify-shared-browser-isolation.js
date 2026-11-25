import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { McpWorker } from "../src/control/mcp-worker.ts";
import { chromiumExtensionFixture } from "./fixtures/chromium-extension.js";

// Run with Node after building the runtime and Chromium extension.
let acknowledge;
let commits = 0;
const entered = Promise.withResolvers();
const server = http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/commit") {
    commits++;
    if (commits > 1) return response.writeHead(409).end();
    acknowledge = () => response.writeHead(204).end();
    entered.resolve();
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  if (request.url === "/typing") {
    response.end(`<!DOCTYPE html><input id="typing" autofocus><script>
      window.losses = 0;
      addEventListener('blur', () => losses++);
      document.addEventListener('visibilitychange', () => { if (document.hidden) losses++; });
      document.getElementById('typing').addEventListener('blur', () => losses++);
    </script>`);
    return;
  }
  const slow = request.url === "/slow";
  response.end(`<!DOCTYPE html><button id="choice">Record example</button><button id="neighbor">Cancel</button>
    <output id="status">Ready</output><script>
      window.effects = [];
      document.getElementById('choice').onclick = async () => {
        effects.push('submitted');
        if (${slow}) {
          const reply = await fetch('/commit', { method: 'POST' });
          if (!reply.ok) return;
        }
        document.getElementById('status').textContent = 'Confirmed';
      };
      document.getElementById('neighbor').onclick = () => effects.push('cancelled');
    </script>`);
});

await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
const origin = `http://127.0.0.1:${server.address().port}`;
const slowUrl = `http://localhost:${server.address().port}/slow`;
const clients = [];
let fixture;
try {
  fixture = await chromiumExtensionFixture();
  const connect = async sessionId => {
    const worker = new McpWorker(process.cwd(), [], {
      ...process.env,
      OPENCODE_BROWSER_RUNTIME_DIR: path.join(fixture.fixture, "runtime"),
      OPENCODE_BROWSER_MEMORY: "0",
      AGENT_BROWSER_SESSION_ID: sessionId,
      AGENT_BROWSER_ARTIFACT_DIR: path.join(fixture.fixture, "artifacts"),
    }, () => {});
    clients.push(worker);
    await worker.initialize({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shared-browser-isolation", version: "1" } });
    worker.notification({ jsonrpc: "2.0", method: "notifications/initialized" });
    return async (name, args = {}) => {
      const response = await worker.request("tools/call", { name, arguments: { profile: fixture.profileId, sessionId, ...args } }, undefined, 15000);
      assert.equal(response.error, undefined, JSON.stringify(response));
      return response.result.structuredContent;
    };
  };
  const requireOk = result => {
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const open = async (call, url) => {
    const tab = requireOk(await call("browser_session", { action: "new-tab" }));
    requireOk(await call("browser_run", { memoryMode: "off", steps: [{ action: "navigate", url }] }));
    const page = fixture.context.pages().find(candidate => candidate.url() === url);
    assert.ok(page, `Owned page failed to open: ${url}`);
    return { page, id: tab.activeTabId };
  };
  const [slow, fast] = await Promise.all([connect("isolation-slow"), connect("isolation-fast")]);
  const slowTab = await open(slow, slowUrl);
  const fastTab = await open(fast, `${origin}/fast`);
  assert.notEqual(slowTab.id, fastTab.id);
  const sentinel = await fixture.context.newPage();
  await sentinel.goto(`${origin}/typing`);
  await sentinel.bringToFront();
  await sentinel.locator("#typing").focus();
  const extension = fixture.context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${fixture.extensionId}/`));
  assert.ok(extension);
  await extension.evaluate(expected => {
    globalThis.focusChanges = [];
    chrome.tabs.onActivated.addListener(({ tabId }) => focusChanges.push(tabId));
    return chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab.url !== expected) throw new Error("Sentinel must start in the active tab");
    });
  }, sentinel.url());

  const click = { memoryMode: "off", steps: [{ action: "click", target: { selector: "#choice" },
    settle: { condition: "contains", target: { selector: "#status" }, value: "Confirmed", timeoutMs: 10000 } }] };
  let acknowledged = false;
  const slowRun = slow("browser_run", click).then(result => { acknowledged = true; return result; });
  await Promise.race([entered.promise, slowRun.then(result => { throw new Error(`Slow action ended before its acknowledgement was held: ${JSON.stringify(result)}`); })]);
  await sentinel.keyboard.press("a");
  requireOk(await fast("browser_run", click));
  await sentinel.keyboard.press("b");
  assert.equal(acknowledged, false, "The healthy tab must finish while the slow acknowledgement is held");
  const forbidden = await fast("browser_run", { memoryMode: "off", tab: { tabId: slowTab.id },
    steps: [{ action: "click", target: { selector: "#neighbor" } }] });
  assert.equal(forbidden.ok, false, "A second client must not mutate the owned tab");
  acknowledge();
  requireOk(await slowRun);
  await sentinel.keyboard.press("c");

  assert.equal(commits, 1);
  assert.deepEqual(await slowTab.page.evaluate(() => window.effects), ["submitted"]);
  assert.deepEqual(await fastTab.page.evaluate(() => window.effects), ["submitted"]);
  assert.deepEqual(await sentinel.locator("#typing").evaluate(input => ({ value: input.value, losses: window.losses,
    focused: document.hasFocus() && document.activeElement === input })), { value: "abc", losses: 0, focused: true });
  assert.deepEqual(await extension.evaluate(() => globalThis.focusChanges), []);
  await Promise.all([slow("browser_finalize"), fast("browser_finalize")]);
  console.log("Verified parallel MCP actions, one submission per tab, cross-tab rejection, and foreground typing.");
} finally {
  for (const client of clients) client.close();
  await fixture?.cleanup();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
