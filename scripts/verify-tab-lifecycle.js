import assert from "node:assert/strict";
import http from "node:http";
import { chromiumExtensionFixture } from "./fixtures/chromium-extension.js";

const headed = process.argv.includes("--headed");
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
  const raw = (name, args = {}) => agent.call(name, { profile, sessionId, ...args });
  const call = async (name, args = {}) => { const result = await raw(name, args); assert.equal(result.ok, true, JSON.stringify(result)); return result; };
  const tabInfo = tabId => worker.evaluate(id => chrome.tabs.get(id), tabId);
  const groupInfo = groupId => worker.evaluate(id => chrome.tabGroups.get(id), groupId);
  const userTab = async page => {
    const tab = await worker.evaluate(url => chrome.tabs.create({ url, active: false }), `${origin}/?page=${page}`);
    return tab.id;
  };
  const makeGroup = tabIds => worker.evaluate(ids => chrome.tabs.group({ tabIds: ids }), tabIds);
  const candidates = async () => (await call("browser_session", { action: "open", scope: "user" })).result.tabs.map(tab => tab.id);
  const rejectClaim = async (tabId, message) => {
    const result = await raw("browser_session", { action: "claim-tab", tabId });
    assert.equal(result.ok, false);
    assert.match(result.error.message, message);
  };

  await fixture.context.pages()[0].goto(origin);
  const userId = await userTab("existing"), groupedId = await userTab("user-group"), changedId = await userTab("changed-after-discovery");
  const protectedGroup = await makeGroup([groupedId]);
  const otherSessionId = "other-agent-fixture";
  const otherId = (await call("browser_session", { sessionId: otherSessionId, action: "new-tab" })).activeTabId;
  const ownedUngroupedId = (await call("browser_session", { sessionId: otherSessionId, action: "new-tab" })).activeTabId;
  await worker.evaluate(id => chrome.tabs.ungroup(id), ownedUngroupedId);
  await call("browser_session", { action: "open", name: "Human review" });
  const available = await candidates();
  assert.ok(available.includes(userId));
  assert.ok(available.includes(changedId));
  for (const id of [groupedId, otherId, ownedUngroupedId]) assert.ok(!available.includes(id));
  await rejectClaim(groupedId, /tab group/);
  await rejectClaim(otherId, /controlled/);
  await rejectClaim(ownedUngroupedId, /controlled/);
  await makeGroup([changedId]);
  await rejectClaim(changedId, /tab group/);
  const runClaim = await raw("browser_run", { tab: { mode: "claim", tabId: groupedId }, steps: [{ action: "reload" }] });
  assert.equal(runClaim.ok, false);
  assert.equal((await tabInfo(groupedId)).groupId, protectedGroup);
  console.log("Verified: discovery hides grouped/owned tabs; both claim paths reject them and recheck stale candidates");

  const urlBefore = (await tabInfo(userId)).url;
  await call("browser_session", { action: "claim-tab", tabId: userId });
  assert.equal((await tabInfo(userId)).url, urlBefore);
  const extraction = await call("browser_observe", { mode: "extract", target: { selector: "#ready" } });
  assert.match(JSON.stringify(extraction), /Ready for human review/);
  const reviewIds = [userId];
  for (let i = 1; i <= 3; i++) {
    reviewIds.push((await call("browser_session", { action: "new-tab" })).activeTabId);
    await call("browser_run", { memoryMode: "off", steps: [{ action: "navigate", url: `${origin}/?page=${i}` }] });
  }
  const originalGroup = (await tabInfo(userId)).groupId;
  await call("browser_finalize");
  const reviewTabs = await Promise.all(reviewIds.map(tabInfo));
  assert.ok(reviewTabs.every(tab => tab.groupId === originalGroup));
  assert.equal((await groupInfo(originalGroup)).color, "blue");
  assert.equal((await groupInfo(originalGroup)).title, "Human review");
  assert.equal((await groupInfo((await tabInfo(otherId)).groupId)).color, "green");
  const afterReview = await candidates();
  for (const id of reviewIds) assert.ok(!afterReview.includes(id));
  await rejectClaim(userId, /tab group/);
  console.log("Verified: default finalization preserves all four tabs in the original named blue group and releases ownership");
  if (headed) {
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
  await call("browser_finalize", { keep: [{ tabId: handoff, status: "handoff" }, { tabId: defaultKeep }, numericKeep] });
  assert.equal((await groupInfo(activeGroup)).color, "green");
  assert.equal((await tabInfo(handoff)).groupId, activeGroup);
  const keepGroup = (await tabInfo(defaultKeep)).groupId;
  assert.notEqual(keepGroup, activeGroup);
  assert.equal((await tabInfo(numericKeep)).groupId, keepGroup);
  assert.equal((await groupInfo(keepGroup)).color, "blue");
  const retained = (await call("browser_session", { action: "open" })).result.tabs;
  assert.deepEqual(retained.map(tab => tab.id), [handoff]);
  await call("browser_finalize");
  assert.equal((await groupInfo(activeGroup)).color, "blue");
  console.log("Verified: only explicit handoff retains ownership; omitted and numeric keep entries default to blue review");

  const releasedId = await userTab("released");
  await call("browser_session", { action: "claim-tab", tabId: releasedId });
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
