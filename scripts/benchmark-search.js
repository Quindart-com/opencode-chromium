#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleSemanticHostMethod, rankPageUnits } from "../native-host/src/semantic-search.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "page-units-anonymized.json"), "utf8"));
const iterations = Math.max(20, Math.min(500, Number(process.argv.find((value) => value.startsWith("--iterations="))?.split("=")[1] ?? 100)));
const useModel = process.argv.includes("--adaptive-model");

function p95(values) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}

async function measure(mode) {
  const timings = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await rankPageUnits({ query: fixture.queries[index % fixture.queries.length], units: fixture.units, mode, maxResults: 12, pageFingerprint: fixture.fingerprint });
    timings.push(performance.now() - started);
  }
  return { iterations, p95Ms: Number(p95(timings).toFixed(2)), averageMs: Number((timings.reduce((sum, value) => sum + value, 0) / timings.length).toFixed(2)) };
}

const status = await handleSemanticHostMethod("semantic.status");
const fastModel = status.models.find((model) => model.role === "adaptive");
if (!useModel || !fastModel?.cache?.cached) process.env.AGENT_BROWSER_DISABLE_SEMANTIC_MODEL = "1";
const lexical = await measure("lexical");
const adaptive = await measure("auto");
const rssMb = Math.round(process.memoryUsage.rss() / 1024 / 1024);
const report = {
  lexical,
  adaptive: { ...adaptive, modelUsed: useModel && fastModel?.cache?.cached === true, degradedFixture: !useModel || fastModel?.cache?.cached !== true },
  workerRssMb: rssMb,
  limits: { lexicalP95Ms: 250, adaptiveP95Ms: 1500, workerRssMb: 400, intraOpThreads: 4, interOpThreads: 1 },
};
report.ok = lexical.p95Ms <= 250 && adaptive.p95Ms <= 1500 && rssMb <= 400;
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
