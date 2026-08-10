import assert from "node:assert/strict";
import { test } from "node:test";
import { compactConsoleEvents } from "../../src/browser/operations/index.js";
import { SourceMapResolver } from "../../native-host/src/source-maps.js";

function consoleEvents() {
  return {
    events: [{
      time: "2026-08-06T10:00:00.000Z",
      tabId: 1,
      method: "Runtime.consoleAPICalled",
      params: {
        type: "error",
        args: [{ type: "string", value: "submitOrder failed" }],
        stackTrace: {
          callFrames: [
            { functionName: "submitOrder", url: "https://site.test/assets/app.js", lineNumber: 0, columnNumber: 0 },
            { functionName: "handleClick", url: "https://site.test/assets/app.js", lineNumber: 1, columnNumber: 0 },
          ],
        },
      },
    }],
  };
}

test("compact console events emit source-mapped stacks when a resolver is present", () => {
  const resolver = new SourceMapResolver();
  resolver.set("https://site.test/assets/app.js", {
    version: 3,
    file: "app.js",
    sources: ["webpack://src/order.ts"],
    names: ["submitOrder"],
    mappings: "AAAAA;AACA",
  });
  const result = compactConsoleEvents(consoleEvents(), { sourceMapped: true, resolver });
  const event = result.events[0];
  assert.equal(event.stack.length, 2);
  assert.equal(event.stack[0].url, "webpack://src/order.ts");
  assert.deepEqual(event.stack[0].generated, { url: "https://site.test/assets/app.js", line: 1, column: 1 });
});

test("compact console events omit stacks by default to stay small", () => {
  const result = compactConsoleEvents(consoleEvents(), {});
  assert.equal("stack" in result.events[0], false);
});