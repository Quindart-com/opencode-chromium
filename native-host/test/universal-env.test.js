import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultIpcPath, instanceIpcPath } from "../src/ipc-path.js";
import { profileRegistryDir } from "../src/profile-registry.js";

test("provider-neutral environment names take precedence over legacy aliases", () => {
  const keys = [
    "AGENT_BROWSER_PROFILE_REGISTRY_DIR", "OPENCODE_BROWSER_PROFILE_REGISTRY_DIR",
    "AGENT_BROWSER_IPC_PATH", "OPENCODE_BROWSER_IPC_PATH",
    "AGENT_BROWSER_INSTANCE_IPC_PATH", "OPENCODE_BROWSER_INSTANCE_IPC_PATH",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const neutralDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-browser-neutral-env-"));
  try {
    process.env.AGENT_BROWSER_PROFILE_REGISTRY_DIR = neutralDir;
    process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR = `${neutralDir}-legacy`;
    process.env.AGENT_BROWSER_IPC_PATH = "neutral-ipc";
    process.env.OPENCODE_BROWSER_IPC_PATH = "legacy-ipc";
    process.env.AGENT_BROWSER_INSTANCE_IPC_PATH = "neutral-instance";
    process.env.OPENCODE_BROWSER_INSTANCE_IPC_PATH = "legacy-instance";
    assert.equal(profileRegistryDir(), neutralDir);
    assert.equal(defaultIpcPath(), "neutral-ipc");
    assert.equal(instanceIpcPath(), "neutral-instance");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(neutralDir, { recursive: true, force: true });
  }
});
