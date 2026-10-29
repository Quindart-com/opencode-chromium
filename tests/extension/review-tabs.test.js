import assert from "node:assert/strict";
import test from "node:test";
import { groupReviewTabs } from "../../extension-src/entrypoints/background/review-group.ts";
import { assertClaimableTab,isClaimableTab } from "../../extension-src/entrypoints/background/tab-ownership.ts";

function fixture(tabs) {
  const groups = new Map([[10, { id: 10, windowId: 1, title: "Research", color: "green" }]]);
  const chrome = {
    tabs: {
      get: async id => ({ ...tabs.find(tab => tab.id === id) }),
      query: async query => tabs.filter(tab => tab.groupId === query.groupId),
      group: async ({ tabIds, groupId = 11 + groups.size }) => {
        groups.set(groupId, groups.get(groupId) ?? { id: groupId, windowId: tabs.find(tab => tab.id === tabIds[0]).windowId });
        for (const tab of tabs.filter(tab => tabIds.includes(tab.id))) tab.groupId = groupId;
        return groupId;
      },
    },
    tabGroups: {
      get: async id => groups.get(id),
      update: async (id, changes) => groups.set(id, { ...groups.get(id), ...changes }),
    },
  };
  return { chrome, groups, session: { groupId: 10, name: "Research" } };
}

test("human review retains the original group, name, and every tab", async () => {
  const tabs = [1, 2, 3].map(id => ({ id, windowId: 1, groupId: 10 }));
  const { chrome, groups, session } = fixture(tabs);
  await groupReviewTabs(session, [1, 2, 3], chrome);
  assert.equal(groups.size, 1);
  assert.equal(groups.get(10).color, "blue");
  assert.equal(groups.get(10).title, "Research");
  assert.deepEqual(tabs.map(tab => tab.groupId), [10, 10, 10]);
});

test("handoff, blocked, and unrelated group members stay in their active group", async () => {
  const tabs = [1, 2, 3, 4].map(id => ({ id, windowId: 1, groupId: 10 }));
  const { chrome, groups, session } = fixture(tabs);
  await groupReviewTabs(session, [2, 3], chrome);
  assert.equal(groups.get(10).color, "green");
  assert.deepEqual([tabs[0].groupId, tabs[3].groupId], [10, 10]);
  assert.equal(tabs[1].groupId, tabs[2].groupId);
  assert.equal(groups.get(tabs[1].groupId).color, "blue");
});

test("review groups stay in each tab's window and do not combine sessions by title", async () => {
  const tabs = [{ id: 1, windowId: 1, groupId: 10 }, { id: 2, windowId: 2, groupId: -1 }];
  const { chrome, groups, session } = fixture(tabs);
  await groupReviewTabs(session, [1, 2], chrome);
  assert.notEqual(tabs[0].groupId, tabs[1].groupId);
  assert.deepEqual(tabs.map(tab => tab.windowId), [1, 2]);
  assert.equal(groups.get(tabs[1].groupId).windowId, 2);
  assert.ok([...groups.values()].every(group => group.color === "blue"));
});

test("claim discovery and enforcement exclude every grouped, owned, or internal tab", () => {
  const available = { id: 1, groupId: -1, url: "https://example.test/" };
  assert.equal(isClaimableTab(available, null), true);
  assert.doesNotThrow(() => assertClaimableTab(available, null));
  assert.equal(isClaimableTab({ id: 2, url: "about:blank" }, null), true);
  for (const [tab, owner, message] of [
    [{ ...available, groupId: 0 }, null, /tab group/],
    [{ ...available, groupId: 12 }, null, /tab group/],
    [available, { sessionId: "another" }, /controlled/],
    [{ ...available, url: "chrome://settings" }, null, /internal/],
    [{ ...available, url: "about:preferences" }, null, /internal/],
  ]) {
    assert.equal(isClaimableTab(tab, owner), false);
    assert.throws(() => assertClaimableTab(tab, owner), message);
  }
});
