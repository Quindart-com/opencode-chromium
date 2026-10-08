import assert from "node:assert/strict";
import test from "node:test";
import { fetchReleaseState, releaseDecision } from "../../scripts/webstore-state.js";
import { chromeReleaseConfig } from "../../scripts/webstore-config.js";
import { resolveConfig, validateConfig } from "publish-browser-extension";

test("release configuration satisfies the installed publisher's v2 contract", () => {
  const config = validateConfig(resolveConfig(chromeReleaseConfig({ dryRun: true, zip: "fixture.zip", extensionId: "a".repeat(32), publisherId: "fixture-publisher", accessToken: "fixture-token" })));
  assert.equal(config.chrome.apiVersion, "v2");
  assert.equal(config.chrome.serviceAccountAccessToken, "fixture-token");
  assert.equal(config.chrome.cancelPending, false);
});

test("store status reuses the refreshed token without a second exchange", async () => {
  let calls = 0;
  await fetchReleaseState({ accessToken: "fixture-token", publisherId: "fixture", extensionId: "fixture", fetcher: async (url, options) => {
    calls++;
    assert.match(url, /:fetchStatus$/);
    assert.equal(options.headers.Authorization, "Bearer fixture-token");
    return Response.json({ itemId: "fixture" });
  } });
  assert.equal(calls, 1);
});

test("a pending same-version submission is not reported as published", () => {
  assert.equal(releaseDecision({ submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "1.7.1" }] } }, "1.7.1").action, "blocked");
  assert.equal(releaseDecision({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "1.7.1" }] } }, "1.7.1").action, "published");
  assert.equal(releaseDecision({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "1.6.5" }] } }, "1.7.1").action, "upload");
});

test("store lookup fails closed without exposing credential response bodies", async () => {
  await assert.rejects(fetchReleaseState({ clientId: "fixture", clientSecret: "fixture", refreshToken: "fixture", publisherId: "fixture", extensionId: "fixture", fetcher: async () => new Response("private response", { status: 401 }) }), /Store authorization failed \(401\)/);
});
