import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBrowserOperations, GRANULAR_OPERATION_COUNT } from "../../src/browser/operations/index.js";
import { createCapabilityRegistry } from "../../src/core/capabilities.js";
import { ApprovalStore } from "../../src/core/approvals.js";
import { createLogger, redact } from "../../src/core/logging.js";
import { backoffDelay, classifyRetry, withRetries } from "../../src/core/retries.js";
import { selectProfile } from "../../src/core/profiles.js";
import { contractMetadata } from "../../src/core/versions.js";
import { createCoreRegistry } from "../../src/core/registry.js";
import { ArtifactStore } from "../../src/core/artifacts.js";

test("the baseline operation inventory is preserved behind the provider-neutral engine", async () => {
  const hooks = await createBrowserOperations();
  assert.equal(Object.keys(hooks.tool).length, GRANULAR_OPERATION_COUNT);
  assert.equal(GRANULAR_OPERATION_COUNT, 50);
  assert.equal(hooks.tool.browser_page_search.args.mode.parse(undefined), "snowflake");
  const baseline = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "baseline.json"), "utf8"));
  assert.deepEqual(Object.keys(hooks.tool), baseline.granularOperations);
});

test("runtime-read retry fields are present while writes remain explicitly classed as never retry", () => {
  const schema = createCoreRegistry({ run() {}, observe() {}, session() {}, finalize() {} }).browser_run.inputSchema;
  assert.equal(schema.safeParse({ steps: [{ action: "assert", target: { selector: "#ready" }, retry: 3, onError: "continue", bypassCache: true }] }).success, true);
  assert.equal(classifyRetry({ action: "click", error: new Error("timeout") }), "never");
  assert.equal(classifyRetry({ action: "assert", error: new Error("timeout") }), "read");
});

test("capability manifests are compact and advanced execution validates required fields", () => {
  const operations = {
    browser_download_events: { args: {}, execute: async () => ({ events: [] }) },
    browser_locator_fill: { args: {}, execute: async () => ({ filled: true }) },
    browser_network_inspect: { capabilityOnly: true, args: {}, execute: async () => ({ events: [] }) },
  };
  const registry = createCapabilityRegistry({ operations, invoke: async () => ({}) });
  const manifest = registry.manifest("downloads");
  assert.equal(manifest.pack, "downloads");
  assert.equal(manifest.capabilities[0].name, "downloads.events");
  assert.throws(() => registry.validate("forms.fill", {}), { name: "ZodError" });
  assert.equal(registry.has("legacy.browser_download_events"), true);
  const network = registry.manifest("network");
  assert.equal(network.capabilities[0].name, "network.inspect");
  assert.equal(network.capabilities[0].parameters.find((item) => item.name === "includeBody").default, "none");
  assert.equal(registry.has("legacy.browser_network_inspect"), false);
  assert.equal(registry.validate("network.inspect", { tabId: 7 }).includeBody, "none");
});

test("profile selection never guesses among connected profiles", () => {
  assert.equal(selectProfile([{ profileId: "one" }]).profileId, "one");
  assert.equal(selectProfile([{ profileId: "one", profileLabel: "Work" }], "Work").profileId, "one");
  assert.throws(() => selectProfile([{ profileId: "one", profileLabel: "Work" }, { profileId: "two", profileLabel: "Work" }], "Work"), { code: "PROFILE_LABEL_AMBIGUOUS" });
  assert.throws(() => selectProfile([{ profileId: "one" }], "missing"), { code: "PROFILE_DISCONNECTED" });
});

test("approval tokens are immutable, session-bound, and single use", () => {
  let now = 1000;
  const store = new ApprovalStore({ ttlMs: 100, now: () => now });
  const issued = store.issue({ sessionId: "s", request: { steps: [{ action: "click" }] }, reasons: ["click"] });
  assert.equal(store.consume(issued.token, { sessionId: "s" }).digest.length, 64);
  assert.throws(() => store.consume(issued.token, { sessionId: "s" }), { code: "APPROVAL_TOKEN_INVALID" });
  const expired = store.issue({ sessionId: "s", request: { steps: [] } });
  now += 101;
  assert.throws(() => store.consume(expired.token, { sessionId: "s" }), { code: "APPROVAL_TOKEN_INVALID" });
});

test("artifacts are isolated by session URI", () => {
  const store = new ArtifactStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-contract-artifacts-")) });
  const artifact = store.create({ sessionId: "owner", data: "secret", mimeType: "text/plain" });
  try {
    assert.equal(store.read(artifact.uri, { sessionId: "owner" }).data.toString(), "secret");
    const wrongUri = artifact.uri.replace("owner", "other");
    assert.equal(store.read(wrongUri, { sessionId: "other" }), null);
  } finally {
    store.close();
  }
});

test("redaction and structured logging keep secrets out of diagnostics", () => {
  assert.equal(redact({ password: "secret", text: "Bearer abc" }).password, "[REDACTED]");
  assert.equal(redact({ text: "Bearer abc" }).text, "[REDACTED]");
  let line = "";
  const logger = createLogger({ sink: { write(value) { line += value; } }, clock: () => "now" });
  logger.info("test", { password: "secret", safe: true });
  assert.doesNotMatch(line, /secret/);
  assert.match(line, /opencode-browser-plugin/);
});

test("retry backoff is bounded and deterministic when jitter is disabled", async () => {
  assert.equal(backoffDelay(3, { baseMs: 10, maxMs: 20, jitter: 0 }), 20);
  let attempts = 0;
  const result = await withRetries(async () => {
    attempts += 1;
    if (attempts < 2) throw new Error("timeout");
    return "ok";
  }, { action: "assert", retries: 1, delay: () => 0, sleep: async () => {} });
  assert.deepEqual(result, { value: "ok", attempts: 2 });
  assert.deepEqual(contractMetadata({ extensionVersion: "1.0" }).plugin, "opencode-browser-plugin");
});
