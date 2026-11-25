#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compare, readRun } from "./compare.mjs";
import { percentile, summarize } from "./report.mjs";

const usage = "node benchmarks/browser/repeat.mjs --base PROJECT --head PROJECT --out NEW_DIRECTORY [--trials N] -- [runner options]";
const entry = fileURLToPath(new URL("./run.mjs", import.meta.url));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const runOnlyOptions = new Set(["--project", "--revision", "--out", "--rounds", "--round-offset", "--help"]);

function configuration(argv) {
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const runner = separator === -1 ? [] : argv.slice(separator + 1);
  const { values } = parseArgs({ args: options, options: {
    base: { type: "string" }, head: { type: "string" }, out: { type: "string" },
    trials: { type: "string", default: "5" }, help: { type: "boolean" },
  } });
  if (values.help) return null;
  const trials = Number(values.trials);
  if (!values.base || !values.head || !values.out) throw new Error(usage);
  if (!Number.isInteger(trials) || trials < 1 || trials > 30) throw new Error("--trials must be an integer in 1..30");
  const conflict = runner.find(arg => runOnlyOptions.has(arg.split("=")[0]));
  if (conflict) throw new Error(`Repeated runs manage ${conflict.split("=")[0]}`);
  return { projects: { base: fs.realpathSync(values.base), head: fs.realpathSync(values.head) },
    out: path.resolve(values.out), trials, runner };
}

function measure(project, out, round, runner) {
  const child = spawnSync(process.execPath, [entry, ...runner, "--project", project, "--out", out,
    "--rounds", "1", "--round-offset", String(round)], { stdio: "inherit", windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0 && child.status !== 1) throw new Error(`Runner stopped in ${out} (${child.signal ?? child.status})`);
  const report = readRun(out);
  if (report.run.target.runtimeDirty) throw new Error(`Runtime sources changed in ${project}`);
  return { report, status: child.status, summary: summarize(report.run, report.rows) };
}

function summarizePairs(pairs) {
  return pairs[0].comparison.matrix.map(({ clients }, index) => {
    const side = name => {
      const rows = pairs.map(pair => pair[name][index]);
      const verified = rows.reduce((sum, row) => sum + row.verified, 0);
      const measured = rows.every(row => row.tokens !== null);
      const totalTokens = rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
      const p95ByTrialMs = rows.map(row => row.p95Ms);
      return { verified, eligible: rows.reduce((sum, row) => sum + row.eligible, 0),
        tokensPerVerified: measured && verified ? totalTokens / verified : null,
        p95ByTrialMs, medianTrialP95Ms: percentile(p95ByTrialMs.filter(Number.isFinite), 0.5) };
    };
    return { clients, base: side("base"), head: side("head") };
  });
}

try {
  const config = configuration(process.argv.slice(2));
  if (!config) console.log(usage);
  else {
    fs.mkdirSync(path.dirname(config.out), { recursive: true });
    fs.mkdirSync(config.out);
    const index = { trialsPlanned: config.trials, pairs: [], metrics: [] };
    const builds = new Map();
    for (let round = 0; round < config.trials; round++) {
      const folder = path.join(config.out, `trial-${String(round + 1).padStart(2, "0")}`);
      const order = round % 2 === 0 ? ["base", "head"] : ["head", "base"];
      const arms = {};
      for (const name of order) {
        const data = measure(config.projects[name], path.join(folder, name), round, config.runner);
        const { build, ...target } = data.report.run.target;
        const fingerprint = JSON.stringify({ ...target, source: build?.sourceSha256 });
        if (builds.has(name) && builds.get(name) !== fingerprint) throw new Error(`Build changed across trials for ${name}`);
        builds.set(name, fingerprint);
        arms[name] = data;
      }
      const comparison = compare(arms.base.report, arms.head.report);
      const armMetrics = name => arms[name].summary.matrix.map(row => ({ eligible: row.eligible,
        verified: row.verified, tokens: row.costs.action.tokens, p95Ms: row.latency.all.p95Ms }));
      const rejected = arms.head.status !== 0 || comparison.matrix.some(row => row.regressions.length || row.isolationRegressions.length);
      index.pairs.push({ round, order, base: armMetrics("base"), head: armMetrics("head"),
        baselineExitCode: arms.base.status, candidateExitCode: arms.head.status, rejected, comparison });
      index.metrics = summarizePairs(index.pairs);
      write(path.join(config.out, "comparison.json"), index);
    }
    console.log(JSON.stringify({ output: config.out, metrics: index.metrics }));
    if (index.pairs.some(pair => pair.rejected)) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 2; }
