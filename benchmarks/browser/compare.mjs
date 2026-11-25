#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { percentile, schemaVersion, summarize } from "./report.mjs";

export function readRun(file) {
  const log = fs.statSync(file).isDirectory() ? path.join(file, "results.jsonl") : file;
  const [run, ...rows] = fs.readFileSync(log, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (run?.kind !== "run" || run.schemaVersion !== schemaVersion) throw new Error(`Unsupported report schema in ${log}`);
  return { run, rows };
}

const sideEffectCodes = new Set(["WRONG_EFFECT", "EXTRA_EFFECT", "WRONG_VALUE", "UNEXPECTED_DRAFT", "UNEXPECTED_NAVIGATION", "UNTRUSTED_INPUT", "JOURNAL_INTEGRITY"]);
const key = row => JSON.stringify([row.clients, row.client, row.round, row.task]);
const percentChange = (base, head) => base > 0 && head !== null ? (head / base - 1) * 100 : null;
const sentinelFailed = entry => entry?.status === "failed" || entry?.incorrectInput || entry?.focusLoss > 0 || entry?.unfocusedSamples > 0;

export function compare(base, head) {
  for (const field of ["schemaVersion", "harnessSha256", "seed", "suite", "rounds", "roundOffset", "matrix", "viewport", "inputMode", "deadlines", "tokenizer", "node", "platform", "release", "arch", "cpu"]) {
    if (JSON.stringify(base.run[field]) !== JSON.stringify(head.run[field])) throw new Error(`Runs differ on ${field}`);
  }
  for (const field of ["engine", "binarySha256", "headed"]) {
    if (base.run.browser[field] !== head.run.browser[field]) throw new Error(`Runs differ on browser.${field}`);
  }
  const left = base.rows.filter(row => row.kind === "attempt");
  const headAttempts = head.rows.filter(row => row.kind === "attempt");
  const right = new Map(headAttempts.map(row => [key(row), row]));
  if (!left.length || left.length !== right.size || headAttempts.length !== right.size || new Set(left.map(key)).size !== left.length) throw new Error("Runs are incomplete or differ on attempt count");
  const pairs = left.map(l => {
    const r = right.get(key(l));
    if (!r || l.fixtureHash !== r.fixtureHash || l.slot !== r.slot) throw new Error(`Runs differ on attempt ${key(l)}`);
    return [l, r];
  });
  const baseSummary = summarize(base.run, base.rows);
  const headSummary = summarize(head.run, head.rows);
  if (baseSummary.matrix.length !== headSummary.matrix.length || (base.run.matrix && base.run.matrix.length !== baseSummary.matrix.length)) throw new Error("Runs are incomplete or differ on completed waves");
  return {
    base: { commit: base.run.target.commit, adapter: base.run.adapter, observationPolicy: base.run.observationPolicy ?? "viewport" },
    head: { commit: head.run.target.commit, adapter: head.run.adapter, observationPolicy: head.run.observationPolicy ?? "viewport" },
    sameObservationPolicy: (base.run.observationPolicy ?? "viewport") === (head.run.observationPolicy ?? "viewport"),
    sameTopology: baseSummary.matrix.every((row, i) => row.topology === headSummary.matrix[i]?.topology),
    matrix: baseSummary.matrix.map((before, i) => {
      const after = headSummary.matrix[i];
      if (!after || before.clients !== after.clients) throw new Error("Runs differ on completed waves");
      const matched = pairs.filter(([l]) => l.clients === before.clients);
      const timingPairs = matched.filter(([l, r]) => Number.isFinite(l.wallMs) && Number.isFinite(r.wallMs));
      const bothVerified = timingPairs.filter(([l, r]) => l.outcome === "verified" && r.outcome === "verified");
      const regressions = matched.flatMap(([l, r]) => {
        const introduced = (r.verification?.issues ?? []).filter(code => sideEffectCodes.has(code) && !l.verification?.issues?.includes(code));
        const lost = ["verified", "guard_pass", "probe_pass"].includes(l.outcome) && l.outcome !== r.outcome;
        return lost || introduced.length ? [{ client: l.client, round: l.round, task: l.task, base: l.outcome, head: r.outcome, introduced }] : [];
      });
      const rounds = [...new Set(matched.map(([l]) => l.round))].map(round => {
        const values = timingPairs.filter(([l]) => l.round === round);
        return { round, n: values.length, medianPairedMs: percentile(values.map(([l, r]) => r.wallMs - l.wallMs), 0.5) };
      });
      const isolationRegressions = [];
      if (before.sentinel?.status === "observed" && !sentinelFailed(before.sentinel) && (after.sentinel?.status !== "observed" || sentinelFailed(after.sentinel))) isolationRegressions.push("SENTINEL");
      if (before.claimRace?.status === "passed" && after.claimRace?.status !== "passed") isolationRegressions.push("CLAIM_RACE");
      if (!before.cleanupFailures?.length && after.cleanupFailures?.length) isolationRegressions.push("CLEANUP");
      return { clients: before.clients, attempts: matched.length, verified: { base: before.verified, head: after.verified },
        latency: { base: before.latency.all, head: after.latency.all, bothVerifiedPairs: bothVerified.length,
          medianVerifiedDeltaMs: percentile(bothVerified.map(([l, r]) => r.wallMs - l.wallMs), 0.5), rounds },
        tokensPerVerified: { base: before.costs.action.tokensPerVerified, head: after.costs.action.tokensPerVerified,
          percentChange: percentChange(before.costs.action.tokensPerVerified, after.costs.action.tokensPerVerified) },
        regressions, isolationRegressions, isolation: { base: { sentinel: before.sentinel, claimRace: before.claimRace }, head: { sentinel: after.sentinel, claimRace: after.claimRace } },
      };
    }),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head, ...extra] = process.argv.slice(2);
  try {
    if (!base || !head || extra.length) throw new Error("Usage: node benchmarks/browser/compare.mjs BASE_REPORT HEAD_REPORT");
    const result = compare(readRun(base), readRun(head));
    console.log(JSON.stringify(result, null, 2));
    if (result.matrix.some(row => row.regressions.length || row.isolationRegressions.length)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
