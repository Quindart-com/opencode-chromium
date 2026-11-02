import assert from "node:assert/strict";
import { test } from "bun:test";
import { updateSessionPolicy, assertSessionUrl, installNavigationPolicy } from "../../extension-src/entrypoints/background/navigation-policy.ts";
test("session policy survives configuration updates and permits a safe blank tab", () => {
  const session = {};
  updateSessionPolicy(session, { url_policy: { allowedOrigins: ["https://*.example.com"], blockedOrigins: ["private.example.com"] } });
  updateSessionPolicy(session, {});
  assertSessionUrl(session, "https://www.example.com/start"); assertSessionUrl(session, "about:blank");
  assert.throws(() => assertSessionUrl(session, "https://private.example.com"), { code: "URL_POLICY_BLOCKED" });
  assert.throws(() => assertSessionUrl(session, "https://other.test"), { code: "URL_POLICY_BLOCKED" });
});
test("only explicitly owned tabs receive navigation policy; new tabs never inherit ownership", async () => {
  const callbacks = {}, stopped = [], session = {};
  updateSessionPolicy(session, { url_policy: { blockedOrigins: ["blocked.test"] } });
  const owners = new Map([[1, { sessionId: "first", session }], [8, { sessionId: "other", session: {} }]]);
  installNavigationPolicy({ chrome: { tabs: { onCreated: { addListener: fn => callbacks.created = fn }, onUpdated: { addListener: fn => callbacks.updated = fn } } },
    findOwner: id => owners.get(id), stopLoading: async id => stopped.push(id) });
  assert.equal(callbacks.created, undefined, "opening a tab must not grant ownership");
  callbacks.updated(1, { url: "https://blocked.test" });
  // A popup with a controlled opener is still unowned, even on a blocked URL.
  callbacks.updated(2, { url: "https://blocked.test/popup", openerTabId: 1 });
  callbacks.updated(3, { url: "chrome://newtab/" });
  callbacks.updated(8, { url: "https://blocked.test" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(stopped, [1]); assert.equal(session.navigationWarnings.length, 1);
  assert.equal(owners.get(8).sessionId, "other");
  owners.set(2, { sessionId: "first", session });
  callbacks.updated(2, { url: "https://blocked.test/redirect" });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(stopped, [1, 2]); assert.equal(session.navigationWarnings.length, 2);
});
