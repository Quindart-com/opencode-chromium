import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { popupPalette } from "../extension-src/entrypoints/popup/page-palette.ts";
import { chromium } from "playwright";

// A separate browser profile: never attaches to an installed/user browser.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-popup-verification-"));
const source = path.resolve("extension");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
assert.equal(manifest.action.default_popup, "popup.html");
assert.equal(fs.existsSync(path.join(source, "page-panel.js")), false);
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><title>Popup color fixture</title><style>body{background:${request.url === "/dark" ? "rgb(15, 15, 15)" : request.url === "/green" ? "rgb(10, 60, 10)" : "rgb(120, 220, 180)"}}</style><h1>Unmodified webpage</h1>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let context;
try {
  context = await chromium.launchPersistentContext(directory, {
    headless: true, channel: "chromium",
    args: ["--enable-unsafe-extension-debugging", `--disable-extensions-except=${source}`, `--load-extension=${source}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  assert.equal(await worker.evaluate(() => chrome.action.onClicked.hasListeners()), false, "No injected-panel toolbar handler");
  await worker.evaluate(() => new Promise((resolve, reject) => {
    let attempts = 0;
    const check = async () => {
      if ((await chrome.storage.local.get('guideVersion')).guideVersion === chrome.runtime.getManifest().version) resolve();
      else if (++attempts > 100) reject(Error('Install guide did not finish'));
      else setTimeout(check, 50);
    };
    void check();
  }));
  const cdp = await context.browser().newBrowserCDPSession();
  const page = await context.newPage();
  for (const theme of ["light", "dark", "green", "fallback"]) {
    await page.goto(theme === "fallback" ? "chrome://version/" : `http://127.0.0.1:${server.address().port}/${theme}`);
    await page.bringToFront();
    const before = await page.content();
    const tabsBefore = await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id)));
    const { targetInfos: beforeTargets } = await cdp.send('Target.getTargets', { filter: [{}] });
    const pageTarget = beforeTargets.find(target => target.type === 'tab' && target.url === page.url());
    await cdp.send('Extensions.triggerAction', { id: new URL(worker.url()).host, targetId: pageTarget.targetId });
    const contexts = await worker.evaluate(() => new Promise((resolve, reject) => {
      let attempts = 0;
      const check = async () => {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ["POPUP"] });
        if (contexts.length) resolve(contexts);
        else if (++attempts > 100) reject(Error('Native popup did not open'));
        else setTimeout(check, 50);
      };
      void check();
    }));
    assert.equal(contexts.length, 1, "Exactly one native extension popup");
    let target;
    for (let attempt = 0; attempt < 100 && !target; attempt++) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      target = targetInfos.find(target => target.url === contexts[0].documentUrl);
      if (!target) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(target, "Native popup has a browser target");
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    let sequence = 0;
    const evaluate = expression => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(Error('Popup evaluation timeout')); }, 10000);
      function receive(event) {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive);
        if (message.error || message.result.exceptionDetails) reject(Error(JSON.stringify(message)));
        else resolve(message.result.result.value);
      }
      cdp.on('Target.receivedMessageFromTarget', receive);
      cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) }).catch(reject);
    });
    const rendered = await evaluate(`new Promise((resolve,reject)=>{let tries=0;const check=()=>{if(document.documentElement.dataset.popupTheme || (${JSON.stringify(theme)} === 'fallback' && document.querySelector('main')))resolve(document.documentElement.dataset.popupTheme || 'fallback');else if(++tries>100)reject('Tint not applied');else setTimeout(check,50)};check()})`);
    assert.equal(rendered, theme === 'green' ? 'dark' : theme);
    if (theme !== 'fallback') {
      const colors = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor]);
      const expected = popupPalette(colors).background.match(/\d+/g).map(Number);
      const actual = await evaluate(`getComputedStyle(document.body).backgroundColor.match(/\\d+/g).slice(0,3).map(Number)`);
      assert.deepEqual(actual, expected, 'The actual page colors must reach the rendered popup canvas');
      const card = await evaluate(`getComputedStyle(document.querySelector('.decision-overview')).backgroundColor`);
      assert.equal(card, theme === 'light' ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.035)', 'Glass cards must not cover the page colors with a fixed blue fill');
    }
    assert.equal(await evaluate(`document.querySelectorAll('.page-panel-launch').length`), 0);
    await evaluate(`document.getElementById('tab-settings').click(); true`);
    await evaluate(`document.getElementById('tab-overview').click(); true`);
    assert.equal(await page.content(), before, "Opening the popup must not modify webpage DOM");
    assert.deepEqual(await worker.evaluate(() => chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))), tabsBefore, "Toolbar popup creates no browser tab");
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
    await worker.evaluate(() => new Promise((resolve,reject)=>{let attempts=0;const check=async()=>{if(!(await chrome.runtime.getContexts({contextTypes:["POPUP"]})).length)resolve();else if(++attempts>100)reject(Error('Popup did not close'));else setTimeout(check,50)};void check()}));
  }
  console.log("Native toolbar popup verified: light/dark CSS tint, restricted-page fallback, navigation, no injected DOM, no new tabs.");
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
