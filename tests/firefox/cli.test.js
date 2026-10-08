import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { runFirefoxCommand, firefoxHealth } from "../../src/cli/firefox.js";

test("Firefox setup verifies the registered browser and health distinguishes reachability from identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefox-cli-"));
  const previous = { runtime: process.env.OPENCODE_BROWSER_RUNTIME_DIR, registry: process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR, legacy: process.env.AGENT_BROWSER_PROFILE_REGISTRY_DIR };
  process.env.OPENCODE_BROWSER_RUNTIME_DIR = root; process.env.OPENCODE_BROWSER_PROFILE_REGISTRY_DIR = root; delete process.env.AGENT_BROWSER_PROFILE_REGISTRY_DIR;
  const server = net.createServer(socket => socket.end());
  try {
    await expect(runFirefoxCommand(["configure", "--profile", "missing", "--port", "9223"])).rejects.toThrow("Connect the Firefox extension");
    const registration = { profileId: "fixture", ipcPath: "fixture", browserName: "Chrome" };
    fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(registration));
    await expect(runFirefoxCommand(["configure", "--profile", "fixture", "--port", "9223"])).rejects.toThrow("not registered");
    registration.browserName = "LibreWolf"; fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(registration));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const args = ["configure", "--profile", "fixture", "--port", String(server.address().port)];
    await runFirefoxCommand([...args, "--dry-run"]);
    expect((await firefoxHealth("fixture")).configured).toBe(false);
    await runFirefoxCommand(args);
    const health = await firefoxHealth("fixture"); expect(health.reachable).toBe(true); expect(health.identityVerified).toBe(false);
    await new Promise(resolve => server.close(resolve));
    expect((await firefoxHealth("fixture")).reachable).toBe(false);
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const [name, value] of [["OPENCODE_BROWSER_RUNTIME_DIR", previous.runtime], ["OPENCODE_BROWSER_PROFILE_REGISTRY_DIR", previous.registry], ["AGENT_BROWSER_PROFILE_REGISTRY_DIR", previous.legacy]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
