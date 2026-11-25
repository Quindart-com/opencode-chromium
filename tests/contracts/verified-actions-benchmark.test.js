import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { chooseActions, chooseNativeActions, devtoolsCandidates, nativeCandidates, planGoal, playwrightCandidates } from "../../benchmarks/browser/adapters.mjs";
import { disposableDirectory } from "../../benchmarks/browser/browser.mjs";
import { fixtureHash, schedule, viewport } from "../../benchmarks/browser/catalog.mjs";
import { compare } from "../../benchmarks/browser/compare.mjs";
import { startLedger, verify } from "../../benchmarks/browser/ledger.mjs";
import { outcome, summarize } from "../../benchmarks/browser/report.mjs";
import { createMeter, openStdio } from "../../benchmarks/browser/transport.mjs";

const config = { seed: "contract", suite: "full", round: 1, client: 0 };
const taskById = (id, extra) => schedule({ ...config, ...extra }).find(task => task.id === id);

test("seeded ordering and fixtures are reproducible and client identities differ", () => {
  const first = schedule(config);
  assert.equal(first.length, 30);
  assert.deepEqual(first.map(fixtureHash), schedule(config).map(fixtureHash));
  assert.notDeepEqual(first.map(task => task.id), schedule({ ...config, round: 2 }).map(task => task.id));
  assert.notEqual(taskById("invoice-first").goal, taskById("invoice-first", { client: 1 }).goal);
  assert.equal(taskById("invoice-500").count, 500);
  for (const task of first) assert.equal(planGoal(task.goal).entity, task.entityOf(task.index).toLowerCase());
});

test("the planner uses observed refs and abstains on missing or duplicated labels", () => {
  const task = taskById("invoice-paraphrase");
  const plan = planGoal(task.goal);
  const title = `Approve ${task.entityOf(task.index)}`;
  const view = `Invoices | local\n[2] button "Preview ${task.entityOf(task.index)}" @16,11\n[78] button "${title}" @60,12`;
  const candidates = nativeCandidates(view);
  assert.deepEqual(chooseActions(plan, candidates), [{ action: "click", target: { ref: 78 } }]);
  assert.throws(() => chooseActions(plan, candidates.slice(0, 1)), { code: "TARGET_MISSING" });
  assert.throws(() => chooseActions(plan, [...candidates, { ...candidates[1], target: { ref: 94 } }]), { code: "AMBIGUOUS_TARGET" });
  const playwright = playwrightCandidates(`- status [ref=e1]: Pending\n- button "${title}" [disabled] [ref=e2]\n- button "${title}" [ref=e3]`);
  assert.equal(playwright[0].target, "e1");
  assert.deepEqual(chooseActions(plan, playwright), [{ action: "click", target: "e3" }]);
});

test("a targeted read must show a complete, unique match before dispatch", () => {
  const plan = planGoal("Approve invoice inv-42.");
  const view = 'Invoices | local\n[78] button "Approve invoice INV-42" (outside viewport)';
  assert.deepEqual(chooseNativeActions(plan, view, null, true), [{ action: "click", target: { ref: 78 } }]);
  assert.throws(() => chooseNativeActions(plan, view + '\n… 2 more (scroll, narrow with query, or scope "page")', null, true),
    { code: "INCOMPLETE_TARGET_VIEW" });
  assert.throws(() => chooseNativeActions(plan, view + '\n[92] button "Approve invoice INV-42" @12,32', null, true),
    { code: "AMBIGUOUS_TARGET" });
});

test("Chrome DevTools candidates use snapshot UIDs and respect disabled controls", () => {
  const task = taskById("prefs-rename");
  const team = task.entityOf(task.index);
  const candidates = devtoolsCandidates([
    "## Latest page snapshot",
    'uid=3_0 RootWebArea "Preferences"',
    '  uid=3_1 textbox "Display name for ' + team + '" value="disabled"',
    '  uid=3_2 button "Save ' + team + '" disabled',
    '  uid=3_3 button "Save ' + team + '"',
    '  uid=3_4 StaticText "Save ' + team + '"',
  ].join("\n"));
  assert.deepEqual(chooseActions(planGoal(task.goal), candidates), [
    { action: "fill", target: "3_1", value: task.expected.value },
    { action: "click", target: "3_3" },
  ]);
  assert.throws(() => chooseActions(planGoal(task.goal), candidates.slice(0, 2)), { code: "TARGET_MISSING" });
});

async function openCase(ledger, task) {
  const route = ledger.register(task);
  const html = await (await fetch(route.url)).text();
  const endpoint = html.match(/"(\/event\/[a-f\d-]+)"/)[1];
  const url = new URL(endpoint, route.url);
  let seq = 0;
  async function post(type, fields) {
    const response = await fetch(url, { method: "POST", body: JSON.stringify({ type, seq: ++seq, ...fields }) });
    assert.equal(response.status, 204);
  }
  await post("ready", { ...viewport, documentHeight: 1200, ua: "fixture" });
  return { route, post, async check() { return verify(task, await route.read()); } };
}

test("the independent server rejects wrong, duplicate, and cross-tab effects", async () => {
  const ledger = await startLedger();
  try {
    const task = taskById("invoice-first");
    const other = taskById("invoice-first", { client: 1 });
    const correct = await openCase(ledger, task);
    const wrong = await openCase(ledger, task);
    const crossed = await openCase(ledger, other);
    const effect = { key: task.expected.effect, trusted: true, value: null };
    await correct.post("effect", effect);
    assert.equal((await correct.check()).ok, true);
    await correct.post("effect", effect);
    assert.deepEqual((await correct.check()).issues, ["EXTRA_EFFECT"]);
    await wrong.post("effect", { ...effect, key: `preview:${task.entityOf(task.index)}` });
    assert.deepEqual((await wrong.check()).issues, ["WRONG_EFFECT"]);
    await crossed.post("effect", { ...effect, key: other.expected.effect });
    assert.equal((await crossed.check()).ok, true);
    await crossed.post("effect", effect);
    assert.deepEqual((await crossed.check()).issues, ["WRONG_EFFECT", "EXTRA_EFFECT"]);
    assert.equal((await fetch(correct.route.url.replace("/page/", "/state/"))).status, 404);
  } finally { await ledger.close(); }
});

test("a correct saved value still fails when input touched another form", async () => {
  const ledger = await startLedger();
  try {
    const task = taskById("prefs-rename");
    const probe = await openCase(ledger, task);
    await probe.post("draft", { key: task.entityOf(task.index), value: task.expected.value });
    await probe.post("effect", { key: task.expected.effect, trusted: true, value: task.expected.value });
    assert.equal((await probe.check()).ok, true);
    await probe.post("draft", { key: task.entityOf(3), value: "Wrong field" });
    assert.ok((await probe.check()).issues.includes("UNEXPECTED_DRAFT"));
  } finally { await ledger.close(); }
});

test("failure tokens stay in the numerator and zero verified actions has no ratio", () => {
  const run = { tokenizer: "test" };
  const wave = { kind: "wave", clients: 1, actionWindowMs: 1000 };
  const one = { kind: "attempt", clients: 1, outcome: "verified", wallMs: 33, calls: [
    { method: "tools/call", phase: "dispatch", requestTokens: 20, responseTextTokens: 30 },
  ] };
  const two = { ...one, outcome: "failed", wallMs: 77, calls: [
    { method: "tools/call", phase: "lookup_fallback", requestTokens: 10, responseTextTokens: 30, code: "TIMEOUT" },
  ] };
  const [total] = summarize(run, [wave, one, two]).matrix;
  assert.equal(total.costs.action.tokensPerVerified, 90);
  assert.equal(total.costs.action.tokensPerAttempt, 45);
  assert.equal(total.costs.action.recoveryTokens, 40);
  assert.equal(total.costs.action.timeouts, 1);
  assert.equal(total.latency.all.p95Ms, 77);
  assert.equal(summarize(run, [wave, two]).matrix[0].costs.action.tokensPerVerified, null);
  assert.equal(outcome({ fault: "confirmation" }, { ok: true }, { code: "INJECTED_CONFIRMATION" }), "probe_pass");
});

test("MCP requests distinguish an approval pause from an uncertain transport timeout", async () => {
  const disposable = disposableDirectory();
  const entry = path.join(disposable.dir, "mcp-probe.mjs");
  fs.writeFileSync(entry, `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const { id, method } = JSON.parse(line);
  if (method === "wait") return;
  const structuredContent = { ok: false, status: "authorization_required", authorization: { required: true } };
  const result = { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
});
`);
  const calls = [];
  const meter = createMeter(value => value.length);
  const client = openStdio({ entry, cwd: disposable.dir, env: disposable.env, deadlineMs: 1000, meter });
  try {
    await assert.rejects(client.request(calls, "dispatch", "tools/call", { name: "probe" }, { mutating: true }), { code: "APPROVAL_REQUIRED" });
    await assert.rejects(client.request(calls, "dispatch", "wait", {}, { mutating: true }), { code: "TIMEOUT" });
    meter.measure(calls);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].execution, "not_started");
    assert.equal(calls[0].approval, "requested");
    assert.ok(calls[0].responseTextTokens > 0);
    assert.equal(calls[1].execution, "unknown");
    assert.equal(calls[1].responseWireBytes, 0);
    assert.equal(calls[1].responseTextTokens, 0);
    assert.ok(calls[1].requestTokens > 0);
  } finally {
    await client.close();
    disposable.remove();
  }
});

test("comparison matches identical fixture rows and detects new wrong effects", () => {
  const run = { target: { commit: "test" }, browser: { engine: "chromium", binarySha256: "same" }, seed: "test" };
  const wave = { kind: "wave", clients: 1, topology: "disposable", actionWindowMs: 600 };
  const attempt = { kind: "attempt", clients: 1, client: 0, round: 0, task: "invoice-first", fixtureHash: "frozen", slot: 0,
    outcome: "verified", wallMs: 100, calls: [], verification: { issues: [] } };
  const base = { run, rows: [wave, attempt] };
  const head = { run, rows: [wave, { ...attempt, outcome: "failed", wallMs: 120, verification: { issues: ["WRONG_EFFECT"] } }] };
  const matched = compare(base, head);
  assert.equal(matched.sameObservationPolicy, true);
  const diff = matched.matrix[0];
  assert.deepEqual(diff.regressions[0].introduced, ["WRONG_EFFECT"]);
  assert.equal(diff.latency.rounds[0].medianPairedMs, 20);
  const policyTrial = compare(base, { ...head, run: { ...run, observationPolicy: "targeted" } });
  assert.equal(policyTrial.sameObservationPolicy, false);
  assert.equal(policyTrial.base.observationPolicy, "viewport");
  assert.equal(policyTrial.head.observationPolicy, "targeted");
  assert.throws(() => compare(base, { ...head, run: { ...run, seed: "other" } }), /seed/);
});
