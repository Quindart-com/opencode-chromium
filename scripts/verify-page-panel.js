import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromiumExtensionFixture } from "./fixtures/chromium-extension.js";
import { pagePanelUiFixture } from "./fixtures/page-panel-ui.js";
import { glassTextContrast } from "./fixtures/glass-contrast.js";

const uiFixture = process.argv.includes("--ui-fixture");
const server = http.createServer((request, response) => {
  if (request.url !== "/") {
    const file = path.resolve("extension", "." + new URL(request.url, "http://localhost").pathname);
    if (!file.startsWith(path.resolve("extension") + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml" }[path.extname(file)] ?? "application/octet-stream");
    response.end(fs.readFileSync(file)); return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><html lang="en"><title>Example workspace</title><style>
    *{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui;background:#e8e5df;color:#25302b}header{padding:28px 48px;border-bottom:1px solid #b4b7ae;background:#faf8f2}main{padding:36px 48px}.projects{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}article{min-height:220px;padding:24px;border-radius:16px;background:#d3dcce}article:nth-child(2){background:#c4d2e2}article:nth-child(3){background:#e2cbbd}button{padding:14px 20px}input{padding:12px}h1{font-size:44px}.stripe{height:140px;background:repeating-linear-gradient(90deg,#adc0d5 0 26px,#e9d3c5 26px 52px,#d0d7b6 52px 78px)}@media(prefers-color-scheme:dark){body{background:#111827;color:#eef2fa}header{background:#172033;border-color:#52617b}article{background:#1b2b30}article:nth-child(2){background:#202d42}article:nth-child(3){background:#352a30}.stripe{background:repeating-linear-gradient(90deg,#1b2b30 0 26px,#202d42 26px 52px,#352a30 52px 78px)}}</style>
    <header>EXAMPLE WORKSPACE</header><main><h1>Make room for good work.</h1><p>This local fixture contains no personal or account information.</p><p><button id="website-action">Website action</button> <input id="website-input" aria-label="Website input" value="Example text"></p><div class="projects"><article><h2>Research</h2><p>Notes and references</p></article><article><h2>Design</h2><p>Materials and components</p></article><article><h2>Build</h2><p>Release checklist</p></article></div><div class="stripe"></div><p id="website-result">Ready</p></main><script>document.querySelector('#website-action').onclick=()=>document.querySelector('#website-result').textContent='Website still works';</script></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let fixture;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  fixture = uiFixture ? await pagePanelUiFixture(origin) : await chromiumExtensionFixture();
  const panelOrigin = uiFixture ? origin : `chrome-extension://${fixture.extensionId}`;
  const page = await fixture.context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await fixture.context.newPage();
  await panel.goto(`${panelOrigin}/popup.html`);
  await page.bringToFront();
  const open = () => panel.evaluate(() => chrome.runtime.sendMessage({ type: "PAGE_PANEL_OPEN" }));
  await page.locator('#website-input').focus();
  const result = await open();
  assert.equal(result.ok, true, JSON.stringify(result));
  const host = page.locator('[id^="opencode-page-panel-"]');
  await host.waitFor();
  assert.equal(await host.count(), 1);
  assert.equal(await host.evaluate(element => element.shadowRoot), null, "page scripts cannot access the closed component tree");
  assert.equal(await page.evaluate(() => document.body.innerText.includes("Harness connections")), false, "website text extraction excludes board contents");
  const session = await fixture.context.newCDPSession(page);
  async function shadow() {
    const document = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = node => node.nodeName === "DIV" && node.attributes?.some(value => value.startsWith("opencode-page-panel-")) ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(find).find(Boolean);
    const node = find(document.root);
    assert.ok(node?.shadowRoots?.[0], "the extension owns one shadow root");
    return (await session.send("DOM.resolveNode", { backendNodeId: node.shadowRoots[0].backendNodeId })).object.objectId;
  }
  async function inspect(selector, expression = "element.textContent") {
    const objectId = await shadow();
    const response = await session.send("Runtime.callFunctionOn", { objectId, functionDeclaration: `function(selector) { const element = this.querySelector(selector); return element ? (${expression}) : null; }`, arguments: [{ value: selector }], returnByValue: true });
    return response.result.value;
  }
  async function click(selector) {
    await inspect(selector, "(element.scrollIntoView({block: 'nearest'}), true)");
    const box = await inspect(selector, "(() => { const b = element.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; })()");
    assert.ok(box, selector); await page.mouse.click(box.x, box.y);
  }
  async function setOpaque(value, explicit = false) {
    if (explicit && await inspect('input[type="checkbox"]', 'element.checked') === value) {
      await click('input[type="checkbox"]'); await page.waitForTimeout(40);
    }
    if (await inspect('input[type="checkbox"]', 'element.checked') !== value) await click('input[type="checkbox"]');
    for (let attempt=0;attempt<20;attempt++) {
      if (await inspect('.board', "element.classList.contains('opaque')") === value) return;
      await page.waitForTimeout(20);
    }
    assert.fail('Material toggle did not reach requested state');
  }
  assert.equal(await inspect('#page-tab-overview', 'element.getRootNode().activeElement === element'), true, 'Opening the board places keyboard focus on the selected tab');
  const palette = {
    light: ['#faf8f2','#e8e5df','#d3dcce','#c4d2e2','#e2cbbd','#adc0d5','#e9d3c5','#d0d7b6'],
    dark: ['#111827','#172033','#1b2b30','#202d42','#352a30']
  };
  let reviewTheme = 'light';
  async function contrast(selector) {
    const opaque = await inspect('.board', "element.classList.contains('opaque')");
    const backgrounds = opaque ? [[0,0,0],[1,1,1]] : palette[reviewTheme].map(hex => [1,3,5].map(index => parseInt(hex.slice(index,index+2),16)/255));
    const ratio = await inspect(selector, `(${glassTextContrast.toString()})(element,${JSON.stringify(backgrounds)})`);
    assert.ok(ratio >= 4.5, `${selector} needs 4.5:1 text contrast on reviewed backdrops (black/white in solid mode); got ${ratio}`);
  }
  const report = path.join(process.cwd(), "reports", "page-panel-review"); fs.mkdirSync(report, { recursive: true });
  for (const theme of ["light", "dark"]) {
    reviewTheme = theme;
    await page.emulateMedia({ colorScheme: theme });
    assert.equal((await open()).ok, true); await host.waitFor();
    await page.screenshot({ path: path.join(report, `default-overview-${theme}.png`), fullPage: true });
    await setOpaque(false, true);
    await inspect('.board-scroll', '(element.scrollTop=0,true)');
    for (const view of ["overview", "profiles", "settings"]) {
      await click(`#page-tab-${view}`);
      assert.equal(await inspect(`#page-panel-${view}`, "element.hidden"), false);
      // Catch foreground/background timing mismatches during selection, not just
      // settled screenshots. The previous 120ms transition failed these checks.
      for (const tab of ["overview", "profiles", "settings"]) await contrast(`#page-tab-${tab} .copy`);
      await page.waitForTimeout(60);
      for (const tab of ["overview", "profiles", "settings"]) await contrast(`#page-tab-${tab} .copy`);
      if (view === "profiles") await contrast("#page-panel-profiles .primary span");
      await contrast(".brand-copy p .copy");
      if (view === 'overview') {
        assert.equal(await inspect('.usage-disclosure', 'element.open'), false, 'Detailed usage starts collapsed while input/output totals remain visible');
        assert.ok(await inspect('.usage-summary', 'element.getBoundingClientRect().height') > 0);
        assert.equal(await inspect('.board-footer', 'element.getBoundingClientRect().bottom <= innerHeight'), true, 'Footer remains within the viewport');
      }
      if (uiFixture && view === 'overview') {
        assert.equal(await inspect('#page-panel-overview > section:last-child summary', 'element.getBoundingClientRect().bottom <= element.closest(".board-scroll").getBoundingClientRect().bottom'), true, 'Populated overview keeps memory status and disclosure within the desktop content viewport');
        assert.match(await inspect('.harnesses li .status-connected'), /Connected/, 'Connected review state must contain a populated connected harness');
        assert.equal(await inspect('.harnesses', 'Array.from(element.querySelectorAll(\"img\")).every(image=>image.complete&&image.naturalWidth>0&&!image.hidden)'),true,'Connected review must load all real harness logo assets');
        await page.screenshot({path:path.join(report,`connected-overview-${theme}.png`),fullPage:true});
      }
      await page.screenshot({ path: path.join(report, `${view}-${theme}.png`), fullPage: true });
      if (view === 'overview') {
        await click('.usage-disclosure > summary');
        await inspect('.usage-disclosure', '(element.scrollIntoView({block:"start"}),true)');
        await page.screenshot({path:path.join(report,`overview-usage-expanded-${theme}.png`),fullPage:true});
        await click('.usage-disclosure > summary');
        await inspect('.board-scroll', '(element.scrollTop=0,true)');
      }
    }
  }
  await click('#page-tab-overview');
  await click('.usage-disclosure > summary');
  assert.equal(await inspect('.usage-disclosure', 'element.open'), true);
  assert.equal(await inspect('.usage-filters', 'element.getBoundingClientRect().height > 0'), true);
  assert.equal(await inspect('.board-footer', 'element.getBoundingClientRect().bottom <= innerHeight'), true, 'Expanded usage keeps footer reachable');
  await page.keyboard.press('Enter');
  assert.equal(await inspect('.usage-disclosure', 'element.open'), false, 'Native usage disclosure supports keyboard collapse');
  await click('#page-tab-settings');
  const opened = fixture.context.waitForEvent("page");
  await click('.settings-list button');
  const trusted = await opened;
  await trusted.waitForURL(`${panelOrigin}/popup.html#settings`);
  assert.equal(new URL(trusted.url()).hash, "#settings");
  await trusted.getByRole("tab", { name: "Settings", exact: true }).waitFor();
  assert.equal(await trusted.getByRole("tab", { name: "Settings", exact: true }).getAttribute("aria-selected"), "true");
  await trusted.close(); await page.bringToFront();
  await click('button[aria-label="Minimize panel"]');
  assert.equal(await inspect('.board-tabs'), null);
  await click('button[aria-label="Restore panel"]');
  assert.notEqual(await inspect('.board-tabs'), null);
  await setOpaque(true);
  assert.equal(await inspect('.board', "getComputedStyle(element).backdropFilter"), "none");
  await click('#page-tab-profiles');
  await contrast('#page-panel-profiles .primary span');
  await click('#page-tab-settings');
  await setOpaque(false);
  for (const preference of [{ name: "prefers-reduced-transparency", value: "reduce" }, { name: "prefers-contrast", value: "more" }, { name: "forced-colors", value: "active" }]) {
    await session.send("Emulation.setEmulatedMedia", { features: [preference] });
    assert.equal(await inspect('.board', "getComputedStyle(element).backdropFilter"), "none", preference.name);
  }
  await session.send("Emulation.setEmulatedMedia", { features: [] });
  await page.setViewportSize({ width: 360, height: 640 });
  assert.equal((await open()).ok, true); await host.waitFor();
  await click('#page-tab-settings'); await page.waitForTimeout(100);
  assert.equal(await inspect('.board', "element.classList.contains('opaque')"), true, "narrow default suppresses competing page text");
  await contrast('#page-tab-settings .copy');
  const rect = await host.boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= 360);
  await page.screenshot({ path: path.join(report, "settings-narrow.png"), fullPage: true });
  await page.setViewportSize({ width: 1100, height: 900 });
  const dragHandle = await inspect('button[aria-label="Move panel (arrow keys)"]', "(() => { const b = element.getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; })()");
  await page.mouse.move(dragHandle.x, dragHandle.y); await page.mouse.down();
  await page.mouse.move(dragHandle.x + 650, dragHandle.y, { steps: 5 }); await page.mouse.up();
  await page.locator('#website-action').click();
  assert.equal(await page.locator('#website-result').textContent(), "Website still works");
  await page.locator('#website-input').fill("Website input still works");
  const previousId = await host.getAttribute("id");
  assert.equal((await open()).ok, true);
  await host.waitFor();
  assert.equal(await host.count(), 1);
  assert.notEqual(await host.getAttribute("id"), previousId);
  assert.equal(await inspect('#page-tab-overview', 'element.getRootNode().activeElement === element'), true, 'Reopening the board restores keyboard entry');
  const moveLabel = "Move panel (arrow keys)";
  await click(`button[aria-label="${moveLabel}"]`);
  const before = await host.boundingBox();
  await page.keyboard.press("ArrowLeft");
  const after = await host.boundingBox(); assert.ok(after.x < before.x, "keyboard movement changes the position");
  await page.keyboard.press("Escape"); await host.waitFor({ state: "detached" });
  assert.equal(await page.locator('#website-input').evaluate(element => document.activeElement === element), true, 'Closing the board restores focus to the website control');
  assert.equal((await open()).ok, true); await host.waitFor();
  await page.reload(); await host.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1100, height: 900 });
  for (const [theme, backdrop] of [['light','#000'],['dark','#fff']]) {
    await page.emulateMedia({colorScheme:theme}); reviewTheme = theme;
    await page.addStyleTag({content:`html,body,header,main,article,.stripe{background:${backdrop}!important;background-image:none!important}`});
    assert.equal((await open()).ok, true); await host.waitFor();
    await page.waitForTimeout(100);
    assert.equal(await inspect('.board', "element.classList.contains('opaque')"), true, 'unsafe backdrop defaults to solid material');
    await contrast('.brand-copy p .copy');
    await page.screenshot({path:path.join(report,`contrast-fallback-${theme}.png`),fullPage:true});
    await page.reload(); await host.waitFor({state:'detached'});
  }
  if (!uiFixture) {
    await panel.bringToFront();
    const restricted = await open(); assert.equal(restricted.error, "pagePanelUnavailable");
  }
  console.log(JSON.stringify({ ok: true, mode: uiFixture ? "packaged-renderer-fixture (not extension authorization)" : "real extension", checks: ["closed shadow and page text isolation", "three views in both themes", "text contrast including selection frames and opaque primary actions", "trusted settings handoff", "opaque/accessibility fallbacks", "narrow viewport", "website click/input passthrough", "idempotent reopen", "minimize/restore and keyboard movement/close", "navigation cleanup", ...(uiFixture ? [] : ["packaged top-frame injection", "restricted-page fallback"])] }));
} finally {
  await fixture?.cleanup();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
