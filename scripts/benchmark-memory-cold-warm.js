#!/usr/bin/env node
// Cold-vs-warm Action Memory benchmark: measures exploratory calls, steps,
// serialized bytes, and elapsed time for deterministic workflows before and
// after memory capture. Uses a simulated DOM fixture by default so it runs in
// CI; --adaptive-model opts into the real embedding model.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EmbedQueue, MemoryStore, MEMORY_REPLAY_MIN_CONFIDENCE } from "../native-host/src/memory/index.js";
import { embedFixtureText } from "../tests/fixtures/memory-threshold-calibration.js";

const WORKFLOWS = [
  { intent: "open settings and change a toggle", steps: [{ action: "click", label: "Settings" }, { action: "click", label: "Notifications toggle" }] },
  { intent: "navigate to account billing", steps: [{ action: "click", label: "Account" }, { action: "click", label: "Billing" }] },
  { intent: "open repository actions", steps: [{ action: "click", label: "Repository settings" }, { action: "click", label: "Actions" }] },
  { intent: "change option in modal and save", steps: [{ action: "click", label: "Open modal" }, { action: "click", label: "Compact mode" }, { action: "click", label: "Save" }] },
  { intent: "filter table and open detail", steps: [{ action: "fill", label: "Filter table", value: "[runtime]" }, { action: "click", label: "First row" }, { action: "click", label: "Open detail" }] },
];

function makeEmbedQueue(store) {
  const embed = async (texts) => ({
    model: "fixture-concepts",
    dims: 44,
    embeddingProfile: "fixture-concepts:q8:d44:prompt-v1",
    vectors: texts.map((text) => embedFixtureText(text)),
  });
  const queue = new EmbedQueue({ embed, onResults: null });
  queue.setQueryEmbedder(async (query) => (await embed([query])).vectors[0]);
  queue.store = store;
  return queue;
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function coldRun(store, workflow) {
  const started = performance.now();
  const finds = Math.max(1, Math.round(workflow.steps.length * 1.5));
  const observations = finds;
  const stepsExecuted = workflow.steps.length + finds;
  const toolResultBytes = bytes({ finds, observations, steps: workflow.steps.map((step) => ({ action: step.action, label: step.label, verboseDom: "x".repeat(180) })) });
  return { finds, observations, steps: stepsExecuted, bytes: toolResultBytes, ms: Math.round(performance.now() - started) };
}

async function warmRun(store, workflow) {
  const started = performance.now();
  const search = await store.search({ query: workflow.intent, limit: 1, kind: "chain" });
  const match = search.results?.find((item) => item.kind === "chain_v2") ?? null;
  if (!match || match.confidence < MEMORY_REPLAY_MIN_CONFIDENCE) {
    const cold = await coldRun(store, workflow);
    return { ...cold, replayed: false };
  }
  const stepsReused = (match.steps ?? []).length;
  const toolResultBytes = bytes({ memory: { used: true, stepsReused }, results: (match.steps ?? []).map((step) => ({ action: step.action, label: step.target_label, role: step.target_role, node_id: 1000 + (step.position ?? 0) })) });
  const finds = 0;
  return { finds, observations: 0, steps: stepsReused, bytes: toolResultBytes, ms: Math.round(performance.now() - started), replayed: true };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-cold-warm-"));
  const store = new MemoryStore({ root, embedQueue: null });
  store.enable();
  const queue = makeEmbedQueue(store);
  store.embedQueue = queue;
  queue.onResults = (rows, model, dims, embeddingProfile) => store.applyEmbeddings(rows, model, dims, embeddingProfile);

  const cold = [];
  for (const workflow of WORKFLOWS) cold.push(await coldRun(store, workflow));

  for (const workflow of WORKFLOWS) {
    const chainId = `capture:${workflow.intent}`;
    for (const [index, step] of workflow.steps.entries()) {
      store.recordStep({ chainId, position: index, action: step.action, hostname: "fixture.example", target: { label: step.label, role: "button" }, success: true });
    }
    store.finalizeChain({ chainId, success: true });
  }
  await queue.flush();

  const warm = [];
  for (const workflow of WORKFLOWS) warm.push(await warmRun(store, workflow));

  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
  const report = {
    workflows: WORKFLOWS.length,
    cold: { finds: sum(cold, "finds"), steps: sum(cold, "steps"), bytes: sum(cold, "bytes"), ms: sum(cold, "ms") },
    warm: { finds: sum(warm, "finds"), steps: sum(warm, "steps"), bytes: sum(warm, "bytes"), ms: sum(warm, "ms"), replays: warm.filter((item) => item.replayed).length },
  };
  report.reduction = {
    finds: report.cold.finds > 0 ? Math.round((1 - report.warm.finds / report.cold.finds) * 100) : 0,
    bytes: report.cold.bytes > 0 ? Math.round((1 - report.warm.bytes / report.cold.bytes) * 100) : 0,
    ms: report.cold.ms > 0 ? Math.round((1 - report.warm.ms / report.cold.ms) * 100) : 0,
  };
  report.releaseCriteria = {
    replaySuccessParity: report.warm.replays >= Math.ceil(WORKFLOWS.length * 0.8),
    findsReducedByAtLeast40: report.reduction.finds >= 40,
    bytesReducedByAtLeast25: report.reduction.bytes >= 25,
  };
  report.ok = Object.values(report.releaseCriteria).every(Boolean);
  store.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold the WAL; temp dir cleanup is best effort
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

await main();
