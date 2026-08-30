import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore, appendOverlap, composeChainFor, correctChainStep, mergeChains } from "../../native-host/src/memory/index.js";

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

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memory-chains-test-"));
}

function openMemory() {
  const root = tempRoot();
  const store = new MemoryStore({ root });
  store.enable();
  return { root, store };
}

function record(store, { success, capability, hostname, label, chainId = null, stepIndex = null, errorCode = null }) {
  return store.record({ success, capability, hostname, label, chainId, stepIndex, errorCode });
}

test("chain recording captures ordered steps and confirms counters", () => {
  const { store, root } = openMemory();
  store.ensureChain({ chainId: "chain-1", intent: "submit an order", sessionId: "s1" });
  record(store, { success: true, capability: "browser.tab.create", hostname: "shop.example", label: "Product", chainId: "chain-1", stepIndex: 0 });
  record(store, { success: true, capability: "browser.input.gesture", hostname: "checkout.example", label: "Pay", chainId: "chain-1", stepIndex: 1 });
  record(store, { success: false, capability: "browser.cdp.execute", hostname: "checkout.example", label: "Pay", errorCode: "timeout", chainId: "chain-1", stepIndex: 1 });
  const shown = store.chainShow("chain-1");
  assert.ok(shown.chain);
  assert.equal(shown.chain.steps.length, 2);
  assert.equal(shown.chain.confirmed_count, 2);
  assert.equal(shown.chain.failed_count, 1);
  const list = store.chainsList();
  assert.equal(list.chains.length, 1);
  assert.equal(list.chains[0].head, true);
  store.close();
  removeRoot(root);
});

test("appendOverlap merges shared boundaries", () => {
  const base = [
    { fingerprint: "a", position: 0 },
    { fingerprint: "b", position: 1 },
    { fingerprint: "c", position: 2 },
  ];
  const incoming = [
    { fingerprint: "b", position: 0 },
    { fingerprint: "c", position: 1 },
    { fingerprint: "d", position: 2 },
  ];
  const merged = appendOverlap(base, incoming);
  assert.deepEqual(merged.map((step) => step.fingerprint), ["a", "b", "c", "d"]);
});

test("mergeChains creates a superseding head and links lineage", () => {
  const { store, root } = openMemory();
  store.ensureChain({ chainId: "base", intent: "checkout", sessionId: "s1" });
  store.ensureChain({ chainId: "incoming", intent: "checkout", sessionId: "s2" });
  record(store, { success: true, capability: "browser.tab.create", hostname: "shop.example", label: "A", chainId: "base", stepIndex: 0 });
  record(store, { success: true, capability: "browser.input.gesture", hostname: "checkout.example", label: "B", chainId: "base", stepIndex: 1 });
  record(store, { success: true, capability: "browser.input.gesture", hostname: "checkout.example", label: "B", chainId: "incoming", stepIndex: 0 });
  record(store, { success: true, capability: "browser.session.finalize", hostname: "checkout.example", label: "C", chainId: "incoming", stepIndex: 1 });

  const merged = mergeChains(store, { baseFingerprint: "base", incomingFingerprint: "incoming", intent: "checkout" });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged_of.length, 2);
  const head = store.chainShow(merged.fingerprint);
  assert.equal(head.chain.head, true);
  assert.equal(head.chain.merged_of.length, 2);
  assert.equal(store.chainShow("base").chain.head, false, "base is superseded");
  assert.equal(store.chainShow("incoming").chain.head, false, "incoming is superseded");
  store.close();
  removeRoot(root);
});

test("correction replaces a failed step and supersedes the chain", () => {
  const { store, root } = openMemory();
  store.ensureChain({ chainId: "chain-cor", intent: "login", sessionId: "s1" });
  record(store, { success: true, capability: "browser.tab.create", hostname: "login.example", label: "Open", chainId: "chain-cor", stepIndex: 0 });
  record(store, { success: false, capability: "browser.input.gesture", hostname: "login.example", label: "Submit", errorCode: "timeout", chainId: "chain-cor", stepIndex: 1 });
  const correctedWith = record(store, { success: true, capability: "browser.cdp.execute", hostname: "login.example", label: "Click submit" });

  const corrected = correctChainStep(store, { chainFingerprint: "chain-cor", position: 1, replacementSignatureFingerprint: correctedWith.fingerprint });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.by, correctedWith.fingerprint);
  assert.equal(typeof corrected.replaced, "string");
  const head = store.chainShow(corrected.fingerprint);
  assert.equal(head.chain.head, true);
  const steps = head.chain.steps;
  assert.equal(steps[1].fingerprint, correctedWith.fingerprint);
  assert.equal(store.chainShow("chain-cor").chain.head, false, "failed chain is superseded");
  store.close();
  removeRoot(root);
});

test("composeChainFor builds a fresh chain from confirmed signature seeds", () => {
  const { store, root } = openMemory();
  const first = record(store, { success: true, capability: "browser.tab.create", hostname: "a.example", label: "One" });
  const second = record(store, { success: true, capability: "browser.input.gesture", hostname: "b.example", label: "Two" });
  const composed = composeChainFor(store, { intent: "flow", seedSignatures: [first.fingerprint, second.fingerprint] });
  assert.equal(composed.ok, true);
  assert.equal(composed.steps.length, 2);
  const again = composeChainFor(store, { intent: "flow", seedSignatures: [first.fingerprint, second.fingerprint] });
  assert.equal(again.existing, true, "composing the same chain is idempotent");
  store.close();
  removeRoot(root);
});
