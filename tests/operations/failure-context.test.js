import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { FAILURE_MESSAGE_LIMIT, errorDetails, failureHint, shouldReobservePage } from "../../src/core/failure-context.js";
import { createAgentBrowserRuntime, createCoreRegistry } from "../../src/core/index.js";

// These cases all resolve without a browser: an invalid request is rejected
// before any profile or tab is touched, so they hold on a machine with no
// browser connected as firmly as on a developer machine.

function run(args) {
  const runtime = createAgentBrowserRuntime();
  const registry = createCoreRegistry(runtime);
  return registry.browser_run.execute(args, { sessionID: "failure-context" })
    .then((out) => (typeof out === "string" ? out : JSON.stringify(out)))
    .finally(() => runtime.close?.());
}

test("a rejected request reports a bounded failure with one actionable hint", async () => {
  const text = await run({ steps: [{ action: "click" }] });
  assert.ok(text.length <= 320, `an invalid request stays small, got ${text.length} characters`);
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "INVALID_REQUEST");
  assert.match(body.error.message, /target/);
  assert.ok(body.error.message.length <= FAILURE_MESSAGE_LIMIT);
  assert.equal(typeof body.error.hint, "string");
  assert.ok(body.error.hint.length > 0 && body.error.hint.length <= 120, "the hint is one line");
  assert.equal(body.status, body.status.toLowerCase(), "the status stays the lowercase code");
});

test("the failure envelope carries nothing the error already states", async () => {
  const body = JSON.parse(await run({ steps: [{ action: "click" }] }));
  assert.equal("results" in body, false, "an invalid request never reaches the step loop");
  assert.equal("observation" in body, false, "nothing was inspected");
  assert.equal(Object.keys(body.error).sort().join(","), "code,hint,message,retryable,uncertain");
});

test("page errors lose their stack frames and keep the useful first line", () => {
  const raw = "Error: No element matches selector: #missing\n    at querySelectorStrict (<anonymous>:25:27)\n    at <anonymous>:263:21";
  const detail = errorDetails(new Error(raw));
  assert.equal(detail.message, "Error: No element matches selector: #missing");
  assert.doesNotMatch(detail.message, /\n\s*at\s/, "stack frames are removed");
  assert.doesNotMatch(detail.message, /<anonymous>/, "evaluated-script frames are removed");

  const multiLine = errorDetails(new Error("first line\nsecond line\nthird line"));
  assert.equal(multiLine.message, "first line second line third line", "non-stack text keeps its content on one line");
});

test("messages are clipped and hints are chosen per code", () => {
  const long = errorDetails(new Error("x".repeat(5000)));
  assert.equal(long.message.length, FAILURE_MESSAGE_LIMIT);
  assert.match(long.message, /…$/);
  assert.match(failureHint("TIMEOUT"), /did not answer in time/);
  assert.match(failureHint("STALE_TARGET"), /fresh nodeId/);
  assert.equal(failureHint("SOMETHING_NEW"), failureHint("BROWSER_OPERATION_FAILED"), "an unknown code still gets a hint");
});

test("failure codes are classified from the error itself", () => {
  assert.equal(errorDetails(new Error("timed out waiting for the page")).code, "TIMEOUT");
  assert.equal(errorDetails(new Error("click requires target")).code, "INVALID_REQUEST");
  assert.equal(errorDetails(Object.assign(new Error("detached"), { code: "STALE_TARGET" })).code, "STALE_TARGET");
  assert.equal(errorDetails(new z.ZodError([])).code, "INVALID_REQUEST");
  assert.equal(errorDetails(Object.assign(new Error("boom"), { retryable: true, uncertain: true })).retryable, true);
  assert.equal(errorDetails(new Error("timed out")).uncertain, true);
});

test("the page is only re-read when the action may have changed something", () => {
  assert.equal(shouldReobservePage({ uncertain: true, readOnly: false, hasTarget: true }), true);
  assert.equal(shouldReobservePage({ uncertain: true, readOnly: true, hasTarget: true }), false, "a read action cannot have changed the page");
  assert.equal(shouldReobservePage({ uncertain: true, readOnly: false, hasTarget: false }), false, "a step with no target is not re-observed");
  assert.equal(shouldReobservePage({ uncertain: false, readOnly: false, hasTarget: true }), false, "a certain outcome needs no second look");
  assert.equal(shouldReobservePage(), false, "the predicate never throws on missing input");
});
