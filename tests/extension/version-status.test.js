import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { versionNotice, validVersion } from "../../extension-src/version-status.ts";
import { RpcRelay } from "../../native-host/src/rpc-relay.js";

const connected = { state: "connected", versionChecked: true, nativeHostVersion: "1.7.1", clientVersions: ["1.7.1"] };

test("version notices distinguish matching, older local, older extension, and unknown versions", () => {
  assert.equal(versionNotice("1.7.1", connected), null);
  assert.equal(versionNotice("1.7.1", { ...connected, state: "disconnected" }), null);
  assert.equal(versionNotice("1.7.1", { ...connected, nativeHostVersion: "1.6.5" }).kind, "local");
  assert.equal(versionNotice("1.7.1", { ...connected, clientVersions: ["1.6.5"] }).kind, "local");
  assert.equal(versionNotice("1.7.1", { ...connected, nativeHostVersion: "1.10.0" }).kind, "extension");
  assert.equal(versionNotice("1.7.1", { ...connected, nativeHostVersion: null }).kind, "unknown");
  assert.equal(versionNotice("1.7.1", { ...connected, unknownClientVersion: true }).kind, "unknown");
  assert.equal(validVersion("unexpected version text"), null);
});

test("snoozes expire and a different version pair immediately prompts again", () => {
  const status = { ...connected, nativeHostVersion: "1.6.5" };
  const notice = versionNotice("1.7.1", status);
  const reminder = { key: notice.key, until: Date.now() + 60000 };
  assert.equal(versionNotice("1.7.1", { ...status, versionReminder: reminder }).snoozed, true);
  assert.equal(versionNotice("1.7.2", { ...status, versionReminder: reminder }).snoozed, false);
  assert.equal(versionNotice("1.7.1", { ...status, versionReminder: { ...reminder, until: 0 } }).snoozed, false);
});

test("the relay reports host and connected client versions and clears disconnected clients", async () => {
  const messages = [];
  const relay = new RpcRelay({ state: { nativeHostVersion: "1.7.1" }, extensionWriter: async (message) => { messages.push(message); }, onProfile() {}, localHandler: async () => ({}) });
  const socket = new EventEmitter();
  socket.write = (_buffer, callback) => callback();
  relay.addClient(socket);
  await relay.handleExtensionMessage({ method: "profile.hello", id: 1, params: { profileId: "fixture" } });
  assert.equal(messages.at(-1).result.nativeHostVersion, "1.7.1");
  await relay.handleClientMessage(socket, { method: "host.status", id: 2, clientVersion: "1.6.5" });
  assert.deepEqual(messages.at(-1).params.clientVersions, ["1.6.5"]);
  socket.emit("close");
  assert.deepEqual(messages.at(-1).params.clientVersions, []);
});
