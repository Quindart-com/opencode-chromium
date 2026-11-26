import assert from "node:assert/strict";
import { test } from "bun:test";
import { z } from "zod";
import { CommandHealth } from "../../extension-src/entrypoints/background/command-health.ts";
import { registerRuntimeMethods } from "../../extension-src/entrypoints/background/runtime-methods.ts";
import { createTabClaims } from "../../extension-src/entrypoints/background/tab-claims.ts";
import { TabOwnershipTransitions } from "../../extension-src/entrypoints/background/tab-ownership.ts";
import { createBrowserAgent } from "../../src/adapters/sdk/factory.ts";
import { createSessionOperations } from "../../src/browser/operations/operation-groups/session.ts";

const profile = "fixture-profile";
const origin = "https://fixture.test/";
const controllerToken = "a".repeat(64);
const agentKeepSchema = z.array(z.unknown()).default([]);
const tab = (id, groupId = -1, extra = {}) => ({ id, groupId, windowId: 1, url: origin + id, title: `Fixture ${id}`, ...extra });

function extension(profileId = profile, rows = [
  tab(1), tab(2, 10), tab(3, 20), tab(4, 30), tab(5, 30), tab(6, -1, { url: "about:preferences" }),
  tab(7, -1, { incognito: true }), tab(8, -1, { url: undefined }), tab(9, -1, { pendingUrl: "chrome://settings" }),
]) {
  const tabs = new Map(rows.map(item => [item.id, item])), sessions = new Map(), handlers = new Map();
  const transitions = new TabOwnershipTransitions(), health = new CommandHealth(), tracked = [];
  let now = Date.now();
  const sessionState = id => {
    if (!sessions.has(id)) sessions.set(id, { tabIds: new Set(), tabOrigins: new Map(), lastActivityAt: now, activeTabId: null, groupId: null });
    return sessions.get(id);
  };
  const findTabOwner = tabId => {
    for (const [sessionId, session] of sessions) if (session.tabIds.has(tabId)) return { sessionId, session, origin: session.tabOrigins.get(tabId) };
    return null;
  };
  const getTab = async tabId => {
    if (!tabs.has(tabId)) throw new Error("Missing tab");
    return { ...tabs.get(tabId) };
  };
  const normalizeTab = ({ id, url, title, windowId }) => ({ id, url, title, windowId, controlled: !!findTabOwner(id) });
  const tabClaims = createTabClaims({
    getTab, queryTabs: async () => [...tabs.values()], findTabOwner, profileId: async () => profileId,
    sessionId: params => params.session_id, tabId: params => params.tabId, policy: params => params.url_policy ?? {},
    normalizeTab,
    transitions, idle: id => health.idle(id), now: () => now,
    track: async (params, { id }) => {
      const session = sessionState(params.session_id);
      session.tabIds.add(id); session.tabOrigins.set(id, "user"); session.activeTabId = id;
      tracked.push([params.session_id, id]);
    },
  });
  const reserveCleanup = tabId => {
    assert.ok(health.idle(tabId), "Pending commands cannot be cleaned up");
    return transitions.begin(tabId);
  };
  registerRuntimeMethods({
    rpc: { register: (name, handler) => handlers.set(name, handler) }, sessions, tabClaims, sessionState, reserveCleanup, getTab, normalizeTab, assertSessionUrl() {},
    requiredSessionId: params => params.session_id, tabIdFromParams: params => params.tabId,
    updateTurn: session => { session.lastActivityAt = now; }, commandHealth: health, uploadConsent: { idle: () => true },
    detachTab: async () => {}, hideCursor: async () => {}, ungroupTab: async () => {}, persistSessions: async () => {},
    ensureControlledTab: ({ session_id }, tabId) => {
      transitions.assertIdle(tabId);
      const owner = findTabOwner(tabId);
      assert.equal(owner?.sessionId, session_id);
      return owner;
    },
    untrackTab: async (id, tabId) => { sessions.get(id)?.tabIds.delete(tabId); },
    normalizeKeepItem: item => typeof item === "number" ? { tabId: item, status: "deliverable" } : item,
    reconciliationToken: () => controllerToken, IS_FIREFOX: true,
  });
  return {
    profileId, tabs, sessionState, findTabOwner, tracked, health, advance: ms => { now += ms; },
    rpc: (method, params) => handlers.get(method)({ profile_id: profileId, ...params }),
  };
}

function agentFor(...extensions) {
  const byProfile = new Map(extensions.map(fixture => [fixture.profileId, fixture]));
  const hostRequest = (method, params, { profileId }) => byProfile.get(profileId).rpc(method, params);
  const chosen = new Map(), actions = [];
  const operations = createSessionOperations({
    stringify: JSON.stringify, addProfileToTabResult: (result, profileId) => ({ ...result, profileId }),
    extensionProfileRequest: async (context, method, args = {}) => {
      const profileId = args.profileId ?? context.profileId ?? chosen.get(context.sessionID);
      const result = await hostRequest(method, { ...args, profile_id: profileId, session_id: context.sessionID, deadlineAt: context.deadlineAt }, { profileId });
      return { profileId, result };
    },
  });
  const agent = createBrowserAgent({ hostRequest, operationFactory: async () => ({ tool: {
    ...operations,
    browser_select_profile: { ...operations.browser_select_profile, execute: async ({ profileId }, context) => { chosen.set(context.sessionID, profileId); } },
    browser_finalize: { args: { keep: agentKeepSchema, blockedTabs: agentKeepSchema }, execute: async ({ keep }, context) => {
      const profileId = chosen.get(context.sessionID);
      return { profiles: { [profileId]: await hostRequest("finalizeTabs", { keep, session_id: context.sessionID }, { profileId }) } };
    } },
    browser_turn_end: { args: {}, execute: async () => ({}) },
  } }) });
  agent.runtime.connectedProfiles = async () => extensions.map(({ profileId }) => ({ profileId, profileLabel: profileId }));
  agent.runtime.executeStep = async (step, id, _prior, session) => {
    assert.equal(byProfile.get(session.profileId).findTabOwner(id)?.sessionId, session.sessionId);
    actions.push([session.profileId, id, step.action]);
    return { done: step.action };
  };
  return { ...agent, actions };
}

const session = (agent, args) => agent.call("browser_session", { sessionId: "borrower", ...args });
const discover = agent => session(agent, { action: "open", scope: "user" });
const propose = (agent, tabId, sessionId) => session(agent, { action: "claim-tab", tabId, ...(sessionId ? { sessionId } : {}) });
const runClaim = (agent, tabId, args = {}) => agent.call("browser_run", {
  sessionId: "borrower", tab: { mode: "claim", tabId }, memoryMode: "off", steps: [{ action: "hover", target: { selector: "#ready" } }], ...args,
});
const resume = (agent, proposal, args = {}, context) => agent.call("browser_run", { approvalToken: proposal.approvalToken, ...args }, context);

test("public discovery and both claims share eligibility for ungrouped, personal, review, owned and restricted tabs", async () => {
  const browser = extension(), agent = agentFor(browser);
  browser.sessionState("stale").tabIds.add(4);
  browser.sessionState("live").tabIds.add(5);
  try {
    const available = await discover(agent);
    assert.deepEqual(available.result.tabs.map(({ id, tabGroup, claimReason }) => [id, tabGroup, claimReason]),
      [[1, null, "ungrouped"], [2, 10, "grouped"], [3, 20, "grouped"]]);
    for (const [id, code] of [[4, "TAB_ALREADY_OWNED"], [5, "TAB_ALREADY_OWNED"], [6, "TAB_CLAIM_RESTRICTED"],
      [7, "TAB_CLAIM_RESTRICTED"], [8, "TAB_CLAIM_RESTRICTED"], [9, "TAB_CLAIM_RESTRICTED"]]) {
      assert.equal((await propose(agent, id)).error.code, code);
      assert.equal((await runClaim(agent, id)).error.code, code);
    }
    const pending = await propose(agent, 2);
    assert.equal(pending.status, "approval_required");
    assert.deepEqual(pending.claimTarget, { id: 2, url: origin + "2", title: "Fixture 2", tabGroup: 10, claimReason: "grouped", profileId: profile, profileLabel: profile });
    assert.equal(browser.findTabOwner(2), null);
    assert.equal((await resume(agent, pending)).activeTabId, 2);
    assert.equal(browser.findTabOwner(2).sessionId, "borrower");
    assert.equal(browser.tabs.get(2).groupId, 10);
    const chain = await runClaim(agent, 3);
    assert.equal(chain.status, "approval_required");
    assert.deepEqual(agent.actions, []);
    assert.equal((await resume(agent, chain)).status, "completed");
    assert.deepEqual(agent.actions, [[profile, 3, "hover"]]);
    assert.equal(browser.findTabOwner(1), null);
  } finally { await agent.close(); }
});

test("approval is bound to the caller session, browser session, profile and selected tab", async () => {
  const browser = extension(), other = extension("other"), agent = agentFor(browser, other);
  const request = { profile, sessionId: "borrower", action: "claim-tab", tabId: 2 };
  const context = { sessionID: "harness-session" };
  try {
    const pending = await agent.call("browser_session", request, context);
    assert.equal((await resume(agent, pending, {}, { sessionID: "other-session" })).error.code, "APPROVAL_SESSION_MISMATCH");
    assert.equal((await resume(agent, pending, { sessionId: "wrong" }, context)).error.code, "APPROVAL_SESSION_MISMATCH");
    assert.equal((await resume(agent, pending, { tab: { tabId: 3 } }, context)).status, "invalid_request");
    await session(agent, { action: "open", scope: "user", profile: "other" });
    assert.equal((await resume(agent, pending, {}, context)).error.code, "TAB_CLAIM_PROFILE_MISMATCH");
    assert.equal(browser.findTabOwner(2), null);
    assert.equal(other.findTabOwner(2), null);

    const { claimToken } = await browser.rpc("prepareTabClaim", { session_id: "borrower", tabId: 2 });
    for (const params of [{ session_id: "alien" }, { tabId: 3 }]) {
      await assert.rejects(browser.rpc("claimUserTab", { claimToken, session_id: "borrower", tabId: 2, ...params }), { code: "TAB_CLAIM_APPROVAL_INVALID" });
    }
    await assert.rejects(other.rpc("claimUserTab", { claimToken, session_id: "borrower", tabId: 2, profile_id: profile }), { code: "TAB_CLAIM_PROFILE_MISMATCH" });
    await assert.rejects(other.rpc("claimUserTab", { session_id: "borrower", tabId: 2 }), { code: "TAB_CLAIM_APPROVAL_REQUIRED" });
    assert.equal(browser.findTabOwner(2), null);
    assert.equal(other.findTabOwner(3), null);
  } finally { await agent.close(); }
});

test("a profile selection change during an approved chain leaves identical tab IDs isolated", async () => {
  const browser = extension(), other = extension("other", [tab(2, -1, { url: "https://other.test/" })]);
  other.sessionState("borrower").tabIds.add(2);
  const agent = agentFor(browser, other), started = Promise.withResolvers(), continueStep = Promise.withResolvers();
  agent.runtime.executeStep = async (_step, id, _prior, session) => {
    started.resolve();
    await continueStep.promise;
    return agent.runtime.invoke("browser_get_tab", { tabId: id }, session.sessionId);
  };
  try {
    const pending = await runClaim(agent, 2, { profile });
    const run = resume(agent, pending);
    await Promise.race([started.promise, run.then(result => { throw new Error(JSON.stringify(result)); })]);
    assert.equal((await session(agent, { action: "open", profile: "other", scope: "user" })).ok, true);
    continueStep.resolve();
    const approved = await run;
    assert.equal(approved.results[0].result.url, origin + "2");
    assert.equal(agent.runtime.sessions.get("borrower").profileId, "other");
  } finally { continueStep.resolve(); await agent.close(); }
});

test("declined, expired and changed approvals leave the original tabs untouched", async () => {
  const browser = extension(), agent = agentFor(browser);
  try {
    const declined = await propose(agent, 1);
    assert.equal((await resume(agent, declined, { approvalDecision: "decline" })).status, "approval_declined");
    assert.equal((await resume(agent, declined)).error.code, "APPROVAL_TOKEN_INVALID");
    const expired = await propose(agent, 2);
    browser.advance(300001);
    assert.equal((await resume(agent, expired)).error.code, "TAB_CLAIM_APPROVAL_INVALID");
    browser.advance(-300001);
    const moved = await runClaim(agent, 3);
    browser.tabs.get(3).groupId = 40;
    assert.equal((await resume(agent, moved)).error.code, "TAB_CLAIM_CHANGED");
    assert.deepEqual(browser.tracked, []);
    assert.deepEqual(agent.actions, []);
  } finally { await agent.close(); }
});

test("concurrent approvals have one owner and a released tab needs fresh approval before reclaim", async () => {
  const browser = extension(), first = agentFor(browser), second = agentFor(browser);
  try {
    const [one, two] = await Promise.all([propose(first, 2), runClaim(second, 2, { sessionId: "contender" })]);
    const ids = ["borrower", "contender"], agents = [first, second];
    const results = await Promise.all([resume(first, one), resume(second, two)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    const winner = results.findIndex(result => result.ok);
    assert.deepEqual(browser.tracked, [[ids[winner], 2]]);
    assert.equal(browser.findTabOwner(2).sessionId, ids[winner]);
    assert.equal((await propose(agents[1 - winner], 2, ids[1 - winner])).error.code, "TAB_ALREADY_OWNED");
    assert.equal((await browser.rpc("releaseTab", { tabId: 2, session_id: ids[winner] })).released, true);
    assert.equal(browser.tabs.get(2).groupId, 10);
    const fresh = await propose(agents[1 - winner], 2, ids[1 - winner]);
    assert.equal((await resume(agents[1 - winner], fresh)).ok, true);
    assert.equal(browser.findTabOwner(2).sessionId, ids[1 - winner]);
  } finally { await first.close(); await second.close(); }
});

test("controller reconciliation defers pending work, preserves live ownership and exposes a stale tab after release", async () => {
  const browser = extension(), agent = agentFor(browser);
  const abandoned = browser.sessionState("stale"), live = browser.sessionState("live");
  abandoned.tabIds.add(4); abandoned.lastActivityAt = 1; live.tabIds.add(5);
  let finishWork;
  const work = browser.health.run(4, () => new Promise(resolve => { finishWork = resolve; }));
  const reconcile = () => browser.rpc("runtime.reconcileSessions", { sessionIds: ["stale", "live"], inactiveBefore: 10, reconciliationToken: controllerToken });
  try {
    assert.equal((await reconcile()).reason, "commands_or_approvals_pending");
    assert.equal((await discover(agent)).result.tabs.some(item => item.id === 4), false);
    finishWork();
    await work;
    const settled = await reconcile();
    assert.deepEqual(settled.releasedTabs, [4]);
    assert.deepEqual(settled.deferredSessionIds, ["live"]);
    assert.equal((await discover(agent)).result.tabs.some(item => item.id === 4), true);
    assert.equal((await resume(agent, await propose(agent, 4))).ok, true);
    assert.equal((await propose(agent, 5)).error.code, "TAB_ALREADY_OWNED");
  } finally { finishWork?.(); await work; await agent.close(); }
});

test("finalization identifies ambiguous profiles and keeps a handoff live until deliverable cleanup", async () => {
  const browser = extension(), other = extension("other"), agent = agentFor(browser, other);
  try {
    const ambiguous = await agent.call("browser_finalize", { sessionId: "borrower" });
    assert.equal(ambiguous.error.code, "PROFILE_SELECTION_REQUIRED");
    assert.deepEqual(ambiguous.profiles.map(item => item.profileId), [profile, "other"]);
    const pending = await session(agent, { action: "claim-tab", profile, tabId: 3 });
    await resume(agent, pending);
    const handoff = await agent.call("browser_finalize", { sessionId: "borrower", keep: [{ tabId: 3, status: "handoff" }] });
    assert.deepEqual(handoff.result.profiles[profile].tabs, [{ tabId: 3, status: "kept" }]);
    assert.equal(agent.runtime.sessions.get("borrower").profileId, profile);
    assert.equal((await propose(agent, 3, "next")).error.code, "PROFILE_SELECTION_REQUIRED");
    assert.equal((await session(agent, { sessionId: "next", profile, action: "claim-tab", tabId: 3 })).error.code, "TAB_ALREADY_OWNED");
    const finalized = await agent.call("browser_finalize", { sessionId: "borrower" });
    assert.deepEqual(finalized.result.profiles[profile].tabs, [{ tabId: 3, status: "released" }]);
    assert.equal(browser.tabs.get(3).groupId, 20);
    const reclaim = await session(agent, { action: "claim-tab", profile, tabId: 3, sessionId: "next" });
    assert.equal((await resume(agent, reclaim)).ok, true);
  } finally { await agent.close(); }
});
