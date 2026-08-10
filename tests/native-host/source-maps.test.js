import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceMapResolver, mapCallFrames } from "../../native-host/src/source-maps.js";

const MINIFIED_MAP = {
  version: 3,
  file: "app.js",
  sources: ["webpack://src/order.ts"],
  names: ["submitOrder"],
  mappings: "AAAAA",
};

const realishMap = {
  version: 3,
  file: "app.js",
  sources: ["webpack://src/index.ts"],
  names: [],
  mappings: "AAAA;AACA",
};

test("resolver maps generated positions to original source locations", () => {
  const resolver = new SourceMapResolver();
  assert.equal(resolver.set("https://site.test/assets/app.js", MINIFIED_MAP), true);
  const position = resolver.originalPositionFor("https://site.test/assets/app.js", 1, 0);
  assert.deepEqual(position, { source: "webpack://src/order.ts", line: 1, column: 0, name: "submitOrder" });
});

test("resolver returns null for unmapped scripts and positions", () => {
  const resolver = new SourceMapResolver();
  resolver.set("https://site.test/assets/app.js", realishMap);
  assert.equal(resolver.originalPositionFor("https://site.test/assets/unknown.js", 1, 0), null);
  assert.equal(resolver.originalPositionFor("https://site.test/assets/app.js", 99, 0), null);
});

test("resolver ignores invalid maps and supports clearing", () => {
  const resolver = new SourceMapResolver();
  assert.equal(resolver.set("https://site.test/assets/app.js", { version: 3, mappings: "not-valid-at-all!!!" }), false);
  resolver.set("https://site.test/assets/app.js", MINIFIED_MAP);
  assert.equal(resolver.has("https://site.test/assets/app.js"), true);
  resolver.clear();
  assert.equal(resolver.has("https://site.test/assets/app.js"), false);
});

test("mapCallFrames produces original locations with generated fallback", () => {
  const resolver = new SourceMapResolver();
  resolver.set("https://site.test/assets/app.js", MINIFIED_MAP);
  const frames = mapCallFrames([
    { functionName: "submitOrder", url: "https://site.test/assets/app.js", lineNumber: 0, columnNumber: 0 },
    { functionName: "notMapped", url: "https://site.test/assets/other.js", lineNumber: 3, columnNumber: 7 },
  ], resolver);
  assert.deepEqual(frames[0], {
    function: "submitOrder",
    url: "webpack://src/order.ts",
    line: 1,
    column: 1,
    name: "submitOrder",
    generated: { url: "https://site.test/assets/app.js", line: 1, column: 1 },
  });
  assert.deepEqual(frames[1], {
    function: "notMapped",
    url: "https://site.test/assets/other.js",
    line: 4,
    column: 8,
    generated: { url: "https://site.test/assets/other.js", line: 4, column: 8 },
  });
});