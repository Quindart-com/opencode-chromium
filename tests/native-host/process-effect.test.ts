import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { runProcess, ProcessFailure } from "../../src/control/process.ts";

test("process effects preserve success and typed failures", async () => {
  await runProcess(process.execPath, ["-e", "process.exit(0)"], { cwd: process.cwd(), timeoutMs: 5000 });
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(7)"], { cwd: process.cwd(), timeoutMs: 5000 }),
    error => error instanceof ProcessFailure && /code 7/.test(error.message));
});

test("cancelling a process scope terminates its child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-scope-"));
  const file = path.join(dir, "pid");
  const controller = new AbortController();
  const operation = runProcess(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", file],
    { cwd: dir, timeoutMs: 5000, signal: controller.signal });
  const rejected = assert.rejects(operation);
  try {
    const deadline = Date.now() + 3000;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(file), "the child started");
    const pid = Number(fs.readFileSync(file, "utf8"));
    controller.abort();
    await rejected;
    const stopped = Date.now() + 1000;
    let running = true;
    while (running && Date.now() < stopped) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 20)); } catch { running = false; }
    }
    assert.equal(running, false, "cancellation released the child process");
  } finally { controller.abort(); await rejected; fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("process deadlines produce a typed timeout", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.cwd(), timeoutMs: 100 }),
    error => error instanceof ProcessFailure && error.message === "Update timed out");
});
