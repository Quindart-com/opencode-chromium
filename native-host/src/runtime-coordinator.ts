// Activation must outlive the native host that downloaded the release: that
// host is itself replaced while the global admission gate remains closed.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { activateRelease } from "./runtime-activation.ts";
import { atomicJson,sleep } from "./runtime-participants.ts";
import { readProfileRegistrations } from "./profile-registry.ts";
import { probeRuntimeActivity,queryRuntimeActivity,validateRelease } from "./runtime-updates.ts";

export const runActivationCoordinator: typeof activateRelease = async (dir, next) => {
  const result = path.join(dir, `activation-result-${randomUUID()}.json`);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dir, next.root, next.version, result], { stdio: "ignore", windowsHide: true, detached: true });
  let failed = false;
  child.on("error", () => { failed = true; }); child.unref();
  const deadline = Date.now() + 60000;
  try {
    for (;;) {
      if (fs.existsSync(result)) {
        const value = JSON.parse(fs.readFileSync(result, "utf8")) as { activated?: boolean; error?: string };
        if (value.error) throw new Error(value.error);
        return value.activated === true;
      }
      if (failed || child.exitCode !== null || Date.now() >= deadline) throw new Error("Activation coordinator exited before confirming readiness");
      await sleep(50);
    }
  } finally { fs.rmSync(result, { force: true }); }
};

async function coordinate(dir: string, root: string, version: string, resultFile: string) {
  const verified = new Set<string>(), expected = new Set<string>();
  const profiles = () => [...readProfileRegistrations(), ...["development", "production"].flatMap(channel => readProfileRegistrations(path.join(dir, "state", channel, "profiles")))];
  const busy = async () => {
    verified.clear();
    for (const profile of profiles()) {
      expected.add(profile.profileId);
      if (await probeRuntimeActivity(profile)) return true;
      verified.add(profile.profileId);
    }
    return false;
  };
  const reconnect = async () => {
    const deadline = Date.now() + 15000;
    const selected = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as { version: string };
    while (Date.now() < deadline) {
      const ready = new Set<string>();
      for (const profile of profiles()) {
        expected.add(profile.profileId);
        const status = await queryRuntimeActivity(profile);
        if (status?.nativeHostVersion === selected.version && status.extensionIdle === true) ready.add(profile.profileId);
      }
      if ([...expected].every(id => ready.has(id))) return;
      await sleep(50);
    }
    throw new Error("Browser hosts did not reconnect to the selected runtime");
  };
  try {
    validateRelease(root, version);
    const activated = await activateRelease(dir, { root, version }, busy, () => [...verified],
      () => atomicJson(path.join(dir, "update-status.json"), { state: "activating", targetVersion: version }), reconnect);
    atomicJson(path.join(dir, "update-status.json"), { state: activated ? "ready" : "waiting", targetVersion: version });
    atomicJson(resultFile, { activated });
  } catch (error) {
    const incompatible = error instanceof Error && /contract|reconnect MCP|supervisor/i.test(error.message);
    atomicJson(path.join(dir, "update-status.json"), { state: incompatible ? "reconnect_required" : "retry", targetVersion: version, retryAt: Date.now() + 6 * 3600000,
      reason: incompatible ? "Run setup and reconnect MCP to adopt this tool contract." : "Activation could not finish. The previous runtime remains selected." });
    atomicJson(resultFile, { error: incompatible ? "MCP contract changed; reconnect MCP" : "Runtime activation failed" });
  }
}
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [dir, root, version, result] = process.argv.slice(2);
  if (!dir || !root || !version || !result) throw new Error("Missing coordinator arguments");
  await coordinate(dir, root, version, result);
}
