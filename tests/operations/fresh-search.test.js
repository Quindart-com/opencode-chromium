import assert from "node:assert/strict";
import test from "node:test";
import { freshSearch } from "../../src/browser/operations/fresh-search.ts";

test("search recaptures a page that changes during ranking and returns only the new targets", async () => {
  let revision = 0, calls = 0;
  const result = await freshSearch(async () => ({ observation: { documentId: "doc", revision }, target: revision ? "dialog button" : "old opener" }), async page => {
    if (++calls === 1) revision++;
    return [page.target];
  }, async () => ({ documentId: "doc", revision }));
  assert.deepEqual(result.ranking, ["dialog button"]);
  assert.equal(calls, 2);
});

test("continuous navigation or mutation never returns stale ranked handles", async () => {
  let documentId = 0, calls = 0;
  await assert.rejects(freshSearch(async () => ({ observation: { documentId } }), async () => { calls++; documentId++; return ["stale"]; }, async () => ({ documentId })), { code: "STALE_OBSERVATION", retryable: false, uncertain: false });
  assert.equal(calls, 2);
});

test("a focused-surface change invalidates ranking even if the document remains the same", async () => {
  let focusedRoot = "page", calls = 0;
  const result = await freshSearch(async () => ({ observation: { documentId: "doc", revision: 1, focusedRoot } }), async () => { if (++calls === 1) focusedRoot = "dialog"; return focusedRoot; }, async () => ({ documentId: "doc", revision: 1, focusedRoot }));
  assert.equal(result.page.observation.focusedRoot, "dialog");
});
