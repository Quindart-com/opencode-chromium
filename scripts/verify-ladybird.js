import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCoreRegistry } from "../src/core/registry.ts";
import { createAgentBrowserRuntime } from "../src/core/runtime.ts";

const page = '<title>Ladybird fixture</title><h1>Form fixture</h1>' +
  '<label for="entry">Fixture text</label><input id="entry">' +
  '<button id="run">Show result</button><output id="result"></output>' +
  '<label id="file-label" for="file">Choose image</label><input id="file" type="file">' +
  '<script>document.querySelector("#run").addEventListener("click", event => {' +
  'document.querySelector("#result").textContent = document.querySelector("#entry").value + " | " + event.isTrusted;' +
  '});</script>';
if (process.argv.includes("--fixture")) {
  console.log(page);
  process.exit(0);
}
const driver = process.env.LADYBIRD_TEST_DRIVER;
const distro = process.env.LADYBIRD_TEST_WSL;
const externalFixture = process.env.LADYBIRD_TEST_FIXTURE_URL;
if (!driver) throw new Error("Set LADYBIRD_TEST_DRIVER to the Ladybird WebDriver executable.");
if (distro && !externalFixture) throw new Error("For a Windows-to-WSL run, set LADYBIRD_TEST_FIXTURE_URL to this fixture served from inside WSL.");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-ladybird-test-"));
process.env.OPENCODE_BROWSER_RUNTIME_DIR = root;
process.env.AGENT_BROWSER_PROFILE_REGISTRY_DIR = path.join(root, "empty-profiles");
fs.writeFileSync(path.join(root, "ladybird.json"), JSON.stringify({ driver, ...(distro ? { distro } : {}) }));
const runtime = createAgentBrowserRuntime();
const tools = createCoreRegistry(runtime);
const sessionId = "ladybird-fixture";
const invoke = (name, args, session = sessionId) => tools[name].execute({ sessionId: session, ...args }, {});
async function ok(name, args, session) {
  const result = await invoke(name, args, session);
  assert.equal(result.ok, true, JSON.stringify({ ...result, result: undefined }));
  return result;
}
const server = !externalFixture ? http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(request.url === "/next" ? "<title>Next fixture</title><h1>Next fixture</h1>" : page);
}) : null;

try {
  if (server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  const url = externalFixture ?? "http://127.0.0.1:" + server.address().port + "/";
  const opened = await ok("browser_session", { action: "open", profile: "Ladybird (Experimental)" });
  assert.equal(opened.result.experimental, true);
  assert.deepEqual(opened.result.tabs, []);
  const first = await ok("browser_session", { action: "new-tab" });
  const second = await ok("browser_session", { action: "new-tab" });
  const firstId = first.activeTabId;
  const secondId = second.activeTabId;
  assert.notEqual(firstId, secondId);
  await ok("browser_run", { tab: { tabId: firstId }, steps: [{ action: "navigate", url }] });
  const read = await ok("browser_observe", { mode: "read", tabId: firstId });
  const ref = Number(/\[(\d+)\] button Show result/.exec(read.result.view)?.[1]);
  assert.ok(ref > 0, read.result.view);
  await ok("browser_run", { tab: { tabId: firstId }, steps: [
    { action: "fill", target: { selector: "#entry" }, value: "Ladybird" },
    { action: "click", target: { ref } },
  ] });
  const value = await ok("browser_observe", { mode: "extract", tabId: firstId, target: { selector: "#result" } });
  assert.equal(value.result.text, "Ladybird | true");
  const blank = await ok("browser_observe", { mode: "read", tabId: secondId });
  assert.equal(blank.result.url, "about:blank");
  const png = await ok("browser_observe", { mode: "screenshot", delivery: "inline", tabId: firstId });
  assert.equal(png.result.mimeType, "image/png");
  assert.equal(Buffer.from(png.result.base64, "base64").subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const found = await ok("browser_observe", { mode: "search", query: "Show result", tabId: firstId });
  assert.ok(found.result.results.some(item => item.selector === "#run"));
  const file = await invoke("browser_run", { tab: { tabId: firstId }, steps: [{ action: "click", target: { selector: "#file-label" } }] });
  assert.equal(file.results[0].error.code, "UNSUPPORTED_CAPABILITY");
  const foreign = await invoke("browser_observe", { mode: "read", tabId: firstId }, "other-session");
  assert.equal(foreign.error.code, "TAB_NOT_OWNED");
  await ok("browser_run", { tab: { tabId: firstId }, steps: [{ action: "reload" }] });
  const stale = await invoke("browser_run", { tab: { tabId: firstId }, steps: [{ action: "click", target: { ref } }] });
  assert.equal(stale.results[0].error.code, "STALE_TARGET");
  const rejected = await invoke("browser_finalize", { keep: [{ tabId: firstId, status: "handoff" }] });
  assert.equal(rejected.error.code, "UNSUPPORTED_CAPABILITY");
  const finalized = await ok("browser_finalize", {});
  assert.equal(finalized.result.closed, true);
  assert.deepEqual(finalized.result.tabs.map(tab => tab.id), [firstId, secondId]);
  const fresh = await ok("browser_session", { action: "open" });
  assert.deepEqual(fresh.result.tabs, []);
  console.log("Ladybird passed profile selection, tab isolation, navigation, read and reference input, lexical search, file-picker blocking, PNG capture, stale references, and finalization.");
} finally {
  await runtime.close();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
