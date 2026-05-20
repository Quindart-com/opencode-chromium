import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BrowserHostRpcError, browserRequest, chooseBrowserProfile, listBrowserProfiles, validateJsonRpcResponse } from "../src/client.js";
import { FrameDecoder, writeFrame } from "../../native-host/src/framing.js";
import { writeProfileRegistration } from "../../native-host/src/profile-registry.js";

test("validates successful JSON-RPC responses", () => {
  const result = validateJsonRpcResponse({ jsonrpc: "2.0", id: 1, result: { ok: true } }, 1, "ping");

  assert.deepEqual(result, { ok: true });
});

test("ignores responses for other request ids", () => {
  const result = validateJsonRpcResponse({ jsonrpc: "2.0", id: 2, result: { ok: true } }, 1, "ping");

  assert.equal(result, null);
});

test("rejects invalid successless responses", () => {
  assert.throws(
    () => validateJsonRpcResponse({ jsonrpc: "2.0", id: 1 }, 1, "ping"),
    /exactly one of result or error/,
  );
});

test("preserves JSON-RPC error details", () => {
  assert.throws(
    () => validateJsonRpcResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom", data: { tabId: 1 } } }, 1, "ping"),
    (error) => error instanceof BrowserHostRpcError && error.code === -32000 && error.data.tabId === 1,
  );
});

test("chooses the only connected browser profile by default", () => {
  assert.deepEqual(chooseBrowserProfile([{ profileId: "profile-a" }]), { profileId: "profile-a" });
});

test("requires explicit selection when multiple browser profiles are connected", () => {
  assert.throws(
    () => chooseBrowserProfile([{ profileId: "profile-a" }, { profileId: "profile-b" }]),
    /Multiple OpenCode Browser profiles/,
  );
});

test("does not fall back when a selected browser profile is disconnected", () => {
  assert.throws(
    () => chooseBrowserProfile([{ profileId: "profile-a" }], "profile-b"),
    /Browser profile is not connected: profile-b/,
  );
});

function testIpcPath(name) {
  if (process.platform === "win32") return `\\\\.\\pipe\\opencode-browser-test-${process.pid}-${name}`;
  return path.join(os.tmpdir(), `opencode-browser-test-${process.pid}-${name}.sock`);
}

function createFakeProfileHost({ profileId, profileLabel }) {
  const ipcPath = testIpcPath(profileId);
  if (process.platform !== "win32") fs.rmSync(ipcPath, { force: true });

  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder({
      onMessage: (message) => {
        if (message.method === "host.status") {
          void writeFrame(socket, {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              connected: true,
              ipcClients: 1,
              startedAt: "2026-01-01T00:00:00.000Z",
              profile: { profileId, profileLabel, browserName: "Chromium", ipcPath },
            },
          });
          return;
        }

        void writeFrame(socket, { jsonrpc: "2.0", id: message.id, result: { method: message.method, profileId } });
      },
    });
    socket.on("data", (chunk) => decoder.push(chunk));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(ipcPath, () => {
      writeProfileRegistration({
        profileId,
        profileLabel,
        browserName: "Chromium",
        ipcPath,
        startedAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
      });
      resolve({
        ipcPath,
        close: () => new Promise((done) => server.close(() => {
          if (process.platform !== "win32") fs.rmSync(ipcPath, { force: true });
          done();
        })),
      });
    });
  });
}

test("discovers and routes to live browser profile hosts", async () => {
  const previousRegistry = process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR;
  const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-browser-registry-test-"));
  process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR = registryDir;
  const host = await createFakeProfileHost({ profileId: "profile-a", profileLabel: "work" });

  try {
    const profiles = await listBrowserProfiles();
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].profileId, "profile-a");
    assert.equal(profiles[0].profileLabel, "work");
    assert.equal(Object.hasOwn(profiles[0], "ipcPath"), false);

    const result = await browserRequest("ping", { profile_id: "profile-a" });
    assert.deepEqual(result, { method: "ping", profileId: "profile-a" });
  } finally {
    await host.close();
    fs.rmSync(registryDir, { recursive: true, force: true });
    if (previousRegistry === undefined) delete process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR;
    else process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR = previousRegistry;
  }
});
