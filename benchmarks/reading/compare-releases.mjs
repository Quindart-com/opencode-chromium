import fs from "node:fs";
import path from "node:path";
import { compareAgents } from "./agent-trials.mjs";
import { compare, readRun } from "../browser/compare.mjs";

const [beforeDir, afterDir, output, agentMode] = process.argv.slice(2);
if (!output) throw Error("Supply the frozen run directory, candidate run directory and chart filename.");
const policies = ["viewport", "targeted"];
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
if (agentMode) console.log(compareAgents(read(path.join(beforeDir, "summary.json")), read(path.join(afterDir, "summary.json")), agentMode));
const rows = policies.map(policy => {
  const dirs = [beforeDir, afterDir].map(dir => path.join(dir, policy));
  const runs = dirs.map(readRun);
  if (runs.some(run => run.run.observationPolicy !== policy)) throw Error("Observation policy mismatch");
  const paired = compare(...runs).matrix[0];
  if (paired.regressions.length || paired.isolationRegressions.length) throw Error("Verification or isolation regressed");
  return dirs.map(dir => read(path.join(dir, "summary.json")).matrix[0]);
});
const panels = [
  ["Text tokens per verified action", m => m.costs.action.tokensPerVerified, n => Math.round(n).toLocaleString("en-US")],
  ["95th-percentile task time", m => m.latency.all.p95Ms / 1000, n => n.toFixed(2) + " s"],
  ["Tool calls across 150 trials", m => m.costs.action.calls, String],
  ["Median task time", m => m.latency.all.p50Ms / 1000, n => n.toFixed(2) + " s"],
];
const groups = panels.map(([label, value, format], i) => {
  const x = 26 + (i % 2) * 438, y = 108 + Math.floor(i / 2) * 153;
  const max = Math.max(...rows.flat().map(value));
  const bars = rows.flatMap((series, policy) => {
    const top = 30 + policy * 50;
    const name = policy ? "Targeted" : "Viewport";
    return [`<text x="0" y="${top + 13}" class="label">${name}</text>`, ...series.map((m, release) => {
      const v = value(m), width = (206 * v / max).toFixed(2), h = top + release * 17;
      return `<rect x="78" y="${h}" width="${width}" height="11" rx="2" fill="${release ? "#166b68" : "#8692a3"}"/><text x="${86 + Number(width)}" y="${h + 10}" class="value">${format(v)}</text>`;
    })];
  });
  return `<g transform="translate(${x} ${y})"><text class="heading">${label}</text>${bars.join("")}</g>`;
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="880" height="427" viewBox="0 0 880 427" role="img" aria-labelledby="title desc">
<title id="title">Browser runtime benchmark</title><desc id="desc">Frozen baseline and development candidate for viewport-first and targeted-first reads, measured on the same six local apps.</desc>
<style>text{font:14px system-ui,sans-serif;fill:#172b36}.heading{font-weight:650;font-size:17px}.title{font-weight:680;font-size:25px}.label,.value,.sub{font-size:13px}.value{font-variant-numeric:tabular-nums}</style>
<rect width="880" height="427" fill="#ffffff"/><text x="26" y="37" class="title">Browser runtime benchmark</text>
<text x="26" y="64" class="sub">Six local apps · Five matched rounds · Lower is better on all four measures</text>
<rect x="617" y="30" width="13" height="13" rx="2" fill="#8692a3"/><text x="638" y="42">Baseline</text><rect x="723" y="30" width="13" height="13" rx="2" fill="#166b68"/><text x="746" y="42">Candidate</text>
${groups.join("")}</svg>\n`;
fs.writeFileSync(output, svg);
