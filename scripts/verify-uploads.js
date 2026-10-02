import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { createUploadFiles } from "../native-host/src/uploads.js";
import { createUploadConsent } from "../extension-src/entrypoints/background/upload-consent.js";
import { guardedCdp, uploadTargetUrl } from "../extension-src/entrypoints/background/upload-gate.js";
import { createDebuggerAttacher } from "../extension-src/entrypoints/background/debugger-attach.js";

// Isolated browser, local website, real CDP and native file snapshots. No personal profile.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "upload-verification-"));
const file = path.join(fixture, "private-document.txt");
fs.writeFileSync(file, "approved fixture contents");
const windows = new Map();
const removed = [];
const native = createUploadFiles();
let browser, consent, origin, id = 100;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/rpc") {
      let body = ""; for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      const token = message.token;
      const window = [...windows.values()].find(value => value.token === token);
      const sender = { id: "fixture-extension", url: `${origin}/upload-confirm.html?token=${token}`, tab: { id: window?.id } };
      let result;
      try { result = { result: await consent.message(message, sender) }; }
      catch (error) { result = { error: error.message }; }
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result)); return;
    }
    if (req.url === "/website") { res.setHeader("Content-Type", "text/html"); res.end('<!doctype html><input type="file" id="document">'); return; }
    const pathname = new URL(req.url, origin).pathname;
    const target = path.resolve("extension", "." + pathname);
    if (!target.startsWith(path.resolve("extension") + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(target)] ?? "application/octet-stream");
    res.end(fs.readFileSync(target));
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 500, height: 560 } });
  const website = await context.newPage();
  await website.goto(`${origin}/website`);
  const session = await context.newCDPSession(website);
  const chrome = {
    runtime: { id: "fixture-extension", getURL: page => `${origin}/${page}` },
    storage: { local: { get: async () => ({}) } },
    windows: {
      onRemoved: { addListener: callback => removed.push(callback) },
      create: async ({ url, type }) => {
        assert.equal(type, "popup");
        const page = await context.newPage(); const windowId = ++id;
        windows.set(windowId, { id: windowId, page, token: new URL(url).searchParams.get("token") });
        page.on("close", () => { windows.delete(windowId); removed.forEach(callback => callback(windowId)); });
        await page.addInitScript(() => { globalThis.chrome = { runtime: { sendMessage: message => fetch("/rpc", { method: "POST", body: JSON.stringify(message) }).then(response => response.json()) } }; });
        await page.goto(url);
        return { id: windowId, tabs: [{ id: windowId }] };
      },
      remove: async windowId => { await windows.get(windowId)?.page.close(); },
    },
  };
  consent = createUploadConsent({ chrome, describe: files => native("uploads.describe", { files }), snapshot: token => native("uploads.snapshot", { token }), release: token => native("uploads.release", { token }) });
  const attach = createDebuggerAttacher({ withTabLock: (_id, run) => run(), attachedTabs: new Map(), isBrowserInternalUrl: url => !url.startsWith(origin), getTab: async () => ({ url: website.url() }), chromeCall: async call => call(() => {}), chrome: { debugger: { attach: (_target, _version, done) => done(), detach: (_target, done) => done() } }, DEBUGGER_VERSION: "1.3", errorMessage: String, sendCdpCommand: (_id, method, params) => session.send(method, params), DEFAULT_CDP_TIMEOUT_MS: 30000 });
  await attach(1, "fixture");
  const chooser = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Chooser interception did not fire")), 10000); session.once("Page.fileChooserOpened", event => { clearTimeout(timer); resolve(event); }); });
  await website.locator("#document").click();
  assert.ok((await chooser).backendNodeId, "CDP intercepts the chooser before the OS dialog opens");
  const { result } = await session.send("Runtime.evaluate", { expression: 'document.querySelector("#document")', returnByValue: false });
  const upload = () => guardedCdp({ method: "DOM.setFileInputFiles", commandParams: { objectId: result.objectId, files: [file] }, tabId: 1, consent, getTab: async () => ({ url: website.url() }), inspectTarget: (method, params) => uploadTargetUrl(method, params, (method, params) => session.send(method, params)), send: params => session.send("DOM.setFileInputFiles", params) });
  async function requestPage() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const page = [...windows.values()][0]?.page;
      if (page) { await page.getByRole("button", { name: "Allow upload", exact: true }).waitFor(); return page; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Upload confirmation did not open");
  }
  const denied = upload().then(() => "unexpected", error => error.message);
  let confirmation = await requestPage();
  assert.equal(await website.locator("#document").evaluate(input => input.files.length), 0);
  assert.equal(await confirmation.getByText("private-document.txt", { exact: true }).count(), 1);
  fs.mkdirSync("reports", { recursive: true });
  await confirmation.screenshot({ path: "reports/upload-confirmation.png", fullPage: true });
  // Untrusted script clicks cannot approve. Playwright's input events then exercise a human decision.
  await confirmation.getByRole("button", { name: "Allow upload", exact: true }).evaluate(button => button.click());
  assert.equal(await website.locator("#document").evaluate(input => input.files.length), 0);
  await confirmation.getByRole("button", { name: "Cancel upload", exact: true }).click();
  assert.match(await denied, /Upload refused/);
  assert.equal(await website.locator("#document").evaluate(input => input.files.length), 0);
  const approved = upload();
  confirmation = await requestPage();
  await confirmation.getByRole("button", { name: "Allow upload", exact: true }).click();
  await approved;
  assert.equal(await website.locator("#document").evaluate(input => input.files[0].name), "private-document.txt");
  assert.equal(await website.locator("#document").evaluate(input => input.files[0].text()), "approved fixture contents", "files remain readable when the website submits later");
  console.log("Upload browser checks passed: picker interception, cancel, trusted approval, preserved file content.");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
}
