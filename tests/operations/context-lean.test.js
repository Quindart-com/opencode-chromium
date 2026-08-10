import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserOperations, pageInspectExpression, pageSearchUnitsExpression, visualMapExpression } from "../../src/browser/operations/index.js";
import { contractMetadata } from "../../src/core/versions.js";

test("lean inspect omits verbose target html and styles by default", () => {
  const expression = pageInspectExpression({ nodeId: "node-1" });

  assert.match(expression, /requestedDetail === 'debug'/);
  assert.match(expression, /html: compact\(target\.outerHTML, 1600\)/);
  assert.match(expression, /styles: styleFor\(target\)/);
});

test("inspect summaries never emit tagName, visible, or screenshotClip", () => {
  const expression = pageInspectExpression({ nodeId: "node-1" });

  assert.doesNotMatch(expression, /tagName: element\.localName/);
  assert.doesNotMatch(expression, /visible: visible\(element\)/);
  assert.doesNotMatch(expression, /screenshotClip/);
});

test("inspect summary fields are conditionally omitted so nulls stay out of context", () => {
  const expression = pageInspectExpression({ nodeId: "node-1" });

  assert.match(expression, /if \(role\) summary\.role = role/);
  assert.match(expression, /if \(name\) summary\.name = name/);
  assert.match(expression, /if \(type\) summary\.type = type/);
  assert.match(expression, /if \(placeholder\) summary\.placeholder = placeholder/);
  assert.match(expression, /summary\.disabled = true/);
});

test("search unit summaries are lean and never carry tagName", () => {
  const expression = pageSearchUnitsExpression();

  assert.doesNotMatch(expression, /tagName: element\.localName/);
  assert.doesNotMatch(expression, /headingPath: headingPathFor\(element\)/);
  assert.doesNotMatch(expression, /landmark: landmarkFor\(element\)/);
  assert.doesNotMatch(expression, /disabled: Boolean\(element\.disabled\)/);
  assert.match(expression, /headingPath\.length > 0/);
});

test("search and visual scope omit selector and node_id when unset", () => {
  const search = pageSearchUnitsExpression();
  const visual = visualMapExpression();

  assert.match(search, /\.\.\.\(requestedSelector \? \{ selector: requestedSelector \} : \{\}\)/);
  assert.match(visual, /\.\.\.\(requestedSelector \? \{ selector: requestedSelector \} : \{\}\)/);
});

test("contract metadata omits null component versions but keeps overrides", () => {
  assert.equal(Object.hasOwn(contractMetadata(), "extensionVersion"), false);
  assert.equal(Object.hasOwn(contractMetadata(), "nativeHostVersion"), false);
  assert.equal(contractMetadata().plugin, "opencode-browser-plugin");
  assert.equal(contractMetadata().pluginVersion, "1.5.0");
  assert.equal(contractMetadata({ extensionVersion: "1.0" }).extensionVersion, "1.0");
  assert.equal(contractMetadata({ nativeHostVersion: "2.0" }).nativeHostVersion, "2.0");
});

test("page inspect defaults to lean output with a bounded maxText", async () => {
  const hooks = await createBrowserOperations();
  const args = hooks.tool.browser_page_inspect.args;

  assert.equal(args.detail.parse(undefined), "lean");
  assert.equal(args.detail.parse("debug"), "debug");
  assert.equal(args.maxText.parse(undefined), 400);
  assert.equal(args.maxText.parse(5000), 5000);
  assert.match(pageInspectExpression({ maxText: 5000 }), /const maxText = 2000;/);
});