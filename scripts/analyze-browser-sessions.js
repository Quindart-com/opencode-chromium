#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BROWSER_TOOLS = new Set(["browser_run", "browser_observe", "browser_session", "browser_finalize"]);

function walk(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  return files;
}

function resolveInput(input) {
  const explicit = path.resolve(input);
  if (fs.existsSync(explicit)) return explicit;
  const matches = walk(path.join(os.homedir(), ".codex", "sessions")).filter((file) => path.basename(file).includes(input));
  if (matches.length !== 1) throw new Error(matches.length ? `Session ID is ambiguous: ${input}` : `Session was not found: ${input}`);
  return matches[0];
}

function durationMs(duration = {}) {
  return Number(duration.secs ?? 0) * 1000 + Number(duration.nanos ?? 0) / 1e6;
}

function structuredResult(result) {
  return result?.Ok?.structuredContent ?? result?.structuredContent ?? result?.Err ?? null;
}

function failureClass(result) {
  const value = structuredResult(result);
  const text = JSON.stringify(value ?? result ?? "").toLocaleLowerCase();
  if (/unsupported key|key chord|escape|ctrl\+a/.test(text)) return "key-input";
  if (text.includes("semantic") && text.includes("timeout")) return "semantic-timeout";
  if (text.includes("cdp") && text.includes("timeout")) return "cdp-timeout";
  if (text.includes("timeout")) return "timeout";
  if (/input verification|select-all verification|fill verification/.test(text)) return "editor-verification";
  if (text.includes("clipboard")) return "clipboard-input";
  if (text.includes("covered") || text.includes("clickable")) return "covered-target";
  if (text.includes("stale") || text.includes("detached") || text.includes("unknown node")) return "stale-target";
  if (text.includes("requires") || text.includes("invalid") || text.includes("too_big") || text.includes("too big")) return "validation";
  if (text.includes("partial")) return "partial";
  return "browser-error";
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function increment(record, key, amount = 1) {
  record[key] = (record[key] ?? 0) + amount;
}

function analyze(file) {
  const report = {
    file,
    sessionId: null,
    toolCounts: {},
    browserCalls: 0,
    wrapperWaits: 0,
    chains: { count: 0, actionSteps: 0, fixedDelaySteps: 0, sizes: {} },
    failures: {},
    latencyMs: {},
    searchStrategy: {},
    cacheHits: { query: 0, documents: 0 },
    modelUsage: {},
  };
  const latency = new Map();
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "session_meta") report.sessionId = event.payload?.session_id ?? event.payload?.id ?? report.sessionId;
    if (event.type === "response_item" && ["custom_tool_call", "function_call"].includes(event.payload?.type) && event.payload?.name === "wait") report.wrapperWaits += 1;
    if (event.type !== "event_msg" || event.payload?.type !== "mcp_tool_call_end") continue;
    const invocation = event.payload.invocation ?? {};
    const tool = invocation.tool;
    increment(report.toolCounts, tool ?? "unknown");
    const ms = durationMs(event.payload.duration);
    if (!latency.has(tool)) latency.set(tool, []);
    latency.get(tool).push(ms);
    if (!BROWSER_TOOLS.has(tool)) continue;
    report.browserCalls += 1;
    const args = invocation.arguments ?? {};
    const phase = tool === "browser_observe" ? `${tool}:${args.mode ?? "unknown"}` : tool === "browser_run" ? `${tool}:chain` : null;
    if (phase) {
      if (!latency.has(phase)) latency.set(phase, []);
      latency.get(phase).push(ms);
    }
    if (tool === "browser_run") {
      const size = Array.isArray(args.steps) ? args.steps.length : 0;
      report.chains.count += 1;
      report.chains.actionSteps += size;
      increment(report.chains.sizes, String(size));
      report.chains.fixedDelaySteps += (args.steps ?? []).filter((step) => step?.action === "wait").length;
    }
    if (tool === "browser_observe" && args.mode === "search") increment(report.searchStrategy, args.searchStrategy ?? args.modeStrategy ?? "legacy-default");
    const result = structuredResult(event.payload.result);
    const failed = event.payload.result?.Ok?.isError === true || result?.ok === false || result?.status === "partial" || result?.status === "error";
    if (failed) increment(report.failures, failureClass(event.payload.result));
    const candidate = result?.result ?? result?.observation ?? result;
    const model = candidate?.model ?? candidate?.result?.model;
    if (model?.used) increment(report.modelUsage, model.id ?? "unknown");
    const cache = candidate?.cache ?? candidate?.result?.cache;
    if (cache?.queryHit) report.cacheHits.query += 1;
    if (Number.isFinite(cache?.documentHits)) report.cacheHits.documents += cache.documentHits;
  }
  for (const [tool, values] of latency) {
    report.latencyMs[tool] = {
      count: values.length,
      total: Math.round(values.reduce((sum, value) => sum + value, 0)),
      average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      p95: Math.round(percentile(values, 0.95)),
    };
  }
  report.chains.averageSize = report.chains.count ? Number((report.chains.actionSteps / report.chains.count).toFixed(2)) : 0;
  return report;
}

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("Usage: node scripts/analyze-browser-sessions.js <session-uuid-or-jsonl> [...]");
  process.exit(2);
}

const reports = inputs.map((input) => analyze(resolveInput(input)));
const total = reports.reduce((aggregate, report) => {
  aggregate.browserCalls += report.browserCalls;
  aggregate.wrapperWaits += report.wrapperWaits;
  aggregate.fixedDelaySteps += report.chains.fixedDelaySteps;
  for (const [key, value] of Object.entries(report.toolCounts)) increment(aggregate.toolCounts, key, value);
  for (const [key, value] of Object.entries(report.failures)) increment(aggregate.failures, key, value);
  return aggregate;
}, { browserCalls: 0, wrapperWaits: 0, fixedDelaySteps: 0, toolCounts: {}, failures: {} });

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), privacy: "Aggregates only; page text is not retained.", reports, total }, null, 2));
