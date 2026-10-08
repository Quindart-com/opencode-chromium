import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { FirefoxBackend } from "../native-host/src/firefox/backend.js";
import { executableCandidates } from "../src/cli/browsers.js";
import { pageSearchUnitsExpression, selectorClickTargetExpression } from "../src/browser/operations/index.js";
const browser = process.argv.includes("--librewolf") ? "librewolf" : "firefox";
const executable = process.env.OPENCODE_FIREFOX_TEST_EXECUTABLE ?? executableCandidates(browser).find(file => fs.existsSync(file));
if (!executable) throw new Error(browser + " executable missing");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-bidi-"));
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(req.url === "/next" ? '<h1>Next page</h1>' : '<title>Parity fixture</title><button id="choose" onclick="window.clicked=event.isTrusted">Choose blue</button><input id="name"><input id="file" type="file"><div id="drag" style="width:80px;height:80px;background:blue" onpointerdown="window.dragged=event.isTrusted" onpointerup="window.released=event.isTrusted"></div><a href="/next">Next</a>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const portProbe = net.createServer(); await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve)); const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
const child = spawn(executable, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", String(port), "about:blank"], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let logs = ""; child.stderr.on("data", data => { logs = (logs + data).slice(-4000); });
const events = [];
const backend = new FirefoxBackend({ endpoint: "ws://127.0.0.1:" + port + "/session", onEvent: (tab, method, params) => events.push({ tab, method, params }) });
const report = { browser, checks: [], durationMs: 0 };
const started = performance.now();
try {
  for (let i = 0; ; i++) { try { await backend.connect(); break; } catch (error) { if (i >= 25 || child.exitCode !== null) throw new Error(error.message + "; " + logs); await new Promise(resolve => setTimeout(resolve, 250)); } }
  const url = "http://127.0.0.1:" + server.address().port + "/";
  const a = await backend.send("browsingContext.create", { type: "tab" });
  const b = await backend.send("browsingContext.create", { type: "tab" });
  for (const context of [a.context, b.context]) await backend.send("browsingContext.navigate", { context, url, wait: "complete" });
  await backend.send("script.evaluate", { target: { context: b.context }, expression: "document.documentElement.setAttribute('data-fixture-owner','other-tab')", awaitPromise: false });
  const marker = "a".repeat(32);
  await backend.send("script.evaluate", { target: { context: a.context }, expression: "document.documentElement.setAttribute('data-opencode-bidi-bridge', '" + marker + "')", awaitPromise: false });
  await backend.attach(1, marker); assert.equal(backend.contexts.get(1), a.context); report.checks.push("duplicate-URL nonce bridge");
  const evaluate = async expression => { const r = await backend.command(1, "Runtime.evaluate", { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  const page = await evaluate(pageSearchUnitsExpression({ maxUnits: 100 })); assert.ok(page.units.some(unit => unit.text?.includes("Choose blue"))); report.checks.push("page inspection");
  const point = await evaluate(selectorClickTargetExpression("#choose"));
  await backend.command(1, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await backend.command(1, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  await backend.command(1, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
  assert.equal(await evaluate("window.clicked"), true); report.checks.push("trusted click");
  await evaluate("document.querySelector('#name').focus()"); await backend.command(1, "Input.insertText", { text: "Luna ✓" });
  assert.equal(await evaluate("document.querySelector('#name').value"), "Luna ✓"); report.checks.push("trusted text input");
  const drag = await evaluate(selectorClickTargetExpression("#drag"));
  await backend.command(1, "Input.dispatchMouseEvent", { type: "mouseMoved", ...drag });
  await backend.command(1, "Input.dispatchMouseEvent", { type: "mousePressed", button: "left" });
  await backend.command(1, "Input.dispatchMouseEvent", { type: "mouseMoved", x: drag.x + 10, y: drag.y + 10 });
  await backend.command(1, "Input.dispatchMouseEvent", { type: "mouseReleased", button: "left" });
  assert.equal(await evaluate("window.dragged && window.released"), true); report.checks.push("trusted drag gesture");
  await backend.send("script.evaluate", { target: { context: a.context }, expression: "setTimeout(()=>alert('Owned fixture dialog'),0)", awaitPromise: false });
  for (let i = 0; i < 50 && !events.some(e => e.method === "Page.javascriptDialogOpening"); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(events.some(e => e.method === "Page.javascriptDialogOpening"));
  await backend.command(1, "Page.handleJavaScriptDialog", { accept: true }); report.checks.push("dialog events and handling");
  const file = path.join(profile, "fixture.txt"); fs.writeFileSync(file, "approved fixture");
  const object = await backend.command(1, "Runtime.evaluate", { expression: "document.querySelector('#file')", returnByValue: false });
  await backend.command(1, "DOM.setFileInputFiles", { objectId: object.result.objectId, files: [file] });
  assert.equal(await evaluate("document.querySelector('#file').files[0].name"), "fixture.txt"); await backend.command(1, "Runtime.releaseObject", { objectId: object.result.objectId }); report.checks.push("live file node upload");
  const screenshot = await backend.command(1, "Page.captureScreenshot", { format: "jpeg", quality: 45 }); assert.ok(screenshot.data.length > 100); report.checks.push("JPEG screenshot");
  await backend.command(1, "Page.navigate", { url: url + "next" }); await backend.command(1, "Page.traverseHistory", { delta: -1 });
  for (let i = 0; i < 50 && await evaluate("location.pathname") !== "/"; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await evaluate("location.pathname"), "/"); report.checks.push("navigation and back");
  assert.equal(await evaluate("typeof globalThis.__opencodeFileGuard"), "function"); report.checks.push("file-picker guard after navigation");
  await backend.detach(1); assert.equal(backend.contexts.has(1), false); report.checks.push("detach releases ownership");
  await backend.connect(); report.checks.push("BiDi session reconnect after finalization");
  // Context IDs belong to a BiDi session and may change after session.end.
  const tree = await backend.send("browsingContext.getTree", {});
  let otherSurvives = false;
  for (const context of tree.contexts) { const result = await backend.send("script.evaluate", { target: { context: context.context }, expression: "document.documentElement?.getAttribute('data-fixture-owner')", awaitPromise: false }); if (result.result?.value === "other-tab") otherSurvives = true; }
  assert.ok(otherSurvives); report.checks.push("other tab survives finalization");
  report.durationMs = Math.round(performance.now() - started);
  fs.mkdirSync("reports", { recursive: true }); fs.writeFileSync("reports/" + browser + "-parity.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { console.error("Parity failed:", error.message, logs); throw error; } finally {
  if (backend.ready) await backend.send("browser.close", {}, 2000).catch(() => {});
  backend.close(); if (process.platform === "win32" && child.exitCode === null) { try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {} } else child.kill(); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 }); } catch { console.error("Temporary profile cleanup pending:", profile); }
}
