import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const root = process.cwd(), extension = path.join(root, "extension");
const screenshots = path.join(root, "reports", "onboarding-review");
fs.mkdirSync(screenshots, { recursive: true });
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const state = { showReleaseNotes: true };
const server = http.createServer(async (request, response) => {
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
  response.setHeader("Content-Type", { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(file)] ?? "application/octet-stream");
  response.end(path.extname(file) === ".html" ? content.toString().replace("<head>", `<head><script>globalThis.chrome={runtime:{id:'fixture',getManifest:()=>({version:${JSON.stringify(version)}}),getURL:p=>p},action:{openPopup:async()=>{document.documentElement.dataset.panelOpened='true'}},storage:{local:{get:async()=>fetch('/preferences').then(r=>r.json()),set:async v=>fetch('/preferences',{method:'POST',body:JSON.stringify(v)})}}};</script>`) : content);
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
  console.log(JSON.stringify({ ok: true, states: 8, checks: ["narrow and desktop overflow", "light and dark themes", "clipboard", "panel action", "persisted update preference", "keyboard focus"] }));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
