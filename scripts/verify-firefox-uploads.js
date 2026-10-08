import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { FirefoxBackend, remoteValue } from "../native-host/src/firefox/backend.js";
import { executableCandidates } from "../src/cli/browsers.js";
import { createUploadFiles } from "../native-host/src/uploads.js";
import { createUploadConsent } from "../extension-src/entrypoints/background/upload-consent.js";
import { guardedCdp, uploadTargetUrl } from "../extension-src/entrypoints/background/upload-gate.js";

// Real Firefox input/file assignment and the compiled shared consent panel.
// Only synthetic content in a disposable profile is exposed to the test shim.
const browser = process.argv.includes("--librewolf") ? "librewolf" : "firefox";
const executable = process.env.OPENCODE_FIREFOX_TEST_EXECUTABLE ?? executableCandidates(browser).find(fs.existsSync);
if (!executable) throw Error("Test browser executable missing");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "firefox-upload-"));
const file = path.join(fixture, "approved-fixture.txt"); fs.writeFileSync(file, "approved fixture contents");
const windows = new Map(), removed = []; let id = 100, origin, consent, backend, child;
const native = createUploadFiles();
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/rpc") {
      let body = ""; for await (const chunk of req) body += chunk;
      const message = JSON.parse(body), window = [...windows.values()].find(w => w.token === message.token);
      let reply;
      try { reply = { result: await consent.message(message, { id: "fixture-extension", url: origin + "/upload-confirm.html?token=" + message.token, tab: { id: window?.id } }) }; }
      catch (error) { reply = { error: error.message }; }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(reply)); return;
    }
    if (req.url === "/website") { res.setHeader("Content-Type", "text/html"); res.end('<input id="document" type="file">'); return; }
    const target = path.resolve("extension-firefox", "." + new URL(req.url, origin).pathname);
    if (!target.startsWith(path.resolve("extension-firefox") + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(target)] ?? "application/octet-stream");
    const content = fs.readFileSync(target);
    res.end(path.extname(target) === ".html" ? content.toString().replace('<head>', '<head><script>globalThis.chrome={runtime:{sendMessage:m=>fetch("/rpc",{method:"POST",body:JSON.stringify(m)}).then(r=>r.json())}}</script>') : content);
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); origin = "http://127.0.0.1:" + server.address().port;
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const evaluate = async (context, expression) => remoteValue((await backend.send("script.evaluate", { target: { context }, expression, awaitPromise: true })).result);
const trustedClick = async (context, label) => {
  const point = await evaluate(context, `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent===${JSON.stringify(label)});if(!e||e.disabled)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(point, "Consent button is ready");
  await backend.send("input.performActions", { context, actions: [{ type: "pointer", id: "fixture-consent", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", ...point, origin: "viewport" }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }] });
};
try {
  child = spawn(executable, ["--headless", "--no-remote", "--profile", fixture, "--remote-debugging-port", String(port), "about:blank"], { windowsHide: true, stdio: "ignore" });
  backend = new FirefoxBackend({ endpoint: "ws://127.0.0.1:" + port + "/session" });
  for (let i = 0; ; i++) { try { await backend.connect(); break; } catch (error) { if (i >= 25 || child.exitCode !== null) throw error; await new Promise(resolve => setTimeout(resolve, 250)); } }
  const website = (await backend.send("browsingContext.create", { type: "tab" })).context;
  await backend.send("browsingContext.navigate", { context: website, url: origin + "/website", wait: "complete" });
  const marker = "a".repeat(32); await evaluate(website, `document.documentElement.setAttribute('data-opencode-bidi-bridge','${marker}')`); await backend.attach(1, marker);
  consent = createUploadConsent({ chrome: {
    runtime: { id: "fixture-extension", getURL: page => origin + "/" + page }, storage: { local: { get: async () => ({}) } },
    windows: { onRemoved: { addListener: callback => removed.push(callback) },
      create: async ({ url }) => { const context = (await backend.send("browsingContext.create", { type: "tab" })).context, windowId = ++id; windows.set(windowId, { id: windowId, context, token: new URL(url).searchParams.get("token") }); await backend.send("browsingContext.navigate", { context, url, wait: "complete" }); return { id: windowId, tabs: [{ id: windowId }] }; },
      remove: async windowId => { const window = windows.get(windowId); windows.delete(windowId); if (window) await backend.send("browsingContext.close", { context: window.context }).catch(() => {}); removed.forEach(callback => callback(windowId)); },
    },
  }, describe: files => native("uploads.describe", { files }), snapshot: token => native("uploads.snapshot", { token }), release: token => native("uploads.release", { token }) });
  const object = (await backend.command(1, "Runtime.evaluate", { expression: "document.querySelector('#document')", returnByValue: false })).result.objectId;
  const command = (method, params) => backend.command(1, method, params);
  const upload = () => guardedCdp({ method: "DOM.setFileInputFiles", commandParams: { objectId: object, files: [file] }, tabId: 1, consent, getTab: async () => ({ url: await evaluate(website, "location.href") }), inspectTarget: (method, params) => uploadTargetUrl(method, params, command), send: params => command("DOM.setFileInputFiles", params) });
  const confirmation = async () => { for (let i = 0; i < 100; i++) { const window = [...windows.values()][0]; if (window && await evaluate(window.context, "document.body.innerText.includes('Allow upload')")) return window.context; await new Promise(resolve => setTimeout(resolve, 50)); } throw Error("Consent UI did not become ready"); };
  const denied = upload().then(() => "unexpected", error => error.message); let context = await confirmation();
  await evaluate(context, "[...document.querySelectorAll('button')].find(e=>e.textContent==='Allow upload').click()");
  assert.equal(await evaluate(website, "document.querySelector('#document').files.length"), 0);
  await trustedClick(context, "Cancel upload"); assert.match(await denied, /Upload refused/);
  const approved = upload(); context = await confirmation(); await trustedClick(context, "Allow upload"); await approved;
  assert.equal(await evaluate(website, "document.querySelector('#document').files[0].text()"), "approved fixture contents");
  fs.mkdirSync("reports", { recursive: true }); fs.writeFileSync("reports/" + browser + "-upload-parity.json", JSON.stringify({ browser, checks: ["synthetic approval rejected", "trusted cancel", "trusted approval", "file contents preserved"] }, null, 2));
  console.log(browser + " upload consent checks passed");
} finally {
  if (backend?.ready) await backend.send("browser.close", {}, 2000).catch(() => {}); await backend?.close();
  if (child && child.exitCode === null) { if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {} } else child.kill(); }
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir())); fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
}
