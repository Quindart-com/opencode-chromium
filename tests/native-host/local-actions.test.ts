import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { createLocalActions,runLocalActionJob } from "../../native-host/src/local-actions.ts";
import { startHarnessControl } from "../../native-host/src/harness-control.ts";
import { connectionPanelMessage } from "../../extension-src/entrypoints/background/connection-panel.ts";
import type { NativeRpc } from "../../extension-src/entrypoints/background/native-rpc.ts";

test("UI actions use a detached fixed CLI entry, deduplicate work and report a completed scoped refresh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-actions-")), launches: unknown[][] = [];
  const control = await startHarnessControl({ harness: "codex", version: "1.10.1", dir, idle: () => true, reload: async () => {} });
  const launch = ((...args: unknown[]) => { launches.push(args); return Object.assign(new EventEmitter(), { pid: process.pid, unref() {} }); }) as unknown as typeof spawn;
  try {
    const manager = createLocalActions({ dir, launch, cli: path.join(dir, "fixed-cli.js") });
    const job = await manager.start("reconnect", "codex");
    expect((await manager.start("reconnect", "codex")).id).toBe(job.id);
    expect(launches).toHaveLength(1);
    expect(launches[0]![0]).toBe(process.execPath);
    expect(launches[0]![1]).toEqual([path.join(dir, "fixed-cli.js"), "local-action", "--job", job.id]);
    expect(launches[0]![2]).toMatchObject({ detached: true, windowsHide: true, stdio: "ignore" });
    const completed = await runLocalActionJob(job.id, dir);
    expect(completed).toMatchObject({ state: "succeeded", code: "refreshed", target: "codex" });
    expect(JSON.stringify(manager.status(job.id))).not.toContain("token");
    await expect(manager.start("reconnect", "codex; anything")).rejects.toThrow("Unknown local action");
    await expect(runLocalActionJob("../escape", dir)).rejects.toThrow("expired");
  } finally { control.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("web pages cannot invoke reconnect, diagnostics or installation, while the trusted panel can start a background update during unrelated work", async () => {
  const called: string[] = [];
  const rpc = { idle: () => false, request: async (method: string) => { called.push(method); return { id: "fixture" }; } } as unknown as NativeRpc;
  const dependencies = { rpc, extensionId: "fixture", idle: () => false };
  for (const type of ["START_HARNESS_RECONNECT", "RUN_CONNECTION_DOCTOR", "INSTALL_RUNTIME_UPDATE", "GET_LOCAL_ACTION"]) {
    await expect(connectionPanelMessage({ type }, { id: "fixture", tab: { url: "https://fixture.test" } }, dependencies)).rejects.toThrow("extension panel");
  }
  expect(called).toEqual([]);
  await connectionPanelMessage({ type: "INSTALL_RUNTIME_UPDATE" }, { id: "fixture" }, dependencies);
  expect(called).toEqual(["runtime.updateNow"]);
});

test("a helper that cannot start reports failure instead of staying queued forever", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-actions-"));
  try {
    const manager = createLocalActions({ dir, launch: (() => { throw new Error("fixture failure"); }) as unknown as typeof spawn });
    expect(await manager.start("diagnose")).toMatchObject({ state: "failed", code: "worker_start_failed" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
