import assert from "node:assert/strict";
import test from "node:test";
import { fetchReleaseState, releaseDecision } from "../../scripts/webstore-state.js";

test("a pending same-version submission is not reported as published", () => {
  assert.equal(releaseDecision({ submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "1.7.1" }] } }, "1.7.1").action, "blocked");
  assert.equal(releaseDecision({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "1.7.1" }] } }, "1.7.1").action, "published");
  assert.equal(releaseDecision({ publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "1.6.5" }] } }, "1.7.1").action, "upload");
});

test("store lookup fails closed without exposing credential response bodies", async () => {
  await assert.rejects(fetchReleaseState({ clientId: "fixture", clientSecret: "fixture", refreshToken: "fixture", publisherId: "fixture", extensionId: "fixture", fetcher: async () => new Response("private response", { status: 401 }) }), /Store authorization failed \(401\)/);
});
