import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromiumExtensionFixture } from "./fixtures/chromium-extension.js";

// Playwright's disposable fixture must use Node: on Windows, launching it
// through Bun can stall before returning the cleanup handle. The fixture starts
// an isolated native host with no configured decision-provider credentials.
if (process.versions.bun) throw new Error("Run this benchmark with Node, not Bun");
const output = process.argv[2];
const rounds = Number(process.argv[3] ?? 2);
if (!output || !Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("Supply report path and rounds (1..10)");
const controls = ["Archive project", "Restore project", "Download report", "Print report", "Mute alerts", "Enable alerts", "Add collaborator", "Remove collaborator", "Change region", "Reset display"];
const tasks = [
  { id: "exact-archive", query: "Archive project", expected: "Archive project" },
  { id: "exact-download", query: "Download report", expected: "Download report" },
  { id: "exact-add", query: "Add collaborator", expected: "Add collaborator" },
  { id: "ambiguous-report", query: "Print report", expected: "Print report" },
  { id: "paraphrase-alert", query: "stop notifications", expected: "Mute alerts" },
  { id: "paraphrase-restore", query: "bring back the archived project", expected: "Restore project" },
];
const html = `<!doctype html><title>Fixture</title><h1>Project controls</h1>${controls.map((label, i) => `<button id="c${i}" onclick="document.querySelector('output').textContent='${i}'">${label}</button>`).join("")}<output></output>`;
const server = http.createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let fixture, agent;
const samples = [];
let calls = 0, bytes = 0;
const cpu = process.cpuUsage();
const deadline = async (label, operation, timeoutMs = 15000) => {
  let timer;
  try {
    return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]);
  } finally { clearTimeout(timer); }
};
try {
  process.stderr.write("Starting disposable browser and host\n");
  fixture = await chromiumExtensionFixture();
  const { createBrowserAgent } = await import("../src/adapters/sdk/index.ts");
  agent = createBrowserAgent();
  const sessionId = "production-benchmark", profile = fixture.profileId;
  const call = async (name, input) => {
    calls++;
    const result = await deadline(name, () => agent.call(name, { profile, sessionId, ...input }));
    bytes += Buffer.byteLength(JSON.stringify(result));
    if (!result.ok) throw new Error(`Fixture tool failed: ${name}`);
    return result;
  };
  await call("browser_session", { action: "new-tab" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await call("browser_run", { memoryMode: "off", steps: [{ action: "navigate", url: origin }] });
  const page = fixture.context.pages().find(candidate => candidate.url().startsWith(origin));
  if (!page) throw new Error("Fixture page unavailable");
  for (let round = 0; round < rounds; round++) for (const task of tasks) {
    await deadline("reset", () => page.locator("output").evaluate(element => { element.textContent = ""; }));
    const started = performance.now(), beforeCalls = calls, beforeBytes = bytes;
    const found = await call("browser_observe", { mode: "search", query: task.query, searchStrategy: "lexical" });
    const top = found.result.results[0];
    const selected = top?.label ?? null;
    let clicked = false;
    if (top?.interactive && typeof top.node_id === "string") {
      const result = await call("browser_run", { memoryMode: "off", returnMode: "all", steps: [{ action: "click", target: { nodeId: top.node_id } }] });
      clicked = result.results?.[0]?.ok === true;
    }
    const state = await deadline("verify", () => page.locator("output").textContent());
    samples.push({ round, task: task.id, expected: task.expected, selected, clicked, correct: clicked && state === String(controls.indexOf(task.expected)),
      wallMs: performance.now() - started, toolCalls: calls - beforeCalls, responseBytes: bytes - beforeBytes });
    process.stderr.write(`Completed fixture case ${samples.length}/${rounds * tasks.length}\n`);
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const report = { scope: "Disposable browser, extension, native host and SDK; local lexical search, no cloud calls or agent planning", rounds,
    accuracy: { correct: samples.filter(s => s.correct).length, total: samples.length },
    wall: { p50Ms: percentile(samples.map(s => s.wallMs), 0.5), p95Ms: percentile(samples.map(s => s.wallMs), 0.95) },
    toolCalls: calls, responseBytes: bytes, driverCpuMicros: process.cpuUsage(cpu), driverPeakRss: process.resourceUsage().maxRSS, samples };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (agent && fixture) await deadline("finalize", () => agent.call("browser_finalize", { sessionId: "production-benchmark", profile: fixture.profileId })).catch(() => {});
  agent?.close();
  await fixture?.cleanup();
  await new Promise(resolve => server.close(resolve));
}
