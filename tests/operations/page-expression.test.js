import assert from "node:assert/strict";
import { test } from "node:test";
import { domNodeClickTargetExpression, pageInspectExpression, pageSearchUnitsExpression, selectorEditableExpression, shapePageSearchRanking, visualMapExpression } from "../../src/browser/operations/index.js";

test("page search expression preserves whitespace regex escaping", () => {
  const expression = pageSearchUnitsExpression();

  assert.match(expression, /replace\(\/\\s\+\/g/);
  assert.match(expression, /split\(\/\\s\+\//);
  assert.doesNotMatch(expression, /replace\(\/s\+\/g/);
});

test("page inspect expression preserves whitespace regex escaping", () => {
  const expression = pageInspectExpression({ nodeId: "node-1" });

  assert.match(expression, /replace\(\/\\s\+\/g/);
  assert.match(expression, /split\(\/\\s\+\//);
  assert.doesNotMatch(expression, /replace\(\/s\+\/g/);
});

test("visual map expression preserves whitespace regex escaping", () => {
  const expression = visualMapExpression({ query: "save settings" });

  assert.match(expression, /replace\(\/\\s\+\/g/);
  assert.match(expression, /split\(\/\\s\+\//);
  assert.doesNotMatch(expression, /replace\(\/s\+\/g/);
});

test("lean page search output removes model and score internals", () => {
  const shaped = shapePageSearchRanking({
    url: "https://example.test",
    title: "Example",
    query: "save settings",
    scope: { mode: "focused" },
    totalCandidates: 4,
    truncated: false,
    enabled: true,
    mode: "hybrid",
    model: {
      id: "qwen3-0.6b-retrieval",
      label: "Qwen3",
      used: true,
      embedding: { id: "embedding", used: true },
      reranker: { id: "reranker", used: true },
    },
    totalUnits: 4,
    returned: 1,
    results: [
      {
        node_id: "node-1",
        kind: "button",
        name: null,
        text: "Save settings",
        interactive: true,
        score: 0.91,
        scores: { lexical: 0.4, embedding: 0.8, reranker: 0.9 },
      },
    ],
  }, "lean");

  assert.equal(Object.hasOwn(shaped, "model"), false);
  assert.equal(Object.hasOwn(shaped.results[0], "score"), false);
  assert.equal(Object.hasOwn(shaped.results[0], "scores"), false);
  assert.deepEqual(shaped.results[0], {
    node_id: "node-1",
    kind: "button",
    label: "Save settings",
    interactive: true,
  });
});

test("debug page search output preserves full ranking details", () => {
  const ranking = {
    model: { id: "qwen3-0.6b-retrieval", used: true },
    results: [{ node_id: "node-1", score: 0.91, scores: { lexical: 0.4 } }],
  };

  assert.equal(shapePageSearchRanking(ranking, "debug"), ranking);
});

test("click expressions probe multiple safe points instead of only the covered center", () => {
  const expression = domNodeClickTargetExpression("node-1");
  assert.match(expression, /\[0\.25, 0\.25\]/);
  assert.match(expression, /safe click points are covered/);
  assert.doesNotMatch(expression, /center point is covered/);
});

test("editable expressions support verified Monaco replacement without clipboard access", () => {
  const expression = selectorEditableExpression(".monaco-editor textarea", { selectAll: true });
  assert.match(expression, /\.monaco-editor/);
  assert.match(expression, /valueHash/);
  assert.match(expression, /selectEditableText/);
  assert.doesNotMatch(expression, /clipboard/i);
});
