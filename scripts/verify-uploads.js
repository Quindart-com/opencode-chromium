import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";
import { glassTextContrast } from "./fixtures/glass-contrast.js";
import { createUploadFiles } from "../native-host/src/uploads.ts";
import { createUploadConsent } from "../extension-src/entrypoints/background/upload-consent.ts";
import { guardedCdp, uploadTargetUrl } from "../extension-src/entrypoints/background/upload-gate.ts";
import { createDebuggerAttacher } from "../extension-src/entrypoints/background/debugger-attach.ts";

// Isolated browser, local website, real CDP and native file snapshots. No personal profile.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "upload-verification-"));
const file = path.join(fixture, "private-document.txt");
fs.writeFileSync(file, "approved fixture contents");
const windows = new Map();
const removed = [];
const native = createUploadFiles();
const locale = JSON.parse(fs.readFileSync("extension/_locales/en/messages.json", "utf8"));
const fixtureMessages = Object.fromEntries(Object.entries(locale).map(([key, value]) => [key, value.message]));
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
    res.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" }[path.extname(target)] ?? "application/octet-stream");
    res.end(fs.readFileSync(target));
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE || undefined, channel: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE ? undefined : process.env.OPENCODE_TEST_BROWSER_CHANNEL || undefined });
  const context = await browser.newContext({ viewport: { width: 500, height: 560 } });
  const website = await context.newPage();
  await website.goto(`${origin}/website`);
  const session = await context.newCDPSession(website);
  const chrome = {
    runtime: { id: "fixture-extension", getURL: page => new URL(page, origin + "/").href },
    storage: { local: { get: async () => ({}) } },
    windows: {
      onRemoved: { addListener: callback => removed.push(callback) },
      create: async ({ url, type }) => {
        assert.equal(type, "popup");
        const page = await context.newPage(); const windowId = ++id;
        windows.set(windowId, { id: windowId, page, token: new URL(url).searchParams.get("token") });
        page.on("close", () => { windows.delete(windowId); removed.forEach(callback => callback(windowId)); });
        await page.addInitScript((messages) => { globalThis.chrome = { i18n: { getUILanguage: () => "en", getMessage: (key, values) => { let result = messages[key] || key; for (const [index, value] of (Array.isArray(values) ? values : values === undefined ? [] : [values]).entries()) result = result.replaceAll("$" + (index + 1), value); return result; } }, runtime: { sendMessage: message => fetch("/rpc", { method: "POST", body: JSON.stringify(message) }).then(response => response.json()) } }; }, fixtureMessages);
        await page.goto(url);
        return { id: windowId, tabs: [{ id: windowId }] };
      },
      update: async (windowId, change) => { if(change.focused) await windows.get(windowId)?.page.bringToFront(); return {id:windowId}; },
      remove: async windowId => { await windows.get(windowId)?.page.close(); },
    },
  };
  consent = createUploadConsent({ chrome, describe: files => native("uploads.describe", { files }), snapshot: token => native("uploads.snapshot", { token }), release: token => native("uploads.release", { token }) });
  const attach = createDebuggerAttacher({ withTabLock: (_id, run) => run(), attachedTabs: new Map(), isBrowserInternalUrl: url => !url.startsWith(origin), getTab: async () => ({ url: website.url() }), chromeCall: async call => call(() => {}), chrome: { debugger: { attach: async () => {}, detach: async () => {} } }, DEBUGGER_VERSION: "1.3", errorMessage: String, sendCdpCommand: (_id, method, params) => session.send(method, params), DEFAULT_CDP_TIMEOUT_MS: 30000 });
  await attach(1, "fixture");
  const chooser = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Chooser interception did not fire")), 10000); session.once("Page.fileChooserOpened", event => { clearTimeout(timer); resolve(event); }); });
  await website.locator("#document").click();
  assert.ok((await chooser).backendNodeId, "CDP intercepts the chooser before the OS dialog opens");
  const { result } = await session.send("Runtime.evaluate", { expression: 'document.querySelector("#document")', returnByValue: false });
  const upload = () => guardedCdp({ method: "DOM.setFileInputFiles", commandParams: { objectId: result.objectId, files: [file] }, tabId: 1, consent, getTab: async () => ({ url: website.url() }), inspectTarget: (method, params) => uploadTargetUrl(method, params, (method, params) => session.send(method, params)), send: params => session.send("DOM.setFileInputFiles", params) });
  async function requestPage() {
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const {page} of windows.values()) if(!page.isClosed() && await page.getByRole("button",{name:"Allow upload",exact:true}).count() && await page.getByRole("button",{name:"Allow upload",exact:true}).isVisible()) return page;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Upload confirmation did not open");
  }
  const denied = upload().then(() => null, error => error);
  let confirmation = await requestPage();
  assert.equal(await website.locator("#document").evaluate(input => input.files.length), 0);
  assert.equal(await confirmation.getByText("private-document.txt", { exact: true }).count(), 1);
  fs.mkdirSync("reports", { recursive: true });
  await confirmation.screenshot({ path: "reports/upload-confirmation.png", fullPage: true });
  // Untrusted script clicks cannot approve. Playwright's input events then exercise a human decision.
  await confirmation.getByRole("button", { name: "Allow upload", exact: true }).evaluate(button => button.click());
  assert.equal(await website.locator("#document").evaluate(input => input.files.length), 0);
  await confirmation.getByRole("button", { name: "Cancel upload", exact: true }).click();
  const refusal = await denied;
  assert.equal(refusal?.code, "UPLOAD_USER_DECLINED");
  assert.match(refusal.message, /user declined.*no files were uploaded/);
  assert.equal(await website.locator("#document").evaluate(input => input.files.length), 0);
  const approved = upload();
  confirmation = await requestPage();
  await confirmation.getByRole("button", { name: "Allow upload", exact: true }).click();
  await approved;
  assert.equal(await website.locator("#document").evaluate(input => input.files[0].name), "private-document.txt");
  assert.equal(await website.locator("#document").evaluate(input => input.files[0].text()), "approved fixture contents", "files remain readable when the website submits later");
  // A real immutable-snapshot failure must create an informational, non-consent surface.
  await website.locator('#document').evaluate(input=>{input.value='';});
  fs.writeFileSync(file,'before preparation failure');
  const failedPreparation = upload().then(()=>null,error=>error);
  confirmation = await requestPage();
  fs.writeFileSync(file,'changed after consent preview');
  const failureOpened = context.waitForEvent('page');
  await confirmation.getByRole('button',{name:'Allow upload',exact:true}).click();
  const failure = await failureOpened;
  await failure.getByRole('heading',{name:'Couldn’t prepare upload',exact:true}).waitFor();
  assert.match((await failedPreparation).message,/changed/i);
  assert.equal(await website.locator('#document').evaluate(input=>input.files.length),0);
  assert.equal(await failure.getByRole('button',{name:'Allow upload',exact:true}).count(),0);
  assert.equal(await failure.getByRole('button',{name:'Back to consent preview',exact:true}).isDisabled(),true);
  fs.mkdirSync('reports/state-review',{recursive:true});
  const contrastReview = [];
  for(const theme of ['light','dark'])for(const width of [360,500]) {
    await failure.emulateMedia({colorScheme:theme});await failure.setViewportSize({width,height:width===360?427:560});
    await failure.evaluate(()=>document.fonts.ready);
    const cancel = failure.getByRole('button',{name:'Cancel request',exact:true});
    const colors = ['#ffffff']; // Standalone review pages use the same white canvas in either system theme.
    const backdrops = colors.map(hex => [1,3,5].map(index => parseInt(hex.slice(index,index+2),16)/255));
    let previousPhase = 0;
    for (const phaseMs of [0,40,140]) {
      if (phaseMs > previousPhase) await failure.waitForTimeout(phaseMs-previousPhase);
      previousPhase = phaseMs;
      assert.equal(await cancel.isEnabled(),true,'Failure cancellation must stay enabled before a user action');
      const ratio = await cancel.evaluate(glassTextContrast,backdrops);
      contrastReview.push({theme,width,phaseMs,ratio,...await cancel.evaluate(element=>({color:getComputedStyle(element).color,disabled:element.disabled,focused:document.activeElement===element}))});
      assert.ok(ratio >= 4.5, `Enabled Cancel request needs 4.5:1 contrast during theme changes (${theme}, ${phaseMs}ms); got ${ratio}`);
    }

    assert.equal(await failure.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await failure.screenshot({path:`reports/state-review/upload-preparation-failure-${width}-${theme}.png`,fullPage:true});
  }
  fs.writeFileSync('reports/state-review/upload-control-contrast.json',JSON.stringify(contrastReview,null,2));
  assert.equal(await failure.getByRole('button',{name:'Review new request',exact:true}).isDisabled(),true);
  fs.writeFileSync(file,'fresh request after failure');
  const freshUpload = upload();
  const freshConfirmation = await requestPage();
  await failure.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent==='Review new request'&&!button.disabled));
  await failure.getByRole('button',{name:'Review new request',exact:true}).click();
  assert.equal(await website.locator('#document').evaluate(input=>input.files.length),0,'Reviewing a fresh request cannot approve it');
  await freshConfirmation.getByRole('button',{name:'Allow upload',exact:true}).click(); await freshUpload;
  assert.equal(await website.locator('#document').evaluate(input=>input.files[0].text()),'fresh request after failure');
  // A real failure cancellation must close its own informational surface without attachment.
  await website.locator('#document').evaluate(input=>{input.value='';});
  fs.writeFileSync(file,'before cancelled preparation');
  const cancelledPreparation = upload().then(()=>null,error=>error);
  confirmation = await requestPage();fs.writeFileSync(file,'changed before preparation');
  const cancelledFailureOpened = context.waitForEvent('page');
  await confirmation.getByRole('button',{name:'Allow upload',exact:true}).click();
  const cancelledFailure = await cancelledFailureOpened;
  await cancelledFailure.getByRole('heading',{name:'Couldn’t prepare upload',exact:true}).waitFor();
  assert.match((await cancelledPreparation).message,/changed/i);
  const closedFailure = cancelledFailure.waitForEvent('close');
  await cancelledFailure.getByRole('button',{name:'Cancel request',exact:true}).click();await closedFailure;
  assert.equal(await website.locator('#document').evaluate(input=>input.files.length),0,'Cancelling a failure cannot attach files');
  const expiredWindow = await chrome.windows.create({url:`${origin}/upload-confirm.html?token=${crypto.randomUUID()}`,type:'popup'});
  const expired = windows.get(expiredWindow.id).page;
  await expired.getByRole('alert').waitFor();
  assert.equal(await expired.getByRole('button',{name:'Allow upload',exact:true}).count(),0,'Expired requests cannot offer approval');
  assert.equal(await expired.locator('.upload-files').count(),0,'Expired requests reveal no file details');
  fs.mkdirSync('reports/state-review',{recursive:true});
  for (const theme of ['light','dark']) for (const width of [500,360]) {
    await expired.emulateMedia({colorScheme:theme}); await expired.setViewportSize({width,height:560});
    assert.equal(await expired.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Upload failure fits narrow layouts');
    await expired.screenshot({path:`reports/state-review/upload-expired-${width}-${theme}.png`,fullPage:true});
  }
  await expired.close();
  console.log("Upload browser checks passed: picker interception, cancel, trusted approval, preserved file content.");
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(fixture, { recursive: true, force: true });
}
