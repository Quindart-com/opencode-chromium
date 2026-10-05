import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { fileInputExpression } from "../../src/browser/uploads.js";

test("upload resolves a selected node or associated label with multiple inputs on the page", () => {
  const logo = { isConnected: true, matches: selector => selector === 'input[type=file]' };
  const label = { isConnected: true, control: logo };
  const document = { querySelectorAll: () => [logo, {}] };
  const context = { document, window: { __agentBrowserDomNodeMap: new Map([["node-logo", logo], ["node-label", label]]) } };
  assert.equal(vm.runInNewContext(fileInputExpression("node-logo"), context), logo);
  assert.equal(vm.runInNewContext(fileInputExpression("node-label"), context), logo);
  assert.throws(() => vm.runInNewContext(fileInputExpression(), context), /exactly one/);
  assert.throws(() => vm.runInNewContext(fileInputExpression("missing"), context), /Unknown DOM node/);
  logo.isConnected = false;
  assert.throws(() => vm.runInNewContext(fileInputExpression("node-logo"), context), /detached/);
});

test("selector uploads reject missing and ambiguous targets", () => {
  for (const inputs of [[], [{}, {}]]) {
    assert.throws(() => vm.runInNewContext(fileInputExpression(null, "#logo"), { document: { querySelectorAll: () => inputs }, window: {} }), /exactly one/);
  }
});
