import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readRun } from "../browser/compare.mjs";
import { summarizeTrials } from "./agent-trials.mjs";
import { percentile } from "../browser/report.mjs";

const dir = path.resolve(process.argv[2]);
const read = (name) =>
  JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
const sum = (rows, field) => rows.reduce((a, b) => a + b[field], 0);
const rounded = (n) => Number(n.toFixed(2));
const series = {};
let baselineRun, matchKeys;
for (const policy of ["viewport", "targeted"]) {
  const s = read(policy + "/summary.json"),
    m = s.matrix[0];
  const { rows } = readRun(path.join(dir, policy));
  const attempts = rows.filter((r) => r.kind === "attempt");
  const keys = attempts
    .map((r) => JSON.stringify([r.round, r.task, r.fixtureHash]))
    .sort();
  if (baselineRun) {
    assert.deepEqual(s.run.target, baselineRun.target);
    assert.equal(s.run.harnessSha256, baselineRun.harnessSha256);
    assert.deepEqual(s.run.browser, baselineRun.browser);
    assert.deepEqual(keys, matchKeys);
  } else {
    baselineRun = s.run;
    matchKeys = keys;
  }
  assert.equal(s.run.observationPolicy, policy);
  const apps = {};
  for (const name of [...new Set(attempts.map((a) => a.app))].sort()) {
    const group = attempts.filter(
      (r) => r.app === name && !r.guard && !r.fault,
    );
    const completed = group.filter((r) => r.outcome === "verified").length;
    const calls = group.flatMap((r) => r.calls);
    apps[name] = {
      eligible: group.length,
      verified: completed,
      textTokensPerVerified: completed
        ? rounded(
            (sum(calls, "requestTokens") + sum(calls, "responseTextTokens")) /
              completed,
          )
        : null,
      p50Ms: rounded(
        percentile(
          group.map((r) => r.wallMs),
          0.5,
        ),
      ),
    };
  }
  series[policy] = {
    attempts: m.attempts,
    eligible: m.eligible,
    verified: m.verified,
    guards: m.guards,
    holdouts: m.holdouts,
    wrongEffects: m.wrongEffects,
    extraEffects: m.extraEffects,
    p50Ms: rounded(m.latency.all.p50Ms),
    p95Ms: rounded(m.latency.all.p95Ms),
    calls: m.costs.action.calls,
    callsPerVerified: rounded(m.costs.action.callsPerVerified),
    tokensPerVerified: rounded(m.costs.action.tokensPerVerified),
    schemaTokens: m.costs.session.schemaTokens,
    apps,
  };
}
const probe = read("probe/results.json"),
  agent = read("agent/results.json"),
  registry = read("registry.json");
assert(probe.complete && agent.complete);
assert.equal(probe.fixtureSha256, agent.fixtureSha256);
assert.equal(probe.seed, agent.seed);
assert.equal(probe.build.sourceSha256, baselineRun.target.build.sourceSha256);
assert.equal(agent.build.sourceSha256, baselineRun.target.build.sourceSha256);
assert.equal(agent.browserSha256, baselineRun.browser.binarySha256);
assert.equal(probe.browserSha256, agent.browserSha256);
assert.deepEqual(
  probe.rows.map((r) => r.id),
  agent.rows.map((r) => r.id),
);
const answers = agent.rows.map((r) => ({
  id: r.id,
  correct: r.correct,
  calls: r.calls.length,
  ms: rounded(sum(r.calls, "ms")),
  imageBlocks: sum(r.calls, "imageBlocks"),
  tokens: sum(r.calls, "requestTokens") + sum(r.calls, "responseTextTokens"),
}));
const numeric = probe.rows.filter(
  (r) => r.firstReadContainsExpectedNumber !== null,
);
const additional = {};
for (const [kind, file] of [["relayed", "luna/frozen-decisions.json"], ["replay", "luna/matched-replay.json"]]) {
  if (!fs.existsSync(path.join(dir, file))) continue;
  const trial = read(file);
  if (trial.build.sourceSha256 === agent.build.sourceSha256) additional[kind] = trial;
}
const summary = {
  commit: baselineRun.target.commit,
  browser: agent.browser,
  node: agent.node,
  build: agent.build.sha256,
  browserSha256: agent.browserSha256,
  harnessSha256: baselineRun.harnessSha256,
  readFixtureSha256: agent.fixtureSha256,
  seed: probe.seed,
  rounds: baselineRun.rounds,
  actionPolicies: series,
  plainRead: {
    numericTasks: numeric.length,
    numberVisible: numeric.filter((r) => r.firstReadContainsExpectedNumber)
      .length,
    missing: numeric
      .filter((r) => !r.firstReadContainsExpectedNumber)
      .map((r) => r.id),
  },
  agentTrials: summarizeTrials(agent, {
    operator: agent.operator,
    correct: answers.filter((r) => r.correct).length,
    total: answers.length,
    toolCalls: sum(answers, "calls"),
    toolTimeP50Ms: percentile(
      answers.map((r) => r.ms),
      0.5,
    ),
    toolTimeP95Ms: percentile(
      answers.map((r) => r.ms),
      0.95,
    ),
    imageBlocks: sum(answers, "imageBlocks"),
    textTokens: sum(answers, "tokens"),
    answers,
  }, additional),
  registry: {
    correct: registry.rows.filter((r) => r.correct).length,
    total: registry.rows.length,
    misses: registry.rows
      .filter((r) => !r.correct)
      .map((r) => ({
        task: r.task,
        expected: r.expected,
        request: r.observedRequest,
      })),
  },
};
fs.writeFileSync(
  path.join(dir, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
const chartGroups = [
  [
    "tokensPerVerified",
    "Text tokens per verified action",
    (n) => Math.round(n).toLocaleString("en-US"),
  ],
  ["callsPerVerified", "Tool calls per verified action", (n) => n.toFixed(2)],
  ["p50Ms", "Median task time", (n) => (n / 1000).toFixed(2) + " s"],
  ["p95Ms", "95th-percentile task time", (n) => (n / 1000).toFixed(2) + " s"],
];
const sections = chartGroups.map(([key, label, fmt]) => {
  const max = Math.max(...Object.values(series).map((row) => row[key]));
  return (
    "<section><h3>" +
    label +
    "</h3>" +
    Object.entries(series)
      .map(
        ([, v], i) =>
          '<div class="row"><span>' +
          (i ? "Targeted first" : "Viewport first") +
          '</span><div class="track"><div class="bar b' +
          i +
          '" style="width:' +
          (100 * v[key]) / max +
          '%"></div></div><b>' +
          fmt(v[key]) +
          "</b></div>",
      )
      .join("") +
    "</section>"
  );
});
const html =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Local browser baseline</title><style>*{box-sizing:border-box}body{margin:0;font:14px/1.4 var(--font-sans,system-ui);color:var(--foreground,CanvasText)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px 24px}section{min-width:0}.row{display:grid;grid-template-columns:84px 1fr 55px;align-items:center;gap:6px;font-size:12px}.row+.row{margin-top:4px}.track{height:10px;background:var(--secondary,#ddd);border-radius:3px;overflow:hidden}.bar{height:10px;border-radius:3px}.b0{background:var(--chart-1,#315fe3)}.b1{background:var(--chart-2,#058b78)}h3{margin:0 0 8px;font-size:14px}b{text-align:right;font-variant-numeric:tabular-nums}.note{margin-top:13px;font-size:12px;color:var(--muted-foreground,GrayText)}@media(max-width:520px){.grid{grid-template-columns:1fr;gap:14px}}</style><main><div class="grid">' +
  sections.join("") +
  '</div><div class="note">Six local apps · Five matched rounds · Lower is better on each scale. Task time includes navigation and independent verification.</div></main></html>';
fs.writeFileSync(path.join(dir, "comparison.html"), html);
console.log(
  JSON.stringify({
    out: dir,
    policies: Object.keys(series),
    readTrials: answers.length,
  }),
);
