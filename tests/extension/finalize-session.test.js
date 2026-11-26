import assert from "node:assert/strict";
import { test } from "bun:test";
import { finalizeOwnedTabs } from "../../extension-src/entrypoints/background/finalize-session.ts";

test("handoff keeps ownership and deliverables are grouped before release", async () => {
  const session = { tabIds: new Set([1, 2]), tabOrigins: new Map([[1, "agent"], [2, "agent"]]) };
  const calls = [];
  const result = await finalizeOwnedTabs(session, new Map([[1, "handoff"], [2, "deliverable"]]), {
    dialog: () => null, detach: async () => {}, hide: async () => {},
    deliver: async ids => { calls.push(["deliver", ids]); }, untrack: async id => { calls.push(["untrack", id]); session.tabIds.delete(id); },
  });
  assert.equal(result.partial, false);
  assert.deepEqual(calls, [["deliver", [2]], ["untrack", 2]]);
  assert.deepEqual([...session.tabIds], [1]);
});

test("a failed review grouping retains ownership and reports partial cleanup", async () => {
  const session = { tabIds: new Set([1]), tabOrigins: new Map([[1, "agent"]]) };
  const result = await finalizeOwnedTabs(session, new Map(), { dialog: () => null, detach: async () => {}, hide: async () => {},
    deliver: async () => { throw new Error("blocked grouping"); }, untrack: async () => assert.fail("must retain ownership"),
  });
  assert.equal(result.partial, true);
  assert.equal(result.tabs[0].status, "blocked");
});

test("finalize with no keep list releases every agent and user tab for review", async () => {
  const session = { tabIds: new Set([1, 2, 3]), tabOrigins: new Map([[1, "agent"], [2, "agent"], [3, "user"]]) };
  let reviewed;
  const result = await finalizeOwnedTabs(session, new Map(), { dialog: () => null, detach: async () => {}, hide: async () => {},
    deliver: async ids => { reviewed = ids; }, untrack: async id => { assert.deepEqual(reviewed, [1, 2, 3]); session.tabIds.delete(id); },
  });
  assert.equal(result.partial, false);
  assert.deepEqual(result.tabs.map(tab => tab.status), ["released", "released", "released"]);
  assert.equal(session.tabIds.size, 0);
});

test("a partial review failure retains only the blocked ownership and reports each tab", async () => {
  const session = { tabIds: new Set([1, 2, 3]) };
  const reserved = new Set();
  const found = await finalizeOwnedTabs(session, new Map([[3, "handoff"]]), {
    dialog: () => null, detach: async () => {}, hide: async () => {},
    reserve: id => { reserved.add(id); return () => reserved.delete(id); },
    deliver: async () => { assert.deepEqual([...reserved], [1, 2, 3]); return new Map([[1, "Review unavailable"]]); },
    untrack: async id => { assert.ok(reserved.has(id)); session.tabIds.delete(id); },
  });
  assert.deepEqual(found, { partial: true, tabs: [{ tabId: 1, status: "blocked", reason: "Review unavailable" }, { tabId: 2, status: "released" }, { tabId: 3, status: "kept" }] });
  assert.deepEqual([...session.tabIds], [1, 3]);
  assert.equal(reserved.size, 0);
});
