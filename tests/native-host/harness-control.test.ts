import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { harnessControls,refreshHarnessControl,startHarnessControl } from "../../native-host/src/harness-control.ts";
import { reconnectHarness } from "../../src/management/harness-reconnect.ts";
import { createAgentBrowserRuntime } from "../../src/core/runtime.ts";
import { trackRuntime } from "../../src/adapters/runtime-activity.ts";

test("reconnect refreshes only the selected harness's plugin and preserves the other links", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-controls-")), counts = { codex: 0, opencode: 0, dsh: 0 };
  const controls = [];
  try {
    for (const harness of ["codex", "opencode", "dsh"] as const) controls.push(await startHarnessControl({ harness, version: "1.10.1", dir, idle: () => true, reload: async () => { counts[harness]++; } }));
    expect(harnessControls(dir)).toHaveLength(3);
    expect(await reconnectHarness("codex", dir)).toMatchObject({ ok: true, code: "refreshed", refreshed: 1 });
    expect(counts).toEqual({ codex: 1, opencode: 0, dsh: 0 });
    const row = harnessControls(dir).find(value => value.harness === "codex")!;
    expect(await refreshHarnessControl({ ...row, token: randomUUID() }, 200)).toMatchObject({ ok: false, code: "unreachable" });
    expect(await refreshHarnessControl({ ...row, socket: "unowned-socket" })).toMatchObject({ code: "invalid_link" });
    expect(counts.codex).toBe(1);
    await expect(reconnectHarness("unknown", dir)).rejects.toThrow("Unknown harness");
  } finally { for (const control of controls) control.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test("an active browser call or approval blocks plugin refresh; retained tabs do not need to close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-controls-")), runtime = createAgentBrowserRuntime(), activity = trackRuntime(runtime);
  const otherRuntime = createAgentBrowserRuntime(), otherActivity = trackRuntime(otherRuntime);
  let calls = 0, release = () => {};
  const control = await startHarnessControl({ harness: "dsh", version: "1.10.1", dir, idle: () => activity.reconnectIdle(), reload: async () => { calls++; } });
  try {
    const running = otherActivity.call(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await reconnectHarness("dsh", dir)).toMatchObject({ code: "busy" }); expect(calls).toBe(0);
    release(); await running;
    const approval = otherRuntime.approvalResult({ steps: [{ action: "click", target: { selector: "#save" } }] }, "test", ["review"]);
    expect(await reconnectHarness("dsh", dir)).toMatchObject({ code: "busy" }); expect(calls).toBe(0);
    otherRuntime.takeApproval(approval.approvalToken);
    runtime.getSession("retained-tabs");
    expect(await reconnectHarness("dsh", dir)).toMatchObject({ code: "refreshed" }); expect(calls).toBe(1);
    expect(runtime.sessions.has("retained-tabs")).toBe(true);
  } finally { release(); control.close(); runtime.close(); activity.close(); otherRuntime.close(); otherActivity.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
