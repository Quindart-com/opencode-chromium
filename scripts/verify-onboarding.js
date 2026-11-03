import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { glassTextContrast } from "./fixtures/glass-contrast.js";
import { inspectArchiveArtwork } from "./fixtures/archive-artwork.js";
import { buildUpdatePage } from "./build-update-page.js";

const root = process.cwd(), extension = path.join(root, "extension");
const screenshots = path.join(root, "reports", "onboarding-review");
fs.mkdirSync(screenshots, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const state = { showReleaseNotes: true };
const locale = JSON.parse(fs.readFileSync(path.join(extension, "_locales", "en", "messages.json"), "utf8"));
const fixtureMessages = Object.fromEntries(Object.entries(locale).map(([key, value]) => [key, value.message]));
buildUpdatePage();
const server = http.createServer(async (request, response) => {
  if (request.url?.startsWith("/updates/")) {
    const pathname = request.url.split('?')[0];
    if (['/updates/theme.css','/updates/InterVariable.woff2','/updates/archive.js'].includes(pathname)) {
      response.setHeader('Content-Type',pathname.endsWith('.css')?'text/css':pathname.endsWith('.js')?'text/javascript':'font/woff2');response.end(fs.readFileSync(path.join(root,'docs',pathname.slice(1))));return;
    }
    const logo = pathname === "/updates/logo.svg";
    response.setHeader("Content-Type", logo ? "image/svg+xml" : "text/html");
    response.end(logo ? fs.readFileSync(path.join(root, "docs/updates/logo.svg")) :
      fs.readFileSync(path.join(root, "docs/updates/index.html"), "utf8").replace(/^---[\s\S]*?---\s*/, "").replace("{% include release-notes.html %}", fs.readFileSync(path.join(root, "docs/_includes/release-notes.html"), "utf8")));
    return;
  }
  if (request.url === "/preferences") {
    if (request.method === "POST") {
      let body = ""; for await (const chunk of request) body += chunk;
      Object.assign(state, JSON.parse(body));
    }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(state)); return;
  }
  const file = path.resolve(extension, "." + new URL(request.url, "http://localhost").pathname);
  if (!file.startsWith(extension + path.sep) || !fs.existsSync(file)) { response.writeHead(404).end(); return; }
  const content = fs.readFileSync(file);
  response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" }[path.extname(file)] ?? "application/octet-stream");
  response.end(path.extname(file) === ".html" ? content.toString().replace("<head>", `<head><script>globalThis.chrome={i18n:{getUILanguage:()=>"en",getMessage:(key,values)=>{let result=(${JSON.stringify(fixtureMessages)})[key]||key;for(const [index,value] of (Array.isArray(values)?values:values===undefined?[]:[values]).entries())result=result.replaceAll("$"+(index+1),value);return result}},runtime:{id:'fixture',getManifest:()=>({version:${JSON.stringify(version)}}),getURL:p=>p},action:{openPopup:async()=>{document.documentElement.dataset.panelOpened='true'}},storage:{local:{get:async()=>fetch('/preferences').then(r=>r.json()),set:async v=>fetch('/preferences',{method:'POST',body:JSON.stringify(v)})}}};</script>`) : content);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes("--serve")) {
  console.log(`Live onboarding URL: ${origin}/welcome.html`);
  process.on("SIGINT", () => { server.closeAllConnections(); server.close(); process.exit(0); });
  await new Promise(() => {});
}
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE || undefined, channel: process.env.OPENCODE_TEST_BROWSER_EXECUTABLE ? undefined : process.env.OPENCODE_TEST_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined) });
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }), page = await context.newPage();
  for (const width of [1280, 360]) for (const theme of ["light", "dark"]) for (const view of ["welcome", "updated"]) {
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto(`${origin}/welcome.html?view=${view}`); await page.getByRole("heading", { level: 1 }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (view === "welcome") {
      await page.getByRole("button", { name: "Copy command" }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "npx -y opencode-chromium@latest setup --all");
      await page.getByRole("status").filter({ hasText: "Setup command copied." }).waitFor();
    }
    await page.getByRole("button", { name: "Open extension panel" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.panelOpened), "true");
    await page.screenshot({ path: path.join(screenshots, `${view}-${width}-${theme}.png`), fullPage: true });
  }
  const preference = page.getByRole("checkbox", { name: "Show release notes after updates" });
  await preference.uncheck(); await page.getByRole("status").filter({ hasText: "Update preference saved." }).waitFor();
  await page.reload(); assert.equal(await preference.isChecked(), false);
  await page.keyboard.press("Tab");
  assert.ok(await page.evaluate(() => document.activeElement?.matches(":focus-visible")));
  const artworkReview = [];
  for (const width of [1440, 1280, 390, 360]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 }); await page.emulateMedia({ colorScheme: theme });
    await page.goto(`${origin}/updates/#v${version}`);
    await page.getByRole("heading", { name: "What’s new in your browser tools." }).waitFor();
    assert.ok(await page.locator(`article[id="v${version}"]`).isVisible());
    const older = page.locator('article[id="v2.0.2"] details');
    if(await older.count()) {
      if (await older.evaluate(element => element.open)) await older.locator('summary').click();
      await older.locator('summary').click();
      await page.waitForFunction(() => document.querySelector('article[id="v2.0.2"] summary')?.getAttribute('aria-expanded') === 'true');
      assert.equal(await older.locator('summary').getAttribute('aria-expanded'),'true');
      await older.getByText('Show fewer changes',{exact:true}).click();
      await page.waitForFunction(() => document.querySelector('article[id="v2.0.2"] summary')?.getAttribute('aria-expanded') === 'false');
      assert.equal(await older.locator('summary').getAttribute('aria-expanded'),'false');
    }
    for (const article of await page.locator("article").all()) assert.ok(await article.locator("li, p").count(), "Every release has notes or a full-notes link");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("heading", { name: "Keep your tools in step." }).waitFor();
    const setup = page.locator(".setup details");
    if (!(await setup.evaluate(element => element.open))) {
      await setup.locator("summary").click();
    }
    await page.waitForFunction(() => document.querySelector(".setup details summary")?.getAttribute("aria-expanded") === "true");
    await page.screenshot({ path: path.join(screenshots, `hosted-updates-${width}-${theme}.png`), fullPage: true });
    // Full-document captures can miscompose viewport-fixed backdrops after scrolling.
    // Preserve a real viewport capture for material review, alongside content coverage.
    await page.evaluate(() => scrollTo(0, 0));
    const artwork = await page.evaluate(inspectArchiveArtwork);
    const colors = theme === 'light' ? ['#c6acdf','#93ccd0','#d4a2d7','#e4b484'] : ['#4b4a77','#2d6b70','#6e4878','#7b5848'];
    const gradient = theme === 'light' ? ['#f6eff5','#cee8ea'] : ['#15243b','#162b3c'];
    const rgb = hex => [1,3,5].map(index=>parseInt(hex.slice(index,index+2),16));
    assert.equal(artwork.shapes.length,4,'The backdrop contains four full ellipse primitives');
    assert.deepEqual(artwork.stops,gradient.map(rgb));
    const ratios = [[.30,.40,.70,.35],[.58,.08,.24,1.10],[.82,.20,.20,1],[.88,.55,.18,.60]];
    const matrices = [[.9271838665,.3746065795,-.3746065795,.9271838665],[.9063078165,-.4226182699,.4226182699,.9063078165]];
    for (const [index,shape] of artwork.shapes.entries()) {
      const expected = ratios[index].map((ratio,axis)=>ratio*artwork.canvas[axis%2]);
      assert.ok(shape.box.every((value,axis)=>Math.abs(value-expected[axis])<.03),'Ellipse dimensions/translation match the normalized reference');
      assert.ok(shape.matrix.every((value,axis)=>Math.abs(value-matrices[index===0?0:1][axis])<.000001),'Ellipse rotation preserves the supplied CSS matrix');
      assert.deepEqual(shape.color,rgb(colors[index]));
      assert.equal(shape.origin,'0px 0px');assert.equal(shape.opacity,'1');assert.equal(shape.filter,'none');assert.equal(shape.shadow,'none');assert.equal(shape.blend,'normal');assert.equal(shape.radius,'50%');
    }
    assert.ok(artwork.samples.every(sample=>sample.maxError<=2),'Rasterized SVG gradient matches the normalized matrix across non-square canvases');
    const backdrops = [...gradient,...colors].map(color=>rgb(color).map(channel=>channel/255));
    let minimumContrast = Infinity;
    for (const label of await page.locator('main h1,main h2,.intro p,article li,summary,footer a,header a').all()) {
      if (!(await label.isVisible())) continue;
      const ratio=await label.evaluate(glassTextContrast,backdrops);minimumContrast=Math.min(minimumContrast,ratio);
      assert.ok(ratio>=4.5,`Archive text retains 4.5:1 contrast over the supplied artwork colors; got ${ratio}`);
    }
    artworkReview.push({width,theme,...artwork,minimumContrast});

    if (width === 390) {
      const header = await page.locator('header').boundingBox();
      assert.ok(header.height >= 34 && header.height <= 36, `Mobile header keeps the reference row height; got ${header.height}`);
      const title = await page.locator('.intro h1').boundingBox();
      const firstCard = await page.locator('article').first().boundingBox();
      assert.ok(title.y >= 136 && title.y <= 142, `Mobile title layout follows the reference baseline; got ${title.y}`);
      assert.ok(firstCard.y >= 343 && firstCard.y <= 351, `Mobile first card follows the reference spacing; got ${firstCard.y}`);
    }

    await page.screenshot({ path: path.join(screenshots, `hosted-updates-${width}-${theme}-viewport.png`) });
    await page.locator('main').evaluate(element=>{element.style.visibility='hidden';});
    try { await page.screenshot({path:path.join(screenshots,`archive-backdrop-${width}-${theme}.png`)}); }
    finally { await page.locator('main').evaluate(element=>{element.style.visibility='';}); }

  }
  fs.writeFileSync(path.join(screenshots,"archive-artwork-review.json"),JSON.stringify(artworkReview,null,2));
  console.log(JSON.stringify({ ok: true, states: 16, checks: ["narrow and desktop overflow", "light and dark themes", "clipboard", "panel action", "persisted update preference", "keyboard focus", "hosted version anchors and update guidance"] }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
