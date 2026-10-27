import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentBrowserRuntime } from "../src/core/index.ts";
import { pageSearchUnitsExpression } from "../src/browser/operations/index.ts";

// Independent synthetic fixture. Browser extraction and actions use the real
// bridge; the supplied local ranker is called directly, so no provider request
// is made and a baseline build can be compared without changing the live host.
const args = process.argv.slice(2);
const flag = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const rankerPath = flag("--ranker") ?? "native-host/src/semantic-search.ts";
const output = flag("--out");
const rounds = Number(flag("--rounds") ?? 1);
if (!output || !Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("Use --out PATH and --rounds 1..10");
const { rankPageUnits } = await import(pathToFileURL(path.resolve(rankerPath)).href);
const controls = ["Archive project", "Restore project", "Download report", "Print report", "Mute alerts", "Enable alerts", "Add collaborator", "Remove collaborator", "Change region", "Reset display"];
const tasks = [
  { id: "exact-archive", query: "Archive project", expected: "Archive project" },
  { id: "exact-download", query: "Download report", expected: "Download report" },
  { id: "exact-add", query: "Add collaborator", expected: "Add collaborator" },
  { id: "ambiguous-report", query: "Print report", expected: "Print report" },
  { id: "paraphrase-alert", query: "stop notifications", expected: "Mute alerts" },
  { id: "paraphrase-restore", query: "bring back the archived project", expected: "Restore project" },
];
const page = `<!doctype html><html><head><title>Fixture</title></head><body><h1>Project controls</h1>${controls.map((label, i) => `<button id="c${i}" onclick="document.documentElement.dataset.last='${i}'">${label}</button>`).join("")}<p>Manage project settings and reports.</p></body></html>`;
const server = http.createServer((_request, response) => { response.setHeader("Content-Type", "text/html"); response.end(page); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const runtime = createAgentBrowserRuntime();
const sessionId = `heldout-${Date.now()}`;
const samples = [];
const cpu = process.cpuUsage();
let tabId;
let toolCalls = 0, responseBytes = 0;
const invoke = async (name, input) => {
  toolCalls++;
  const result = await runtime.invoke(name, input, sessionId);
  responseBytes += Buffer.byteLength(JSON.stringify(result));
  return result;
};
const evaluate = async expression => {
  const result = await invoke("browser_cdp", { tabId, method: "Runtime.evaluate", params: { expression, returnByValue: true } });
  if (result.exceptionDetails) throw new Error("Fixture evaluation failed");
  return result.result.value;
};
try {
  const navigation = await invoke("browser_navigate", { url: `http://127.0.0.1:${server.address().port}`, waitUntil: "load" });
  tabId = navigation.tabId;
  for (let round = 0; round < rounds; round++) {
    for (const task of tasks) {
      const started = performance.now();
      const beforeCalls = toolCalls, beforeBytes = responseBytes;
      const pageUnits = await evaluate(pageSearchUnitsExpression({ maxUnits: 700, scope: "page" }));
      const rankStarted = performance.now();
      const ranking = await rankPageUnits({ query: task.query, units: pageUnits.units, mode: "lexical", maxResults: 5 });
      const rankMs = performance.now() - rankStarted;
      const top = ranking.results[0];
      const selected = top?.name ?? top?.text ?? null;
      let clicked = false;
      await evaluate("delete document.documentElement.dataset.last; true");
      if (top?.interactive && typeof top.node_id === "string") {
        try { await invoke("browser_dom_click", { tabId, nodeId: top.node_id }); clicked = true; } catch { /* Record failed actions. */ }
      }
      const state = await evaluate("document.documentElement.dataset.last ?? null");
      const correct = clicked && state === String(controls.indexOf(task.expected));
      samples.push({ round, task: task.id, expected: task.expected, selected, correct, clicked, rankMs, wallMs: performance.now() - started,
        toolCalls: toolCalls - beforeCalls, responseBytes: responseBytes - beforeBytes });
    }
  }
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  const result = { scope: "Synthetic held-out browser extraction, local lexical ranking and DOM action; no agent planning or cloud calls", rounds,
    accuracy: { correct: samples.filter(sample => sample.correct).length, total: samples.length },
    wall: { p50Ms: percentile(samples.map(s => s.wallMs), 0.5), p95Ms: percentile(samples.map(s => s.wallMs), 0.95) },
    ranking: { p50Ms: percentile(samples.map(s => s.rankMs), 0.5), p95Ms: percentile(samples.map(s => s.rankMs), 0.95) },
    toolCalls, responseBytes, cpuMicros: process.cpuUsage(cpu), peakRss: process.resourceUsage().maxRSS, samples };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (tabId !== undefined) await runtime.finalize({ sessionId }).catch(() => {});
  runtime.close?.();
  await new Promise(resolve => server.close(resolve));
}
