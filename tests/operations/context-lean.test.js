import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createBrowserOperations, pageInspectExpression, pageSearchUnitsExpression, shapePageSearchRanking, visualMapExpression } from "../../src/browser/operations/index.js";
import { contractMetadata } from "../../src/core/versions.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

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
  assert.equal(contractMetadata().pluginVersion, packageVersion);
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

test("page search defaults to five lean results and an auto strategy", async () => {
  const hooks = await createBrowserOperations();
  const args = hooks.tool.browser_page_search.args;

  assert.equal(args.maxResults.parse(undefined), 5);
  assert.equal(args.mode.parse(undefined), "auto");
  assert.equal(args.detail.parse(undefined), "lean");
});

test("lean search results never carry coordinates, boxes, ranking internals, or duplicated selectors", async () => {
  const hooks = await createBrowserOperations();
  const ranking = {
    url: "https://example.com/settings",
    title: "Settings",
    query: "save button",
    mode: "adaptive",
    searchStrategy: "semantic",
    totalUnits: 42,
    returned: 2,
    model: { id: "snowflake-arctic-embed-xs", used: true, embedding: { used: true } },
    results: [
      {
        node_id: 231,
        kind: "button",
        tagName: "button",
        role: "button",
        name: "Settings",
        text: "Save changes to your settings",
        selector: "div > div > button.save",
        boundingBox: { x: 10, y: 20, width: 30, height: 40 },
        headingPath: ["Main", "Settings"],
        landmark: "main",
        score: 0.9123,
        scores: { lexical: 0.5, embedding: 0.9 },
        interactive: true,
        disabled: false,
      },
      {
        node_id: null,
        kind: "button",
        role: "button",
        label: "Save",
        selector: "#save",
        interactive: true,
      },
    ],
  };

  const lean = shapePageSearchRanking(structuredClone(ranking), "lean");
  assert.equal(lean.results.length, 2);
  for (const result of lean.results) {
    assert.equal("boundingBox" in result, false);
    assert.equal("x" in result, false);
    assert.equal("y" in result, false);
    assert.equal("headingPath" in result, false);
    assert.equal("landmark" in result, false);
    assert.equal("scores" in result, false);
    assert.equal("score" in result, false);
  }
  assert.equal("selector" in lean.results[0], false, "selector must be omitted when a node_id exists");
  assert.equal(lean.results[0].node_id, 231);
  assert.equal(lean.results[0].role, "button");
  assert.equal(lean.results[1].selector, "#save", "selector is the fallback when no node reference exists");

  const compact = shapePageSearchRanking(structuredClone(ranking), "compact");
  assert.equal("boundingBox" in compact.results[0], false);
  assert.equal("scores" in compact.results[0], false);
  assert.equal(compact.results[0].selector, "div > div > button.save");
  assert.equal(compact.results[0].score, 0.9123);
  assert.ok(typeof compact.results[0].text === "string" && compact.results[0].text.length <= 220);

  const debug = shapePageSearchRanking(structuredClone(ranking), "debug");
  assert.deepEqual(debug.results[0].boundingBox, { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(debug.results[0].scores, { lexical: 0.5, embedding: 0.9 });
});

test("a typical five-result lean search stays inside the serialized size budget", async () => {
  const hooks = await createBrowserOperations();
  const ranking = {
    url: "https://example.com/settings",
    title: "Account settings",
    query: "settings",
    mode: "adaptive",
    searchStrategy: "semantic",
    totalUnits: 320,
    returned: 5,
    results: Array.from({ length: 5 }, (_, index) => ({
      node_id: 100 + index,
      kind: "button",
      role: "button",
      name: `Settings action ${index}`,
      text: "A longer description of the settings action that must not leak into the lean payload".repeat(2),
      selector: `#settings-form > div:nth-child(${index}) > button.action-${index}`,
      boundingBox: { x: index * 100, y: 200, width: 80, height: 24 },
      headingPath: ["Account", "Settings", "General"],
      landmark: "main",
      score: 0.8,
      scores: { lexical: 0.4, embedding: 0.7 },
      interactive: true,
    })),
  };

  const lean = shapePageSearchRanking(ranking, "lean");
  const serialized = JSON.stringify(lean);
  assert.equal(lean.results.length, 5);
  assert.ok(serialized.length < 1024, `lean payload ${serialized.length} bytes should stay far below the 2.5 KB budget`);
  assert.doesNotMatch(serialized, /boundingBox/);
  assert.doesNotMatch(serialized, /"score":/);
});
