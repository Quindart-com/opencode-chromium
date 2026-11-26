import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { createParticipant } from "../src/control/leases.ts";
import { ABANDONED_SESSION_GRACE_MS, reconcileRuntimeState } from "../src/control/reconcile.ts";
import { PLUGIN_VERSION } from "../src/core/versions.ts";
import { readProfileRegistrations } from "../src/shared/profile-registry.ts";
import { chromiumExtensionFixture } from "./fixtures/chromium-extension.js";

const headed = process.argv.includes("--headed");
const nativeInput = process.argv.includes("--native-input");
assert.ok(!nativeInput || headed, "--native-input requires --headed");
assert.ok(!nativeInput || process.stdin.isTTY, "--native-input requires interactive stdin");
const server = http.createServer((req, res) => {
  const number = new URL(req.url, "http://fixture.test").searchParams.get("page") ?? "overview";
  res.setHeader("Content-Type", "text/html");
  res.end(`<title>Tab review ${number.replace(/[^a-z0-9-]/gi, "")}</title><h1>Tab lifecycle fixture</h1><p id="ready">Ready for human review</p>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let fixture, agent;
try {
  fixture = await chromiumExtensionFixture({ headless: !headed });
  const { createBrowserAgent } = await import("../src/adapters/sdk/index.ts");
  agent = createBrowserAgent();
  const profile = fixture.profileId, sessionId = "tab-review-fixture";
  const origin = `http://127.0.0.1:${server.address().port}`;
  const worker = fixture.context.serviceWorkers()[0];
  await worker.evaluate(() => {
    globalThis.lifecycleAudit = [];
    chrome.tabs.onCreated.addListener(tab => globalThis.lifecycleAudit.push({ event: "created", id: tab.id, openerTabId: tab.openerTabId, groupId: tab.groupId }));
    chrome.tabs.onUpdated.addListener((id, changes) => {
      if (changes.groupId !== undefined) globalThis.lifecycleAudit.push({ event: "grouped", id, groupId: changes.groupId });
    });
  });
  const raw = (name, args = {}) => agent.call(name, { profile, sessionId, ...args });
  const call = async (name, args = {}) => { const result = await raw(name, args); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const tabInfo = tabId => worker.evaluate(id => chrome.tabs.get(id), tabId);
  const groupInfo = groupId => worker.evaluate(id => chrome.tabGroups.get(id), groupId);
  const userTab = page => worker.evaluate(async url => {
    const tab = await chrome.tabs.create({ url, active: false });
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await chrome.tabs.get(tab.id);
      if (current.url === url && current.status === "complete") return tab.id;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Fixture tab did not load");
  }, `${origin}/?page=${page}`);
  const makeGroup = tabIds => worker.evaluate(ids => chrome.tabs.group({ tabIds: ids }), tabIds);
  const candidates = async () => (await call("browser_session", { action: "open", scope: "user" })).result.tabs.map(tab => tab.id);
  const rejectClaim = async (tabId, message) => {
    const result = await raw("browser_session", { action: "claim-tab", tabId });
    assert.equal(result.ok, false);
    assert.match(result.error.message, message);
  };
  const approve = async proposal => {
    assert.equal(proposal.status, "approval_required", JSON.stringify(proposal));
    return agent.call("browser_run", { approvalToken: proposal.approvalToken });
  };
  const claim = async (tabId, args = {}) => {
    const result = await approve(await raw("browser_session", { action: "claim-tab", tabId, ...args }));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  };
  const identity = tab => ({ id: tab.id, url: tab.url, windowId: tab.windowId, groupId: tab.groupId });
  const ownedIds = async () => (await call("browser_session", { action: "open" })).result.tabs.map(tab => tab.id);
  const assertUnowned = async ids => {
    const owned = await ownedIds();
    for (const id of ids) assert.ok(!owned.includes(id), `Personal tab ${id} was adopted`);
  };
  const checkNativeTabs = async (personalId, phase) => {
    if (!nativeInput) return;
    await worker.evaluate(async id => { await chrome.tabs.update(id, { active: true }); }, personalId);
    const before = await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id));
    console.log(`NATIVE_INPUT_READY: ${phase}; use Ctrl+T, then the new-tab button in this disposable window, then press Enter`);
    await Promise.race([
      new Promise(resolve => { process.stdin.once("data", resolve); process.stdin.resume(); }),
      new Promise((_, reject) => fixture.context.once("close", () => reject(new Error("Disposable browser closed during native input verification")))),
    ]);
    process.stdin.pause();
    const created = await worker.evaluate(async ids => (await chrome.tabs.query({})).filter(tab => !ids.includes(tab.id)), before);
    assert.equal(created.length, 2, "Expected a Ctrl+T tab and a new-tab-button tab");
    for (const tab of created) assert.equal(tab.groupId, -1);
    await assertUnowned(created.map(tab => tab.id));
    console.log(`Verified: native Ctrl+T and new-tab button leave personal tabs unowned and ungrouped ${phase}`);
  };

  await fixture.context.pages()[0].goto(origin);
  const userId = await userTab("existing"), groupedId = await userTab("user-group"), siblingId = await userTab("user-group-sibling");
  const changedId = await userTab("changed-after-approval");
  const protectedGroup = await makeGroup([groupedId, siblingId]);
  const restrictedId = await worker.evaluate(async () => (await chrome.tabs.create({ url: "chrome://settings", active: false })).id);
  const otherSessionId = "other-agent-fixture";
  const otherCreated = await call("browser_session", { sessionId: otherSessionId, action: "new-tab" });
  const otherId = otherCreated.activeTabId;
  assert.match(otherCreated.result.creationRequestId, /^[a-f0-9-]{36}$/);
  const otherTabs = await call("browser_session", { sessionId: otherSessionId, action: "open" });
  assert.equal(otherTabs.result.tabs.find(tab => tab.id === otherId).creationRequestId, otherCreated.result.creationRequestId);
  const ownedUngroupedId = (await call("browser_session", { sessionId: otherSessionId, action: "new-tab" })).activeTabId;
  await worker.evaluate(id => chrome.tabs.ungroup(id), ownedUngroupedId);
  const available = await candidates();
  assert.ok(available.includes(userId));
  assert.ok(available.includes(changedId));
  assert.ok(available.includes(groupedId));
  for (const id of [restrictedId, otherId, ownedUngroupedId]) assert.ok(!available.includes(id));
  await rejectClaim(restrictedId, /internal/);
  await rejectClaim(otherId, /controlled/);
  await rejectClaim(ownedUngroupedId, /controlled/);
  const stale = await raw("browser_run", { tab: { mode: "claim", tabId: changedId }, steps: [{ action: "reload" }] });
  await makeGroup([changedId]);
  assert.equal((await approve(stale)).error.code, "TAB_CLAIM_CHANGED");
  const siblingBefore = identity(await tabInfo(siblingId));
  const groupedBefore = identity(await tabInfo(groupedId));
  const runClaim = await approve(await raw("browser_run", { tab: { mode: "claim", tabId: groupedId }, memoryMode: "off", steps: [{ action: "hover", target: { selector: "#ready" } }] }));
  assert.equal(runClaim.ok, true, JSON.stringify(runClaim));
  await call("browser_session", { action: "release-tab", tabId: groupedId });
  assert.equal((await tabInfo(groupedId)).groupId, protectedGroup);
  assert.deepEqual(identity(await tabInfo(groupedId)), groupedBefore);
  assert.deepEqual(identity(await tabInfo(siblingId)), siblingBefore);
  console.log("Verified: discovery exposes personal groups, excludes live owners and internal tabs, and an approved group claim preserves neighboring tabs");

  const contestedId = await userTab("contested");
  const contenders = ["contender-a", "contender-b"];
  const proposals = await Promise.all(contenders.map(id => raw("browser_session", { action: "claim-tab", tabId: contestedId, sessionId: id })));
  const race = await Promise.all(proposals.map(approve));
  assert.equal(race.filter(result => result.ok).length, 1, JSON.stringify(race));
  assert.equal((await tabInfo(contestedId)).url, `${origin}/?page=contested`);
  await call("browser_session", { action: "release-tab", tabId: contestedId, sessionId: race.find(result => result.ok).sessionId });
  console.log("Verified: concurrent approvals acquire one owner");

  const abandonedSession = "abandoned-tab-fixture";
  const abandonedId = (await call("browser_session", { action: "new-tab", sessionId: abandonedSession })).activeTabId;
  await call("browser_run", { sessionId: abandonedSession, memoryMode: "off", steps: [{ action: "navigate", url: `${origin}/?page=abandoned` }] });
  const abandonedBefore = identity(await tabInfo(abandonedId));
  const runtimeDir = path.join(fixture.fixture, "runtime");
  const registrations = readProfileRegistrations(path.join(fixture.fixture, "registry")).filter(row => row.profileId === profile);
  assert.equal(registrations.length, 1);
  const lease = createParticipant(runtimeDir, "runtime", PLUGIN_VERSION, undefined, { sessions: [abandonedSession], profiles: [profile] });
  try {
    lease.abandon();
    assert.equal((await reconcileRuntimeState(runtimeDir, { registrations })).releasedSessions, 0);
    assert.ok(!(await candidates()).includes(abandonedId));
    const now = Date.now() + ABANDONED_SESSION_GRACE_MS + 1000;
    const reconciled = await reconcileRuntimeState(runtimeDir, { now, registrations });
    assert.equal(reconciled.releasedSessions, 1);
    assert.equal(reconciled.removedParticipants, 1);
    assert.equal((await tabInfo(abandonedId)).url, abandonedBefore.url);
    assert.ok((await candidates()).includes(abandonedId));
    await claim(abandonedId);
    assert.match((await call("browser_observe", { mode: "extract", target: { selector: "#ready" } })).result.text, /Ready for human review/);
    await call("browser_session", { action: "release-tab", tabId: abandonedId });
    assert.deepEqual(identity(await tabInfo(siblingId)), siblingBefore);
    console.log("Verified: expiry releases abandoned ownership without closing the tab or changing its neighbor");
  } finally { lease.close(); }

  await call("browser_session", { action: "open", name: "Human review" });
  const urlBefore = (await tabInfo(userId)).url;
  await claim(userId);
  assert.equal((await tabInfo(userId)).url, urlBefore);
  const extraction = await call("browser_observe", { mode: "extract", target: { selector: "#ready" } });
  assert.match(JSON.stringify(extraction), /Ready for human review/);
  const reviewIds = [userId];
  for (let i = 1; i <= 3; i++) {
    reviewIds.push((await call("browser_session", { action: "new-tab" })).activeTabId);
    await call("browser_run", { memoryMode: "off", steps: [{ action: "navigate", url: `${origin}/?page=${i}` }] });
  }
  const originalGroup = (await tabInfo(userId)).groupId;
  const personalId = await userTab("personal-active");
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), personalId);
  const personalBefore = identity(await tabInfo(personalId));
  const protectedBefore = identity(await tabInfo(groupedId));
  await checkNativeTabs(personalId, "during-agent-work");
  // Exercise real DOM-opened tabs and a blank new tab carrying a controlled opener.
  const controlledPage = fixture.context.pages().find(page => page.url() === `${origin}/?page=3`);
  assert.ok(controlledPage);
  const controlledTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, controlledPage.url());
  assert.ok(reviewIds.includes(controlledTabId));
  const beforeChildren = await worker.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id));
  await controlledPage.evaluate(url => {
    const link = document.createElement("a"); link.id = "personal-link"; link.textContent = "Open personal tab";
    link.href = url; link.target = "_blank"; link.rel = "opener";
    document.body.append(link);
    const popup = document.createElement("button"); popup.id = "personal-popup"; popup.textContent = "Open popup";
    popup.onclick = () => window.open(`${url}&popup=1`, "_blank"); document.body.append(popup);
  }, `${origin}/?page=user-link`);
  // Trusted clicks also work in Chromium configurations that block unsolicited popups.
  const [linked] = await Promise.all([fixture.context.waitForEvent("page"), controlledPage.locator("#personal-link").click()]);
  await linked.waitForLoadState("domcontentloaded");
  const [popup] = await Promise.all([fixture.context.waitForEvent("page"), controlledPage.locator("#personal-popup").click()]);
  await popup.waitForLoadState("domcontentloaded");
  const openerBlank = await worker.evaluate(openerTabId => chrome.tabs.create({ url: "about:blank", openerTabId, active: false }), controlledTabId);
  const childIds = await worker.evaluate(async ids => (await chrome.tabs.query({})).filter(tab => !ids.includes(tab.id)).map(tab => tab.id), beforeChildren);
  assert.ok(childIds.length >= 3, `Link, popup, and blank opener tab must exist: ${JSON.stringify(await worker.evaluate(() => globalThis.lifecycleAudit))}`);
  assert.ok(childIds.includes(openerBlank.id));
  await assertUnowned(childIds);
  const childBefore = await Promise.all(childIds.map(async id => identity(await tabInfo(id))));
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), personalId);
  const [racingTab] = await Promise.all([
    worker.evaluate(openerTabId => chrome.tabs.create({ url: "about:blank", openerTabId, active: false }), controlledTabId),
    call("browser_finalize"),
  ]);
  assert.deepEqual(identity(await tabInfo(personalId)), personalBefore);
  assert.deepEqual(identity(await tabInfo(groupedId)), protectedBefore);
  assert.equal((await tabInfo(personalId)).active, true);
  assert.deepEqual(await Promise.all(childIds.map(async id => identity(await tabInfo(id)))), childBefore);
  await assertUnowned([...childIds, racingTab.id, personalId, groupedId]);
  assert.equal((await tabInfo(racingTab.id)).groupId, -1);
  console.log("Verified: links, popups, blank opener tabs, and tabs created during finalize remain unowned; active personal tabs are unchanged");
  await checkNativeTabs(personalId, "after-finalize");
  const reviewTabs = await Promise.all(reviewIds.map(tabInfo));
  const reviewGroup = reviewTabs[0].groupId;
  assert.ok(reviewTabs.every(tab => tab.groupId === reviewGroup));
  if (childBefore.some(tab => tab.groupId === originalGroup)) {
    assert.notEqual(reviewGroup, originalGroup, "Native-grouped, unowned children must stay in their original group");
  } else {
    assert.equal(reviewGroup, originalGroup);
  }
  assert.equal((await groupInfo(reviewGroup)).color, "blue");
  assert.equal((await groupInfo(reviewGroup)).title, "Human review");
  assert.equal((await groupInfo((await tabInfo(otherId)).groupId)).color, "green");
  const afterReview = await candidates();
  for (const id of reviewIds) assert.ok(afterReview.includes(id));
  const reclaimSession = "review-reclaim";
  await claim(userId, { sessionId: reclaimSession });
  await rejectClaim(userId, /controlled/);
  await call("browser_session", { action: "release-tab", tabId: userId, sessionId: reclaimSession });
  assert.equal((await tabInfo(userId)).groupId, reviewGroup);
  console.log("Verified: default finalization preserves all four owned tabs in a named blue group and leaves native-grouped personal tabs untouched");
  if (headed && !nativeInput) {
    console.log("REVIEW_READY: four tabs remain in the blue Human review group; press Enter after native UI inspection");
    await Promise.race([
      new Promise(resolve => process.stdin.once("data", resolve)),
      new Promise((_, reject) => fixture.context.once("close", () => reject(new Error("Disposable browser closed during visual inspection")))),
    ]);
    process.stdin.pause();
  }

  const handoff = (await call("browser_session", { action: "new-tab" })).activeTabId;
  const defaultKeep = (await call("browser_session", { action: "new-tab" })).activeTabId;
  const numericKeep = (await call("browser_session", { action: "new-tab" })).activeTabId;
  const activeGroup = (await tabInfo(handoff)).groupId;
  const secondWindow = await worker.evaluate(url => chrome.windows.create({ url, focused: false }), `${origin}/?page=personal-window`);
  const secondPersonalId = secondWindow.tabs[0].id;
  const secondGroup = await worker.evaluate(({ id, windowId }) => chrome.tabs.group({ tabIds: [id], createProperties: { windowId } }), { id: secondPersonalId, windowId: secondWindow.id });
  // Move one owned tab to a second window; review must stay there even when
  // another window is current. Keep a personal user group active in that window.
  await worker.evaluate(async ({ tabId, windowId }) => {
    await chrome.tabs.move(tabId, { windowId, index: -1 });
  }, { tabId: numericKeep, windowId: secondWindow.id });
  await worker.evaluate(async id => { await chrome.tabs.update(id, { active: true }); }, secondPersonalId);
  const secondBefore = identity(await tabInfo(secondPersonalId));
  await call("browser_finalize", { keep: [{ tabId: handoff, status: "handoff" }, { tabId: defaultKeep }, numericKeep] });
  assert.equal((await groupInfo(activeGroup)).color, "green");
  assert.equal((await tabInfo(handoff)).groupId, activeGroup);
  const keepGroup = (await tabInfo(defaultKeep)).groupId;
  assert.notEqual(keepGroup, activeGroup);
  assert.equal((await tabInfo(numericKeep)).windowId, secondWindow.id);
  assert.equal((await groupInfo((await tabInfo(numericKeep)).groupId)).color, "blue");
  assert.deepEqual(identity(await tabInfo(secondPersonalId)), secondBefore);
  assert.equal((await tabInfo(secondPersonalId)).groupId, secondGroup);
  assert.equal((await groupInfo(keepGroup)).color, "blue");
  const retained = (await call("browser_session", { action: "open" })).result.tabs;
  assert.deepEqual(retained.map(tab => tab.id), [handoff]);
  await call("browser_finalize");
  assert.equal((await groupInfo(activeGroup)).color, "blue");
  console.log("Verified: only explicit handoff retains ownership; omitted and numeric keep entries default to blue review");

  const releasedId = await userTab("released");
  await claim(releasedId);
  await call("browser_session", { action: "release-tab", tabId: releasedId });
  assert.equal((await tabInfo(releasedId)).groupId, -1);
  assert.ok((await candidates()).includes(releasedId));
  console.log("Verified: explicit release leaves the existing page open, ungrouped, and claimable");
} finally {
  agent?.close();
  await fixture?.cleanup();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
