import fs from "node:fs";
import { decisionSearch } from "../native-host/src/decisions/search.js";
import { decisionUsage } from "../native-host/src/decisions/usage.js";
import { providerStatus } from "../native-host/src/decisions/settings.js";
import { rankPageUnits } from "../native-host/src/semantic-search.js";

// Synthetic labels only. This experiment never connects to a user's browser and
// bills the configured decision provider through the ordinary pipeline, so the
// measured call count, tokens and cost are the ones a real search would incur.
const output = process.argv[2];
if (!output) throw new Error("Supply a private report output path");

// A plausible settings surface: easy exact-label targets plus paraphrase targets
// that share no vocabulary with their element.
const units = [
  { node_id: "n1", role: "button", text: "Save changes", kind: "button" },
  { node_id: "n2", role: "button", text: "Discard draft", kind: "button" },
  { node_id: "n3", role: "button", text: "Delete workspace", kind: "button" },
  { node_id: "n4", role: "button", text: "Invite teammate", kind: "button" },
  { node_id: "n5", role: "button", text: "Export data", kind: "button" },
  { node_id: "n6", role: "button", text: "Rotate API key", kind: "button" },
  { node_id: "n7", role: "link", text: "Transfer ownership", kind: "link" },
  { node_id: "n8", role: "link", text: "Change plan", kind: "link" },
  { node_id: "n9", role: "link", text: "View invoices", kind: "link" },
  { node_id: "n10", role: "link", text: "Audit log", kind: "link" },
  { node_id: "n11", role: "checkbox", text: "Dark mode", kind: "checkbox" },
  { node_id: "n12", role: "checkbox", text: "Weekly digest emails", kind: "checkbox" },
  { node_id: "n13", role: "checkbox", text: "Private activity", kind: "checkbox" },
  { node_id: "n14", role: "checkbox", text: "Two-factor authentication", kind: "checkbox" },
  { node_id: "n15", role: "combobox", text: "Retention period", kind: "select" },
  { node_id: "n16", role: "combobox", text: "Timezone", kind: "select" },
  { node_id: "n17", role: "textbox", text: "Workspace name", kind: "input" },
  { node_id: "n18", role: "textbox", text: "Billing email", kind: "input" },
  { node_id: "n19", role: "heading", text: "Billing and payments", kind: "heading" },
  { node_id: "n20", role: "heading", text: "Security", kind: "heading" },
  { node_id: "n21", role: "button", text: "Manage billing and payment method", kind: "button" },
  { node_id: "n22", role: "link", text: "Download your latest invoice", kind: "link" },
  { node_id: "n23", role: "button", text: "Cancel changes", kind: "button" },
  { node_id: "n24", role: "button", text: "Delete account permanently", kind: "button" },
  { node_id: "n25", role: "button", text: "Save and close", kind: "button" },
  { node_id: "n26", role: "checkbox", text: "Receive email notifications", kind: "checkbox" },
  { node_id: "n27", role: "link", text: "Edit profile photo", kind: "link" },
  { node_id: "n28", role: "link", text: "Notification preferences", kind: "link" },
  { node_id: "n29", role: "button", text: "Regenerate tokens", kind: "button" },
  { node_id: "n30", role: "link", text: "Members and roles", kind: "link" },
];

const tasks = [
  { query: "save changes", expected: "n1", bucket: "exact" },
  { query: "delete workspace", expected: "n3", bucket: "exact" },
  { query: "invite teammate", expected: "n4", bucket: "exact" },
  { query: "export data", expected: "n5", bucket: "exact" },
  { query: "dark mode", expected: "n11", bucket: "exact" },
  { query: "retention period", expected: "n15", bucket: "exact" },
  { query: "make the page easier on the eyes at night", expected: "n11", bucket: "paraphrase" },
  { query: "stop the emails piling up", expected: "n12", bucket: "paraphrase" },
  { query: "let someone else take over the project", expected: "n7", bucket: "paraphrase" },
  { query: "make my subscription cheaper", expected: "n8", bucket: "paraphrase" },
  { query: "keep my data for longer", expected: "n15", bucket: "paraphrase" },
  { query: "hide what I do from my teammates", expected: "n13", bucket: "paraphrase" },
];
const ROUNDS = Number(process.env.BENCHMARK_ROUNDS ?? 3);

const status = providerStatus();
if (!status.ready) throw new Error(`The decision provider is not ready: ${status.reason ?? "unknown reason"}`);

const before = decisionUsage();
const samples = [];
for (let round = 0; round < ROUNDS; round += 1) {
  for (const task of tasks) {
    const started = performance.now();
    const result = await decisionSearch({ query: task.query, units, maxResults: 5, mode: "lexical" }, (params) => rankPageUnits(params));
    samples.push({
      round,
      query: task.query,
      bucket: task.bucket,
      expected: task.expected,
      top: result?.results?.[0]?.node_id ?? null,
      correct: result?.results?.[0]?.node_id === task.expected,
      decision: result?.decision ?? null,
      wallMs: Math.round((performance.now() - started) * 10) / 10,
    });
  }
}
const after = decisionUsage();

const percentile = (values, p) => (values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null);
const byBucket = (bucket) => {
  const rows = samples.filter((sample) => sample.bucket === bucket);
  return { tasks: rows.length, correct: rows.filter((row) => row.correct).length };
};
const summary = {
  generatedAt: new Date().toISOString(),
  scope: "In-process decision pipeline over synthetic page units; no browser actions and no full-flow latency",
  rounds: ROUNDS,
  tasks: tasks.length,
  searches: samples.length,
  paidCalls: after.calls - before.calls,
  abstentions: after.abstained - before.abstained,
  inputTokens: after.inputTokens - before.inputTokens,
  outputTokens: after.outputTokens - before.outputTokens,
  costUsd: Number((after.reportedCost - before.reportedCost).toFixed(8)),
  tokensPerPaidCall: after.calls - before.calls > 0
    ? Math.round((after.inputTokens - before.inputTokens) / (after.calls - before.calls))
    : 0,
  wall: {
    p50Ms: percentile(samples.map((sample) => sample.wallMs), 0.5),
    p95Ms: percentile(samples.map((sample) => sample.wallMs), 0.95),
    maxMs: percentile(samples.map((sample) => sample.wallMs), 1),
  },
  accuracy: { exact: byBucket("exact"), paraphrase: byBucket("paraphrase"), total: { tasks: samples.length, correct: samples.filter((sample) => sample.correct).length } },
};
fs.writeFileSync(output, JSON.stringify({ summary, samples }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
