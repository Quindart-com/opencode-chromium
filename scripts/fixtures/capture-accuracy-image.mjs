import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { BROWSERS,browserIds,executableCandidates } from "../../dist/cli/browsers.js";

// Screenshot only: installed browser, fresh headless profile, fixed synthetic
// fixture. stdout stays inside the parent process; no account/provider access.
const directory = path.dirname(fileURLToPath(import.meta.url));
const candidates = process.env.BENCHMARK_BROWSER_BIN ? [process.env.BENCHMARK_BROWSER_BIN] :
  browserIds().filter(id => BROWSERS[id].engine !== "gecko").flatMap(executableCandidates);
const executablePath = candidates.find(candidate => candidate && fs.existsSync(candidate));
const fixtureFile = path.join(directory, "accuracy-settings.json");
const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/fixture.json" ? "application/json" : "text/html; charset=utf-8");
  response.end(fs.readFileSync(request.url === "/fixture.json" ? fixtureFile : path.join(directory, "accuracy-settings.html")));
});
let browser;
try {
  if (!executablePath) throw new Error("No installed Chromium browser");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ executablePath, headless: true, timeout: 15000,
    args: ["--disable-extensions", "--disable-background-networking"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "load", timeout: 10000 });
  await page.waitForSelector("html[data-ready=true]", { timeout: 10000 });
  const boxes = {};
  for (const unit of fixture.units) {
    const box = await page.locator(`[data-node-id="${unit.node_id}"]`).boundingBox();
    if (!box || box.x < 0 || box.y < 0 || box.y + box.height > 1100) throw new Error("Control outside screenshot");
    boxes[unit.node_id] = Object.fromEntries(Object.entries(box).map(([key, number]) => [key, Math.round(number * 1000) / 1000]));
  }
  const bytes = await page.screenshot({ type: "jpeg", quality: 70 });
  const image = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  if (image.length > 400000) throw new Error("Screenshot exceeds existing decision budget");
  process.stdout.write(JSON.stringify({ image, boxes, version: browser.version().match(/\d+(?:\.\d+){1,3}/)?.[0] ?? "unknown" }));
} catch {
  process.stderr.write("Synthetic fixture screenshot failed.\n");
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
