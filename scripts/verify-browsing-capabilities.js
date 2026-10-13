import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { z } from "zod";
import { AgentBrowserRuntime } from "../src/core/runtime.js";
import { ArtifactStore } from "../src/core/artifacts.js";
import { createDiscoveryOperations } from "../src/browser/discovery.js";
import { domSnapshotExpression, pageSearchUnitsExpression } from "../src/browser/operations/snapshot-expressions.js";
import { visualMapExpression, pageInspectExpression } from "../src/browser/operations/inspection-expressions.js";

const child = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(request.url === "/leaf" ? "<p>Nested frame fixture</p>" : '<button>Cross-origin frame fixture</button><iframe src="/leaf"></iframe>');
});
await new Promise(resolve => child.listen(0, "127.0.0.1", resolve));
const childUrl = `http://127.0.0.1:${child.address().port}`;
const parent = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<title>Capability fixture</title><button id="choose">Choose</button><input id="name" value="Before"><input type="password" value="fixture-password" aria-label="Password"><input autocomplete="one-time-code" value="fixture-otp"><input autocomplete="cc-number" value="fixture-card"><iframe src="${childUrl}"></iframe><iframe src="${childUrl}"></iframe>`);
});
await new Promise(resolve => parent.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${parent.address().port}`;
let browser, runtime;
const timings = [];
try {
  browser = await chromium.launch({ headless: true, channel: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE ? undefined : process.env.OPENCODE_TEST_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined), executablePath: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE || undefined });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(url); await page.locator("iframe").last().waitFor();
  const cdp = await page.context().newCDPSession(page);
  const evaluate = async (_context, _tab, expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const operations = {
    browser_get_tab: { args: { tabId: z.number() }, execute: async () => ({ id: 1, url: page.url() }) },
    browser_dom_snapshot: { args: { tabId: z.number() }, execute: async () => evaluate({}, 1, domSnapshotExpression()) },
    browser_screenshot: { args: { tabId: z.number(), clip: z.unknown().optional() }, execute: async args => ({ mimeType: "image/png", base64: (await page.screenshot({ type: "png", clip: args.clip })).toString("base64") }) },
  };
  for (const [name, definition] of Object.entries(createDiscoveryOperations({ evaluate, command: (_ctx, _tab, method, params) => cdp.send(method, params), getTab: async () => ({ url: page.url() }) }))) Object.defineProperty(operations, name, { value: definition });
  runtime = new AgentBrowserRuntime({ operationFactory: async () => ({ tool: operations }), artifactStore: new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "capability-qa-")) }) });
  runtime.getSession("fixture").profileId = "fixture";
  const call = async (name, args) => {
    const start = performance.now(); const result = await runtime.invoke(name, { tabId: 1, ...args }, "fixture");
    timings.push({ capability: name, ms: Number((performance.now() - start).toFixed(2)) }); return result;
  };
  for (const expression of [domSnapshotExpression(), pageSearchUnitsExpression(), visualMapExpression(), pageInspectExpression({ selector: "body" })]) {
    const result = JSON.stringify(await evaluate({}, 1, expression));
    for (const secret of ["fixture-password", "fixture-otp", "fixture-card"]) assert.equal(result.includes(secret), false, "sensitive input values stay out of observations");
  }
  const captured = await call("browser_observation_capture", { kind: "both" });
  await page.locator("#name").fill("After");
  const diff = await call("browser_observation_diff", { baseline: captured.baseline });
  assert.equal(diff.snapshot.counts.changed, 1); assert.ok(diff.pixels.changedPixels > 0);
  await page.locator("#name").fill("Before");
  const same = await call("browser_observation_diff", { baseline: captured.baseline });
  assert.equal(same.snapshot.counts.changed, 0);
  const frames = await call("browser_frames", { maxDepth: 3, maxFrames: 10 });
  assert.equal(frames.frames.length, 5); assert.equal(new Set(frames.frames.map(frame => frame.frameId)).size, 5);
  const matching = frames.frames.filter(frame => frame.url === `${childUrl}/`);
  assert.equal(matching.length, 2);
  for (const frame of matching) assert.match((await call("browser_frame_inspect", { frameId: frame.frameId })).text, /Cross-origin frame fixture/);
  assert.equal((await call("browser_frames", { maxDepth: 0, maxFrames: 10 })).frames.length, 1);
  await page.evaluate(() => Object.defineProperty(document, "modelContext", { configurable: true, value: { getTools: async () => Array.from({ length: 40 }, (_, i) => ({ name: `fixture${i}`, description: "Read-only fixture", inputSchema: { type: "object" } })) } }));
  const webmcp = await call("browser_webmcp_discover", { limit: 3 });
  assert.equal(webmcp.tools.length, 3); assert.equal(webmcp.truncated, true); assert.equal(webmcp.executionEnabled, false);
  const report = { ok: true, browser: browser.version(), checks: ["sensitive-value redaction", "semantic and pixel diffs", "duplicate-URL cross-origin frames", "nested frame limits", "bounded WebMCP discovery"], timings };
  fs.mkdirSync("reports", { recursive: true }); fs.writeFileSync("reports/browsing-capabilities.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  runtime?.close(); await browser?.close();
  child.closeAllConnections(); parent.closeAllConnections();
  await Promise.all([new Promise(resolve => child.close(resolve)), new Promise(resolve => parent.close(resolve))]);
}
