import { expect,test } from "bun:test";
import { reconcileAbandonedSessions } from "../../extension-src/entrypoints/background/reconcile-sessions.ts";
import { registerRuntimeMethods } from "../../extension-src/entrypoints/background/runtime-methods.ts";

function session(lastActivityAt, tabIds = [1, 2]) {
  return { tabIds: new Set(tabIds),tabOrigins: new Map(tabIds.map(id => [id, "agent"])),lastActivityAt,name: null,groupId: null,activeTabId: tabIds[0] ?? null,currentTurnId: null };
}
function fixture({ idle = true, dialog = () => null } = {}) {
  const calls = [];
  return { calls,dependencies: { idle: () => idle,dialog,detach: async id => { calls.push(["detach", id]); },hide: async id => { calls.push(["hide", id]); },ungroup: async id => { calls.push(["ungroup", id]); },
    untrack: async (sessionId, id) => { calls.push(["untrack", id]); const row = sessions.get(sessionId); row?.tabIds.delete(id); } } };
}
let sessions;

test("abandoned reconciliation releases ownership without closing tabs", async () => {
  sessions = new Map([["dead", session(100)]]); const { calls,dependencies } = fixture();
  const result = await reconcileAbandonedSessions(sessions, ["dead", "missing"], 200, dependencies);
  expect(result.settledSessionIds).toEqual(["dead", "missing"]);
  expect(result.releasedTabs).toEqual([1, 2]); expect(result.blockedTabs).toEqual([]);
  expect(calls.map(([name]) => name)).toEqual(["detach", "hide", "ungroup", "untrack", "detach", "hide", "ungroup", "untrack"]);
  expect(sessions.has("dead")).toBe(false);
});

test("recent, busy, and dialog-blocked sessions remain owned", async () => {
  sessions = new Map([["recent", session(300, [1])]]); let state = fixture();
  expect((await reconcileAbandonedSessions(sessions, ["recent"], 200, state.dependencies)).deferredSessionIds).toEqual(["recent"]);
  expect(state.calls).toEqual([]);
  sessions = new Map([["busy", session(100, [2])]]); state = fixture({ idle: false });
  expect((await reconcileAbandonedSessions(sessions, ["busy"], 200, state.dependencies)).reason).toBe("commands_or_approvals_pending");
  sessions = new Map([["dialog", session(100, [3])]]); state = fixture({ dialog: id => id === 3 ? { type: "beforeunload" } : null });
  const blocked = await reconcileAbandonedSessions(sessions, ["dialog"], 200, state.dependencies);
  expect(blocked.blockedTabs).toEqual([{ tabId: 3,reason: "native_dialog" }]); expect(blocked.deferredSessionIds).toEqual(["dialog"]);
});

test("the extension rejects abandoned-session cleanup without the broker credential", async () => {
  const handlers = new Map(), token = "a".repeat(64);
  registerRuntimeMethods({ rpc: { register: (name, handler) => handlers.set(name, handler) },sessions: new Map(),reconciliationToken: () => token,
    commandHealth: { idle: () => true,dialog: () => null },uploadConsent: { idle: () => true },persistSessions: async () => {},
    detachTab: async () => {},hideCursor: async () => {},ungroupTab: async () => {},untrackTab: async () => {},IS_FIREFOX: false });
  await expect(handlers.get("runtime.reconcileSessions")({ sessionIds: ["dead"],inactiveBefore: 1,reconciliationToken: "b".repeat(64) }))
    .rejects.toMatchObject({ code: "CONTROLLER_AUTH_REQUIRED" });
});
