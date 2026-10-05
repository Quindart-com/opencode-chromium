import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The provider directory is redirected before the decision modules read it, so
// these tests never touch a real credential and never make a network call.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "decision-budget-"));
process.env.AGENT_BROWSER_PROVIDER_DIR = fixture;

const { DecisionBudget, decisionFingerprint, describeCandidate, rankingIsDecisive } = await import("../../native-host/src/decisions/budget.ts");
const { decisionSearch } = await import("../../native-host/src/decisions/search.ts");

const result = (node_id, score, extra = {}) => ({ node_id, score, name: null, text: null, ...extra });

test("a decision is skipped when the local ranking already separates one target", () => {
  assert.deepEqual(rankingIsDecisive("anything", [result("a", 1)]), { decisive: true, reason: "single_candidate" });
  assert.deepEqual(rankingIsDecisive("save changes", [result("a", 1, { text: "Save changes" }), result("b", 0.2, { text: "Cancel" })]),
    { decisive: true, reason: "unique_exact_match" });
  assert.equal(rankingIsDecisive("save", [result("a", 1, { text: "Save" }), result("b", 1, { text: "Save draft" })]).decisive, false,
    "two equally valid phrase matches stay ambiguous");
});

test("a wide margin only counts when the local pipeline actually embedded the query", () => {
  const ranked = [result("a", 0.9), result("b", 0.2)];
  assert.equal(rankingIsDecisive("make it easier at night", ranked).decisive, false,
    "raw lexical scores are not a confidence signal");
  assert.deepEqual(rankingIsDecisive("make it easier at night", ranked, { modelUsed: true }), { decisive: true, reason: "score_margin" });
  assert.equal(rankingIsDecisive("make it easier at night", [result("a", 0.3), result("b", 0.25)], { modelUsed: true }).decisive, false);
});

test("decision fingerprints are stable, order sensitive, and bounded", () => {
  const candidates = [{ id: "a", description: "button | Save" }, { id: "b", description: "link | Cancel" }];
  assert.equal(decisionFingerprint("q", "page", candidates), decisionFingerprint("q", "page", candidates));
  assert.notEqual(decisionFingerprint("q", "page", candidates), decisionFingerprint("q2", "page", candidates));
  assert.notEqual(decisionFingerprint("q", "page", candidates), decisionFingerprint("q", "other", candidates));
  assert.notEqual(decisionFingerprint("q", "page", candidates), decisionFingerprint("q", "page", [...candidates].reverse()));
  assert.match(decisionFingerprint("q", "page", candidates), /^[0-9a-f]{40}$/);
});

test("candidate descriptions are deduplicated and bounded", () => {
  assert.equal(describeCandidate(["button", "button", "Save changes"]), "button | Save changes");
  assert.equal(describeCandidate([null, undefined, "  ", "Save"]), "Save");
  const long = describeCandidate(["x".repeat(200), "y".repeat(200), "z".repeat(200), "w".repeat(200), "v".repeat(200)]);
  assert.equal(long.length, 160);
  assert.equal(long.split(" | ").length, 4, "at most four parts are described");
});

test("the budget caches, coalesces and refills", async () => {
  let clock = 1_000;
  const budget = new DecisionBudget(1_000, 2, 1, 500, () => clock);
  assert.equal(budget.get("missing"), undefined);

  budget.store("a", { status: "selected" });
  assert.deepEqual(budget.get("a"), { status: "selected" });
  clock += 1_001;
  assert.equal(budget.get("a"), undefined, "entries expire");

  budget.store("a", 1);
  budget.store("b", 2);
  budget.store("c", 3);
  assert.equal(budget.get("a"), undefined, "the oldest entry is evicted past the cap");
  assert.equal(budget.get("c"), 3);

  let runs = 0;
  const run = () => { runs += 1; return Promise.resolve("value"); };
  const [first, second] = await Promise.all([budget.coalesce("k", run), budget.coalesce("k", run)]);
  assert.equal(first, "value");
  assert.equal(second, "value");
  assert.equal(runs, 1, "identical concurrent calls share one provider request");
  await budget.coalesce("k", run);
  assert.equal(runs, 2, "the in-flight entry is released once it settles");

  const limited = new DecisionBudget(1_000, 8, 1, 500, () => clock);
  assert.equal(limited.allow(), true);
  assert.equal(limited.allow(), false, "the bucket starts empty after one call");
  clock += 500;
  assert.equal(limited.allow(), true, "a token is refilled after the interval");
  assert.equal(limited.stats().budgetSkipped, 1);
  assert.equal(limited.stats().lastSkipReason, "budget_exhausted");
});

test("the budget reports what it avoided", () => {
  const budget = new DecisionBudget();
  budget.skipped("unique_exact_match");
  budget.store("k", 1);
  budget.get("k");
  budget.called();
  const stats = budget.stats();
  assert.equal(stats.skipped, 1);
  assert.equal(stats.cacheHits, 1);
  assert.equal(stats.called, 1);
  assert.equal(stats.lastSkipReason, null);
  assert.equal(stats.cacheEntries, 1);
});

test("with the provider disabled the local ranking is returned, trimmed to the request", async () => {
  fs.writeFileSync(path.join(fixture, "settings.json"), JSON.stringify({ provider: "off" }));
  const units = Array.from({ length: 12 }, (_, index) => ({ node_id: `n${index}`, role: "button", text: `Button ${index}` }));
  const local = async (input) => ({ mode: "lexical", totalUnits: units.length, returned: units.length, model: { used: false }, asked: input.maxResults,
    results: units.map((unit) => ({ ...unit, score: 0.5 })) });

  const trimmed = await decisionSearch({ query: "button 3", units, maxResults: 3 }, local);
  assert.equal(trimmed.results.length, 3);
  assert.equal(trimmed.returned, 3);
  assert.equal("decision" in trimmed, false, "no decision is reported when no provider is configured");
  assert.equal(trimmed.asked, 16, "the local pool is widened so a decision can promote a target it was shown");

  assert.equal(await decisionSearch({ query: "" }, local), undefined, "an unusable request leaves the local path alone");
});
