import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native host exits promptly when the extension input closes", { timeout: 10000 }, async () => {
  const host = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "native-host", "src", "host.js");
  const child = spawn(process.execPath, [host], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, AGENT_BROWSER_INSTANCE_IPC_PATH: `\\\\.\\pipe\\opencode-browser-lifecycle-${process.pid}-${Date.now()}` },
  });
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
