import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentBrowserRuntime, createCoreRegistry } from "../../src/core/index.js";

// A cheap runtime with no browser attached: every case here fails before a step
// can act, which is exactly the path that used to pad a response with an
// observation nobody asked for.
function run(args) {
  const runtime = createAgentBrowserRuntime();
  const registry = createCoreRegistry(runtime);
  return registry.browser_run.execute(args, { sessionID: "failure-context" })
    .then((out) => (typeof out === "string" ? out : JSON.stringify(out)))
    .finally(() => runtime.close?.());
}

test("a rejected step reports a bounded failure with one actionable hint", async () => {
  const text = await run({ steps: [{ action: "nonsense" }] });
  assert.ok(text.length <= 460, `a rejected step stays small, got ${text.length} characters`);
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  const [failed] = body.results;
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "INVALID_REQUEST");
  assert.match(failed.error.message, /nonsense/);
  assert.equal(typeof failed.error.hint, "string");
  assert.ok(failed.error.hint.length > 0 && failed.error.hint.length <= 120, "the hint is one line");
  assert.equal("observation" in failed, false, "a step that never ran is not re-observed");
  assert.equal("result" in failed, false, "the error is not duplicated as a result");
});

test("page errors lose their stack frames and keep the useful first line", async () => {
  const text = await run({ steps: [{ action: "click", target: { selector: "#definitely-not-on-this-page" } }] });
  const [failed] = JSON.parse(text).results;
  assert.match(failed.error.message, /No element matches selector/);
  assert.doesNotMatch(failed.error.message, /\n\s*at\s/, "stack frames are removed");
  assert.doesNotMatch(failed.error.message, /<anonymous>/, "evaluated-script frames are removed");
  assert.ok(text.length <= 600, `a failed click stays bounded, got ${text.length} characters`);
});

test("a missing step target is reported without a browser round trip", async () => {
  const text = await run({ steps: [{ action: "click" }] });
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "INVALID_REQUEST");
  assert.match(body.error.message, /target/);
  assert.equal(typeof body.error.hint, "string");
  assert.ok(text.length <= 320, `an invalid request stays small, got ${text.length} characters`);
});

test("hints are chosen per failure code and always fall back", async () => {
  const { errorDetails, failureHint, FAILURE_MESSAGE_LIMIT } = await import("../../src/core/failure-context.js");
  assert.match(failureHint("TIMEOUT"), /did not answer in time/);
  assert.match(failureHint("STALE_TARGET"), /fresh nodeId/);
  assert.equal(failureHint("SOMETHING_NEW"), failureHint("BROWSER_OPERATION_FAILED"), "an unknown code still gets a hint");
  const long = errorDetails(new Error("x".repeat(5000)));
  assert.equal(long.message.length, FAILURE_MESSAGE_LIMIT);
  assert.match(long.message, /…$/);
  assert.equal(errorDetails(new Error("timed out waiting for the page")).code, "TIMEOUT");
  assert.equal(errorDetails(new Error("click requires target")).code, "INVALID_REQUEST");
  assert.equal(errorDetails(Object.assign(new Error("detached"), { code: "STALE_TARGET" })).code, "STALE_TARGET");
});
