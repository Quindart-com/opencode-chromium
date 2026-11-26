import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { createBrowserOperations, shapePageSearchRanking } from "../../src/browser/operations/index.ts";
import { createSessionOperations } from "../../src/browser/operations/operation-groups/session.ts";
import { contractMetadata, responseMetadata } from "../../src/core/versions.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

test("normal response metadata contains only the useful plugin version", () => {
  assert.deepEqual(responseMetadata(), { pluginVersion: packageVersion });
  for (const key of ["protocolVersion", "schemaVersion", "capabilityVersion"]) assert.equal(key in contractMetadata(), false);
  const old = JSON.stringify({ plugin: "opencode-browser-plugin", pluginVersion: packageVersion, protocolVersion: "1", schemaVersion: "1", capabilityVersion: "1" });
  assert.ok(old.length - JSON.stringify(responseMetadata()).length > 100);
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

test("lean lexical record search keeps both exact duplicates and drops fuzzy neighbors", () => {
  const labels = ["Open INV-44", "Open INV-445", "Open INV-44"];
  const ranking = { query: "invoice INV-44", mode: "lexical", returned: 3,
    results: labels.map((name, id) => ({ name, node_id: String(id), kind: "button", interactive: true })) };
  assert.deepEqual(shapePageSearchRanking(ranking).results.map(r => r.label), [labels[0], labels[2]]);
  assert.equal(shapePageSearchRanking({ ...ranking, query: "INV-56" }).results.length, 3);
  assert.equal(shapePageSearchRanking({ ...ranking, query: "INV-44 or INV-445" }).results.length, 3);
});

test("viewport pixels are bound to a native document even when page evaluation is unavailable", async () => {
  let captures = 0, navigation = false, treeReads = 0;
  const op = createSessionOperations({
    activate: async () => {}, enableCdpDomains: async () => {}, keepHiddenTabRendering: async () => {},
    runtimeEvaluate: async () => { throw Error("page evaluation unavailable"); },
    cdp: async (_ctx, _tab, method) => {
      if (method === "Page.captureScreenshot") { captures++; return { data: "eA==" }; }
      assert.equal(method, "Page.getFrameTree");
      return { frameTree: { frame: { id: "main", loaderId: navigation ? String(++treeReads) : "original", url: "https://fixture.test/" } } };
    },
    stringify: JSON.stringify, screenshotMime: () => "image/png", MAX_CAPTURE_BASE64_CHARS: 100,
  }).browser_screenshot;
  const first = JSON.parse(await op.execute({ tabId: 1 }, {}));
  assert.equal(first.base64, "eA==");
  assert.equal(first.observation.changedDuringCapture, null);
  navigation = true;
  await assert.rejects(op.execute({ tabId: 1 }, {}), { code: "STALE_OBSERVATION" });
  assert.equal(captures, 2);
});
