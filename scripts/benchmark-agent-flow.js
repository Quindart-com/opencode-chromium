import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentBrowserRuntime, createCoreRegistry } from "../src/core/index.js";

// End-to-end measurement of the tool calls an agent actually issues, against a
// page that exercises search, exact and paraphrased targets, a click and a fill.
// The page is local; nothing here touches a real site.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] ?? path.join(root, "reports", "benchmark-agent-flow.json");

const CONTROLS = [
  ["Save changes", "button"], ["Discard draft", "button"], ["Delete workspace", "button"], ["Invite teammate", "button"],
  ["Export data", "button"], ["Rotate API key", "button"], ["Transfer ownership", "button"], ["Change plan", "button"],
  ["View invoices", "button"], ["Audit log", "button"], ["Regenerate tokens", "button"],
];
const TOGGLES = ["Dark mode", "Weekly digest emails", "Private activity", "Two-factor authentication", "Beta features"];
const SELECTS = ["Retention period", "Timezone", "Default region"];

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Workspace settings</title>
<style>body{font:14px system-ui;margin:0;padding:24px;max-width:900px}section{margin-bottom:20px}h2{font-size:15px}
label{display:block;margin:6px 0}button{margin:4px 6px 4px 0;padding:6px 10px}input,select{margin-left:8px}</style></head><body>
<header><nav><a href="#general">General</a> · <a href="#billing">Billing</a> · <a href="#security">Security</a></nav></header>
<h1>Workspace settings</h1>
<section id="general"><h2>General</h2>
<label>Workspace name <input id="workspace-name" value="Acme" aria-label="Workspace name"></label>
${TOGGLES.map((label, index) => `<label><input type="checkbox" id="toggle-${index}" aria-label="${label}"> ${label}</label>`).join("\n")}
${SELECTS.map((label, index) => `<label>${label} <select id="select-${index}" aria-label="${label}"><option>30 days</option><option>1 year</option></select></label>`).join("\n")}
</section>
<section id="billing"><h2>Billing and payments</h2>
<p>Manage billing and payment method, download your latest invoice, or change plan.</p>
</section>
<section id="actions"><h2>Actions</h2>${CONTROLS.map(([label], index) => `<button id="action-${index}">${label}</button>`).join("\n")}</section>
<section id="filler"><h2>Notes</h2><p>${"Workspace governance, retention, and audit notes. ".repeat(40)}</p></section>
</body></html>`;

function transaction(runtime, name, args) {
  return async (sessionId) => {
    const started = performance.now();
    const value = await runtime.invoke(name, args, sessionId);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return { tool: name, args, ms: Math.round((performance.now() - started) * 10) / 10, chars: text.length, value };
  };
}

const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(page);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const runtime = createAgentBrowserRuntime();
const { decisionUsage } = await import("../native-host/src/decisions/usage.js");
const before = decisionUsage();
const samples = [];
let tabId = null;
try {
  const sessionId = `flow-${Date.now()}`;
  const navigation = await transaction(runtime, "browser_navigate", { url: origin, waitUntil: "load" })(sessionId);
  tabId = navigation.value.tabId;
  samples.push({ ...navigation, args: { url: origin } });

  const chain = [
    ["browser_page_search", { tabId, query: "save changes", maxResults: 5, mode: "auto" }],
    ["browser_page_search", { tabId, query: "make the page easier on the eyes at night", maxResults: 5, mode: "auto" }],
    ["browser_locator_click", { tabId, selector: "#action-0" }],
    ["browser_page_search", { tabId, query: "delete workspace", maxResults: 5, mode: "auto" }],
    ["browser_page_search", { tabId, query: "stop the emails piling up", maxResults: 5, mode: "auto" }],
    ["browser_locator_fill", { tabId, selector: "#workspace-name", value: "New name" }],
    ["browser_page_search", { tabId, query: "retention period", maxResults: 5, mode: "auto" }],
    ["browser_page_search", { tabId, query: "keep my data for longer", maxResults: 5, mode: "auto" }],
    ["browser_locator_click", { tabId, selector: "#action-2" }],
    ["browser_page_search", { tabId, query: "invite teammate", maxResults: 5, mode: "auto" }],
  ];
  for (const [name, args] of chain) samples.push(await transaction(runtime, name, args)(sessionId));

  const searches = samples.filter((sample) => sample.tool === "browser_page_search");
  const decisions = samples.map((sample) => sample.value?.decision).filter(Boolean);
  const summary = {
    generatedAt: new Date().toISOString(),
    scope: "Local fixture page driven in-process through the real tool registry; the browser is the linked runtime's browser",
    calls: samples.length,
    searches: searches.length,
    wall: {
      totalMs: Math.round(samples.reduce((sum, sample) => sum + sample.ms, 0)),
      p50Ms: [...samples.map((sample) => sample.ms)].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
      maxMs: Math.max(...samples.map((sample) => sample.ms)),
      searchTotalMs: Math.round(searches.reduce((sum, sample) => sum + sample.ms, 0)),
      actionTotalMs: Math.round(samples.filter((sample) => sample.tool !== "browser_page_search").reduce((sum, sample) => sum + sample.ms, 0)),
    },
    responseChars: { total: samples.reduce((sum, sample) => sum + sample.chars, 0), max: Math.max(...samples.map((sample) => sample.chars)) },
    paidCalls: decisionUsage().calls - before.calls,
    decisions: decisions.map((decision) => `${decision.origin ?? "?"}:${decision.status}${decision.reason ? `/${decision.reason}` : ""}`),
    samples: samples.map(({ value, ...rest }) => ({ ...rest, matched: value?.results?.[0]?.text ?? value?.target?.text ?? null })),
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ summary, samples }, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (tabId !== null) await runtime.invoke("browser_close_tab", { tabId }, "flow-cleanup").catch(() => {});
  runtime.close?.();
  await new Promise((resolve) => server.close(resolve));
}
