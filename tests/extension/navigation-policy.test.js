import assert from "node:assert/strict";
import test from "node:test";
import { updateSessionPolicy, assertSessionUrl, installNavigationPolicy } from "../../extension-src/entrypoints/background/navigation-policy.js";
test("session policy survives configuration updates and permits a safe blank tab", () => {
  const session = {};
  updateSessionPolicy(session, { url_policy: { allowedOrigins: ["https://*.example.com"], blockedOrigins: ["private.example.com"] } });
  updateSessionPolicy(session, {});
  assertSessionUrl(session, "https://www.example.com/start"); assertSessionUrl(session, "about:blank");
  assert.throws(() => assertSessionUrl(session, "https://private.example.com"), { code: "URL_POLICY_BLOCKED" });
  assert.throws(() => assertSessionUrl(session, "https://other.test"), { code: "URL_POLICY_BLOCKED" });
});
test("controlled popup inherits policy; unrelated or already-owned tabs are untouched", async () => {
  const callbacks = {}, tracked = [], stopped = [], session = {};
  updateSessionPolicy(session, { url_policy: { blockedOrigins: ["blocked.test"] } });
  const owners = new Map([[1, { sessionId: "first", session }], [8, { sessionId: "other", session: {} }]]);
  installNavigationPolicy({ chrome: { tabs: { onCreated: { addListener: fn => callbacks.created = fn }, onUpdated: { addListener: fn => callbacks.updated = fn } } },
    findOwner: id => owners.get(id), trackTab: async (id, tabId) => { tracked.push(tabId); owners.set(tabId, { sessionId: id, session }); },
    getTab: async () => ({ url: "https://blocked.test/redirect" }), stopLoading: async id => stopped.push(id) });
  callbacks.created({ id: 2, openerTabId: 1 }); callbacks.created({ id: 3, openerTabId: 99 }); callbacks.created({ id: 8, openerTabId: 1 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(tracked, [2]); assert.deepEqual(stopped, [2]);
  callbacks.updated(1, { url: "https://blocked.test" }); callbacks.updated(99, { url: "https://blocked.test" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(stopped, [2, 1]); assert.equal(session.navigationWarnings.length, 2);
  assert.equal(owners.get(8).sessionId, "other");
});
