import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import { FrameDecoder, encodeFrame } from "../../native-host/src/framing.js";

function startHost(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-version-test-"));
  const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "native-host", "src", "host.js");
  const child = spawn(process.execPath, [host], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, OPENCODE_BROWSER_MEMORY_DIR: root, OPENCODE_BROWSER_MEMORY_EMBED: "0", AGENT_BROWSER_PROFILE_REGISTRY_DIR: path.join(root, "profiles"), AGENT_BROWSER_INSTANCE_IPC_PATH: process.platform === "win32" ? `\\\\.\\pipe\\opencode-browser-lifecycle-${process.pid}-${Date.now()}` : path.join(root, "host.sock") },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await closed;
    }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("host-version-test-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return child;
}

test("native host exits promptly when the extension input closes", { timeout: 10000 }, async (t) => {
  const child = startHost(t);
  const started = Date.now();
  child.stdin.end();
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.equal(exit.signal, null);
  assert.equal(exit.code, 0);
  assert.ok(Date.now() - started < 5000);
});

test("the packaged native-host handshake reports its installed package version", { timeout: 10000 }, async (t) => {
  const child = startHost(t);
  const response = new Promise((resolve, reject) => {
    const decoder = new FrameDecoder({ onMessage: (message) => { if (message.id === 17) resolve(message); } });
    child.stdout.on("data", (chunk) => { try { decoder.push(chunk); } catch (error) { reject(error); } });
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Host exited before replying")));
  });
  child.stdin.write(encodeFrame({ jsonrpc: "2.0", id: 17, method: "profile.hello", params: { profileId: "fixture", profileLabel: "Fixture" } }));
  const message = await response;
  const expected = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  assert.equal(message.result.nativeHostVersion, expected);
  assert.equal(message.result.registered, true);
  child.stdin.end();
});
