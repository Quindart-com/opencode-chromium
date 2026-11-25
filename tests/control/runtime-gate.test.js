import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spyOn, test } from "bun:test";
import { withRuntimeLock } from "../../src/control/state.ts";

test.skipIf(process.platform !== "win32")("Windows delete-pending runtime gate retries before running work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-gate-"));
  const gate = path.join(dir, "runtime-gate.lock");
  const originalOpen = fs.openSync;
  let attempts = 0;
  let executions = 0;

  const open = spyOn(fs, "openSync").mockImplementation((file, ...args) => {
    if (file === gate && ++attempts === 1) {
      throw Object.assign(new Error("Sharing violation"), { code: "EPERM", syscall: "open" });
    }
    return originalOpen(file, ...args);
  });

  try {
    assert.equal(await withRuntimeLock(dir, () => ++executions), 1);
    assert.equal(attempts, 2);
    assert.equal(fs.existsSync(gate), false);
  } finally {
    open.mockRestore();
    fs.rmSync(gate, { force: true });
    fs.rmdirSync(dir);
  }
});
