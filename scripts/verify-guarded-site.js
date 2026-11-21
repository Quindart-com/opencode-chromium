// Verifies how much of the automation footprint a guarded site can see.
//
// It serves tests/fixtures/guarded-site/index.html (console getter, untrusted
// click and window-size detectors), drives it through the real dev extension and
// native host once per input route, and prints which detectors fired:
//
//   dom      in-page element.click() inside Runtime.evaluate
//   pointer  trusted CDP mouse path + press/release, no Runtime.enable, agent world
//
// Run manually with a real browser (Chromium or Chrome for Testing):
//   bun run build            # build the extension into ./extension
//   bun scripts/verify-guarded-site.js
//   bun scripts/verify-guarded-site.js --serve-only   # just serve the fixture on a port
//   bun scripts/verify-guarded-site.js --redirect     # also test the ?redirect=1 about:blank behavior
//
// The fixture, native host and profile are disposable (see scripts/fixtures/chromium-extension.js).
// Exit code is 1 when the pointer route trips any detector other than window-size.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "tests", "fixtures", "guarded-site", "index.html"), "utf8");
const server = http.createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(html); });
await new Promise(resolve => server.listen(process.argv.includes("--serve-only") ? Number(process.env.PORT ?? 0) : 0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

if (process.argv.includes("--serve-only")) {
  console.log(`Guarded-site fixture: ${origin}/  (add ?redirect=1 to blank the tab on detection)`);
  await new Promise(() => {});
}

const { chromiumExtensionFixture } = await import("./fixtures/chromium-extension.js");
const { createBrowserAgent } = await import("../src/adapters/sdk/index.ts");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixture, agent;
const report = {};
try {
  fixture = await chromiumExtensionFixture({ headless: false });
  agent = createBrowserAgent();
  const sessionId = "guarded-site-fixture", profile = fixture.profileId;
  const call = async (name, args) => {
    let result = await agent.call(name, { profile, sessionId, ...args });
    if (result.status === "approval_required") result = await agent.call(name, { sessionId, approvalToken: result.approvalToken });
    return result;
  };
  // Each route runs in its own tab, tagged by query so detections never leak between routes.
  const detections = async route => {
    const page = fixture.context.pages().find(item => item.url().startsWith(origin) && new URL(item.url()).searchParams.get("route") === route);
    return page ? await page.evaluate(() => window.__detections?.map(item => item.name) ?? []).catch(() => ["(page unreadable)"]) : ["(tab gone)"];
  };
  const routes = ["dom", "pointer"];
  for (const inputMode of routes) {
    const suffix = `?route=${inputMode}${process.argv.includes("--redirect") ? "&redirect=1" : ""}`;
    await call("browser_session", { action: "new-tab" });
    await call("browser_run", { memoryMode: "off", steps: [{ action: "navigate", url: `${origin}/${suffix}` }] });
    await sleep(1200); // let the periodic detectors run once before any action
    const baseline = await detections(inputMode);
    const result = await call("browser_run", { memoryMode: "off", returnMode: "all", inputMode, cursor: false, steps: [
      { action: "click", target: { selector: "#edit" }, inputMode },
      { action: "fill", target: { selector: "#name" }, value: "Ayman", inputMode },
    ] });
    await sleep(1500);
    const steps = result.results ?? [];
    report[inputMode] = {
      before: baseline,
      after: await detections(inputMode),
      inputRoute: steps[0]?.result?.inputRoute ?? null,
      tabTransition: steps.map(step => step.tabTransition?.kind ?? null),
      warnings: (result.warnings ?? []).map(warning => warning.code),
      ok: result.ok,
    };
  }
  await call("browser_finalize", {});
  console.log(JSON.stringify(report, null, 2));
  const unexpected = (report.pointer?.after ?? []).filter(name => name !== "window-size" && !report.pointer.before.includes(name));
  if (unexpected.length) { console.error("Pointer route tripped:", unexpected.join(", ")); process.exitCode = 1; }
} finally {
  agent?.close();
  await fixture?.cleanup();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
