import assert from "node:assert/strict";
import { test } from "bun:test";
import { groupReviewTabs } from "../../extension-src/entrypoints/background/review-group.ts";
import { assignSessionGroup,releaseSessionGroup } from "../../extension-src/entrypoints/background/session-groups.ts";
import { createSessionStorage } from "../../extension-src/entrypoints/background/session-storage.ts";

function fixture(tabs) {
  const groups = new Map([[10, { id: 10, windowId: 1, title: "Research", color: "green" }]]);
  const chrome = {
    tabs: {
      get: async id => ({ ...tabs.find(tab => tab.id === id) }),
      query: async query => tabs.filter(tab => tab.groupId === query.groupId),
      group: async ({ tabIds, groupId = 11 + groups.size, createProperties }) => {
        assert.ok(!createProperties || !groups.has(groupId), "createProperties cannot accompany an existing group");
        // Chrome defaults new groups to the current window, not the tab's window.
        groups.set(groupId, groups.get(groupId) ?? { id: groupId, windowId: createProperties?.windowId ?? 99 });
        for (const tab of tabs.filter(tab => tabIds.includes(tab.id))) {
          tab.groupId = groupId;
          tab.windowId = groups.get(groupId).windowId;
        }
        return groupId;
      },
      ungroup: async id => { tabs.find(tab => tab.id === id).groupId = -1; },
    },
    tabGroups: {
      get: async id => groups.get(id),
      update: async (id, changes) => groups.set(id, { ...groups.get(id), ...changes }),
    },
  };
  return { chrome, groups, session: { groupId: 10, name: "Research", tabIds: new Set(tabs.map(tab => tab.id)), tabGroups: new Map() } };
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

test("cleanup preserves borrowed groups and user group changes", async () => {
  const tabs = [{ id: 1, windowId: 1, groupId: 20 }, { id: 2, windowId: 1, groupId: 20 }, { id: 3, windowId: 1, groupId: 10 }];
  const { chrome, groups, session } = fixture(tabs);
  groups.set(20, { id: 20, windowId: 1, title: "Personal", color: "purple" });
  session.tabGroups.set(1, { id: 20, windowId: 1, origin: "existing" });
  session.tabGroups.set(2, { id: 10, windowId: 1, origin: "session" });
  await releaseSessionGroup(chrome, session, 1);
  await releaseSessionGroup(chrome, session, 2);
  assert.deepEqual([...await groupReviewTabs(session, [1, 2, 3], chrome)], []);
  assert.deepEqual(tabs.map(tab => tab.groupId), [20, 20, 10]);
  assert.equal(groups.get(20).color, "purple");
  assert.equal(groups.get(10).color, "blue");
});

test("session grouping and release keep a claimed tab in its own window", async () => {
  const tabs = [{ id: 1, windowId: 1, groupId: 10 }, { id: 2, windowId: 2, groupId: -1 }];
  const { chrome, session } = fixture(tabs);
  await assignSessionGroup(chrome, session, tabs[1], "green");
  assert.equal(tabs[1].windowId, 2);
  assert.notEqual(tabs[1].groupId, 10);
  await releaseSessionGroup(chrome, session, 2);
  assert.deepEqual(tabs.map(tab => tab.groupId), [10, -1]);
});

test("a review API failure in one window leaves other windows independently reviewable", async () => {
  const tabs = [{ id: 1, windowId: 1, groupId: 10 }, { id: 2, windowId: 2, groupId: -1 }];
  const { chrome, groups, session } = fixture(tabs);
  const group = chrome.tabs.group;
  chrome.tabs.group = async args => {
    if (args.createProperties?.windowId === 2) throw new Error("Grouping unavailable");
    return group(args);
  };
  const failures = await groupReviewTabs(session, [1, 2], chrome);
  assert.deepEqual([...failures.keys()], [2]);
  assert.equal(groups.get(10).color, "blue");
  assert.equal(tabs[1].groupId, -1);
});

test("borrowed group provenance survives reload and queued writes preserve release order", async () => {
  const tabs = [{ id: 1, windowId: 1, groupId: 20 }, { id: 2, windowId: 1, groupId: 10 }];
  const { session, chrome } = fixture(tabs);
  session.tabOrigins = new Map([[1, "user"]]);
  session.tabGroups.set(1, { id: 20, windowId: 1, origin: "existing" });
  const sessions = new Map([["owner", session]]);
  let current;
  const started = Promise.withResolvers(), finish = Promise.withResolvers(), writes = [];
  const storage = createSessionStorage({ sessions, getTab: chrome.tabs.get, sessionState: id => sessions.get(id),
    get: async () => current, set: async data => {
      writes.push(data);
      if (writes.length === 1) { started.resolve(); await finish.promise; }
      current = data;
    } });
  const earlier = storage.persistSessions();
  await started.promise;
  session.tabIds.delete(2);
  const later = storage.persistSessions();
  assert.equal(writes.length, 1);
  finish.resolve();
  await Promise.all([earlier, later]);
  const restored = { tabIds: new Set(), tabOrigins: new Map() };
  sessions.set("owner", restored);
  await storage.restoreSessions();
  assert.deepEqual([...restored.tabIds], [1]);
  assert.equal(restored.tabOrigins.get(1), "user");
  assert.deepEqual(restored.tabGroups.get(1), { id: 20, windowId: 1, origin: "existing" });
  await releaseSessionGroup(chrome, restored, 1);
  assert.equal(tabs[0].groupId, 20);
});
