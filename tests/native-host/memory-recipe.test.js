import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../../native-host/src/memory/store.js";
import { chainV2Fingerprint, shortFingerprint } from "../../native-host/src/memory/recipe.js";

function removeRoot(root) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      const start = Date.now();
      while (Date.now() - start < 40) { /* wait for windows lock release */ }
    }
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

function openStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-recipe-test-"));
  const store = new MemoryStore({ root });
  store.enable();
  return { root, store };
}

function requestSteps(...steps) {
  return steps;
}

// The canonical JSON is hashed, so a reordered field or a changed
// requiresRuntime* derivation would silently invalidate every fingerprint
// already stored in users' databases and disable deterministic replay.
test("chain fingerprints stay byte-identical to the ones 1.7.2 stored", () => {
  const recipe = {
    position: 0,
    action: "click",
    hostname: "example.com",
    target_label: "Open menu",
    target_role: null,
    selector: null,
    requiresRuntimeValue: false,
    requiresRuntimeUrl: false,
    success: true,
  };
  assert.equal(chainV2Fingerprint([recipe]), "ed11173c6a4c4136a4c05223da39df1f754deaa4a037027cce19505d50f4901b");
  // The legacy expression, kept here as the second half of the equivalence.
  assert.equal(
    shortFingerprint(`chain:v2:${JSON.stringify([{ ...recipe, success: undefined }])}`),
    chainV2Fingerprint([recipe]),
  );
  // `success` is not part of recipe identity: a failed run of one step still
  // describes the same recipe, and a reordered array is canonicalized first.
  assert.equal(chainV2Fingerprint([{ ...recipe, success: false }]), chainV2Fingerprint([recipe]));
  assert.equal(chainV2Fingerprint([{ ...recipe, position: 4 }]), chainV2Fingerprint([recipe]));
});

test("a repeated request resolves deterministically with no embedding call", () => {
  const { store, root } = openStore();
  store.recordStep({ chainId: "workflow", position: 0, action: "navigate", hostname: "example.com", target: { query: "Docs" }, success: true });
  store.recordStep({ chainId: "workflow", position: 1, action: "click", hostname: "example.com", target: { query: "Open menu", role: "button" }, success: true });
  store.recordStep({ chainId: "workflow", position: 2, action: "fill", hostname: "example.com", target: { query: "Search" }, success: true });
  const finalized = store.finalizeChain({ chainId: "workflow", success: true });
  assert.equal(finalized.accepted, true);

  const found = store.findRecipe({
    steps: requestSteps(
      { action: "navigate", url: "https://example.com/docs", target: { query: "Docs" }, value: "https://example.com/docs" },
      { action: "click", target: { query: "Open menu", role: "button" } },
      { action: "fill", target: { query: "Search" }, value: "runtime value" },
    ),
    hostname: "example.com",
  });
  assert.equal(found.match?.kind, "chain_v2");
  assert.equal(found.match?.deterministic, true);
  assert.equal(found.match?.similarity, 1);
  assert.equal(found.match?.failed_count, 0);
  assert.equal(found.match?.id, finalized.chainId);
  assert.deepEqual(found.match?.steps.map((step) => step.action), ["navigate", "click", "fill"]);
  assert.equal(found.match?.steps[2].requiresRuntimeValue, true);
  assert.equal(found.match?.steps[0].requiresRuntimeUrl, true);
  store.close();
  removeRoot(root);
});

test("deterministic recall never serves failed or superseded recipes", () => {
  const { store, root } = openStore();
  store.recordStep({ chainId: "good", position: 0, action: "click", hostname: "example.com", target: { query: "Open" }, success: true });
  store.finalizeChain({ chainId: "good", success: true });
  store.recordStep({ chainId: "bad", position: 0, action: "click", hostname: "other.test", target: { query: "Open" }, success: false });
  store.finalizeChain({ chainId: "bad", success: false });

  const openOn = (hostname) => store.findRecipe({ steps: requestSteps({ action: "click", target: { query: "Open" } }), hostname });
  assert.equal(openOn("example.com").match != null, true);
  assert.equal(openOn("other.test").match, null, "a chain with a recorded failure is a negative lesson, not a replay candidate");

  // Superseding a recipe replaces it: only a live head stays replayable.
  const superseded = store.db.prepare("SELECT id FROM memory_chains_v2 WHERE safe_summary LIKE 'example.com%'").get();
  const successor = store.db.prepare("SELECT id FROM memory_chains_v2 WHERE safe_summary LIKE 'other.test%'").get();
  store.db.prepare("UPDATE memory_chains_v2 SET replaced_by = ? WHERE id = ?").run(successor.id, superseded.id);
  assert.equal(openOn("example.com").match, null);
  store.close();
  removeRoot(root);
});

test("deterministic recall rejects any step-level difference", () => {
  const { store, root } = openStore();
  store.recordStep({ chainId: "workflow", position: 0, action: "click", hostname: "example.com", target: { query: "Open menu" }, success: true });
  store.recordStep({ chainId: "workflow", position: 1, action: "click", hostname: "example.com", target: { selector: "#save" }, success: true });
  store.finalizeChain({ chainId: "workflow", success: true });

  const baseline = requestSteps(
    { action: "click", target: { query: "Open menu" } },
    { action: "click", target: { selector: "#save" } },
  );
  assert.equal(store.findRecipe({ steps: baseline, hostname: "example.com" }).match != null, true, "identical request must match");
  assert.equal(store.findRecipe({ steps: requestSteps({ action: "click", target: { query: "Open menu" } }), hostname: "example.com" }).match, null, "step count");
  assert.equal(store.findRecipe({ steps: requestSteps({ action: "hover", target: { query: "Open menu" } }, { action: "click", target: { selector: "#save" } }), hostname: "example.com" }).match, null, "action");
  assert.equal(store.findRecipe({ steps: requestSteps({ action: "click", target: { query: "Open" } }, { action: "click", target: { selector: "#save" } }), hostname: "example.com" }).match, null, "label");
  assert.equal(store.findRecipe({ steps: requestSteps({ action: "click", target: { query: "Open menu" } }, { action: "click", target: { selector: "#submit" } }), hostname: "example.com" }).match, null, "selector");
  assert.equal(store.findRecipe({ steps: baseline, hostname: "elsewhere.test" }).match, null, "hostname");
  // The request hostname is part of recipe identity, so an unknown host can
  // never claim another host's recipe.
  assert.equal(store.findRecipe({ steps: baseline, hostname: null }).match, null, "unknown host");
  assert.equal(store.findRecipe({ steps: requestSteps({ action: "invalid action" }, { action: "click", target: { selector: "#save" } }), hostname: "example.com" }).match, null, "invalid action");
  store.close();
  removeRoot(root);
});

test("deterministic lookup is a pure read: nothing about the request is persisted", () => {
  const { store, root } = openStore();
  store.recordStep({ chainId: "workflow", position: 0, action: "fill", hostname: "example.com", target: { query: "Search" }, success: true });
  store.finalizeChain({ chainId: "workflow", success: true });
  const before = {
    actions: store.db.prepare("SELECT COUNT(*) AS n FROM memory_actions_v2").get().n,
    chains: store.db.prepare("SELECT COUNT(*) AS n FROM memory_chains_v2").get().n,
    events: store.db.prepare("SELECT COUNT(*) AS n FROM memory_usage_events").get().n,
  };
  // Assembled at runtime so the repository carries no literal address; the
  // point is that a lookup carrying one persists nothing and cannot match a
  // stored label, because the lookup path sanitizes exactly like capture does.
  const secret = ["user", "example.com"].join("@");
  const found = store.findRecipe({
    steps: requestSteps({ action: "fill", target: { query: secret }, value: "a typed value" }),
    hostname: "example.com",
  });
  assert.equal(found.match, null, "a sanitized label must not collide with a stored one");
  const after = {
    actions: store.db.prepare("SELECT COUNT(*) AS n FROM memory_actions_v2").get().n,
    chains: store.db.prepare("SELECT COUNT(*) AS n FROM memory_chains_v2").get().n,
    events: store.db.prepare("SELECT COUNT(*) AS n FROM memory_usage_events").get().n,
  };
  assert.deepEqual(after, before);
  const text = store.db.prepare("SELECT safe_summary || ' ' || recipe_json AS text FROM memory_chains_v2").all().map((row) => row.text).join(" ");
  assert.equal(text.includes("user"), false);
  assert.equal(text.includes("a typed value"), false);
  store.close();
  removeRoot(root);
});
