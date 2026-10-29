import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { browserRequest, closeBrowserClients } from "../../src/browser/client.ts";
import { FrameDecoder, writeFrame } from "../../native-host/src/framing.ts";
import { writeProfileRegistration } from "../../native-host/src/profile-registry.ts";
import { errorDetails } from "../../src/core/failure-context.ts";

async function fixture(run: (profileId: string, calls: string[], legacy: { value: boolean }) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transport-recovery-"));
  const savedRegistry = process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR, savedRuntime = process.env.OPENCODE_BROWSER_RUNTIME_DIR;
  process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR = root; process.env.OPENCODE_BROWSER_RUNTIME_DIR = path.join(root, "runtime");
  const profileId = randomUUID(), calls: string[] = [], legacy = { value: false };
  const ipcPath = process.platform === "win32" ? `\\\\.\\pipe\\recovery-${profileId}` : path.join(root, "host.sock");
  let tabs: Record<string, unknown>[] = [];
  const server = net.createServer(socket => {
    const decoder = new FrameDecoder({ onMessage(input) {
      const message = input as { id: number; method: string; params: Record<string, unknown> }; calls.push(message.method);
      let result: unknown = { tabs: [] };
      if (message.method === "host.status") result = { connected: true, profile: { profileId, profileLabel: "fixture", browserName: "Chromium", ipcPath } };
      if (message.method === "getTabs") result = { tabs };
      if (message.method === "createTab" || message.method === "executeCdp") {
        if (message.method === "createTab") tabs = [{ id: 1, origin: "agent", url: "about:blank", creationRequestId: legacy.value ? undefined : message.params.creationRequestId }, { id: 2, origin: "agent", url: "about:blank", creationRequestId: "another-request" }];
        void writeFrame(socket, { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Timed out waiting for extension response to ${message.method}` } }); return;
      }
      void writeFrame(socket, { jsonrpc: "2.0", id: message.id, result });
    } });
    socket.on("data", chunk => decoder.push(chunk));
  });
  await new Promise<void>(resolve => server.listen(ipcPath, resolve));
  writeProfileRegistration({ profileId, profileLabel: "fixture", browserName: "Chromium", ipcPath });
  try { await run(profileId, calls, legacy); }
  finally {
    closeBrowserClients(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (savedRegistry === undefined) delete process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR; else process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR = savedRegistry;
    if (savedRuntime === undefined) delete process.env.OPENCODE_BROWSER_RUNTIME_DIR; else process.env.OPENCODE_BROWSER_RUNTIME_DIR = savedRuntime;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a real CLI doctor diagnoses a timeout and reconciles only the correlated creation", async () => {
  await fixture(async (profileId, calls) => {
    const result = await browserRequest("createTab", { session_id: "fixture" }, { profileId }) as Record<string, unknown>;
    expect(result.id).toBe(1);
    expect(result.recovery).toMatchObject({ attempted: true, healthy: true, status: "reconciled" });
    expect(calls.filter(method => method === "createTab")).toHaveLength(1);
    expect(calls).toContain("getUserTabs");
  });
}, 15000);

test("legacy extension uncertainty reports doctor results without replaying a mutation", async () => {
  await fixture(async (profileId, calls, legacy) => {
    legacy.value = true;
    try { await browserRequest("createTab", { session_id: "fixture" }, { profileId }); throw Error("Expected timeout"); }
    catch (error) {
      expect(errorDetails(error)).toMatchObject({ uncertain: true, recovery: { healthy: true, attempted: true } });
    }
    expect(calls.filter(method => method === "createTab")).toHaveLength(1);
    let rejected = false;
    try { await browserRequest("executeCdp", {}, { profileId }); }
    catch (error) { rejected = true; expect(String(error)).toContain("Timed out"); }
    expect(rejected).toBe(true);
    expect(calls.filter(method => method === "executeCdp")).toHaveLength(1);
    expect(calls.filter(method => method === "getUserTabs")).toHaveLength(1);
  });
}, 15000);
