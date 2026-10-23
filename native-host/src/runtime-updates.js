import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import { FrameDecoder, writeFrame } from "./framing.js";
import { activeRuntimeLeases, withRuntimeLock } from "./runtime-lifecycle.js";

const read = file => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
export function probeRuntimeActivity(profile) {
  return new Promise(resolve => {
    const socket = net.createConnection(profile.ipcPath);
    const finish = busy => { clearTimeout(timer); socket.destroy(); resolve(busy); };
    const timer = setTimeout(() => finish(true), 1500);
    const decoder = new FrameDecoder({ onMessage: message => finish(!message.result || message.result.clients > 0 || message.result.pending > 0) });
    socket.on("connect", () => { void writeFrame(socket, { jsonrpc: "2.0", id: 1, method: "runtime.activity", params: {} }).catch(() => finish(true)); });
    socket.on("data", chunk => { try { decoder.push(chunk); } catch { finish(true); } });
    socket.on("error", () => {
      try { process.kill(profile.hostPid, 0); finish(true); } catch (error) { finish(error.code !== "ESRCH"); }
    });
  });
}
function write(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export const releaseVersion = value => typeof value === "string" && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value);
export function newerRelease(first, second) {
  if (!releaseVersion(first) || !releaseVersion(second)) return false;
  const a = first.split(".").map(Number), b = second.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
export const packagedRuntime = root => !fs.existsSync(path.join(root, "src")) && !fs.existsSync(path.join(root, ".git"));
export function validateRelease(root, version) {
  const pkg = read(path.join(root, "package.json"));
  if (pkg?.name !== "opencode-chromium" || pkg.version !== version || !packagedRuntime(root)) throw new Error("Invalid release");
  for (const file of ["dist/cli/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "native-host/dist/runtime.js", "extension/manifest.json", "extension-firefox/manifest.json"]) {
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error("Incomplete release");
  }
  for (const folder of ["extension", "extension-firefox"]) if (read(path.join(root, folder, "manifest.json"))?.version !== version) throw new Error("Release version mismatch");
}

function npmCli() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    candidates.push(path.join(directory, "node_modules/npm/bin/npm-cli.js"));
    try { candidates.push(fs.realpathSync(path.join(directory, "npm"))); } catch { /* Try the next installation. */ }
  }
  const file = candidates.find(file => file && path.basename(file) === "npm-cli.js" && fs.existsSync(file));
  if (!file) throw new Error("npm unavailable");
  return file;
}
function run(args, cwd, timeout = 180000) {
  return new Promise((resolve, reject) => {
    // npm is a Node CLI even when the native host runs under Bun.
    const executable = process.versions.bun ? (process.env.PATH ?? "").split(path.delimiter)
      .map(directory => path.join(directory, process.platform === "win32" ? "node.exe" : "node"))
      .find(file => fs.existsSync(file)) : process.execPath;
    if (!executable) { reject(new Error("Node.js and npm are required for automatic updates")); return; }
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Update timed out")); }, timeout);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("Update failed")); });
  });
}
export async function installRelease(stage, version) {
  fs.writeFileSync(path.join(stage, "package.json"), '{"private":true}\n');
  await run([npmCli(), "install", "--prefix", stage, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--registry=https://registry.npmjs.org", `opencode-chromium@${version}`], stage);
  const root = path.join(stage, "node_modules/opencode-chromium");
  validateRelease(root, version);
  await run([path.join(root, "dist/cli/index.js"), "version"], root, 15000);
}

export function createRuntimeUpdater({ dir, install = installRelease, now = Date.now, busy = async () => false }) {
  const manifestFile = path.join(dir, "runtime.json"), statusFile = path.join(dir, "update-status.json");
  let running = null;
  function status() {
    const activation = read(manifestFile);
    const supported = !!activation?.root && !activation.followBranch && packagedRuntime(activation.root);
    return { supported, enabled: supported && activation.autoUpdate !== false, installedVersion: activation?.version ?? null,
      ...(read(statusFile) ?? {}), ...(!supported ? { state: "manual", reason: "Development or unmanaged installation; run setup from a published package." } : {}) };
  }
  async function configure(enabled) {
    if (typeof enabled !== "boolean") throw new Error("Expected an update preference");
    await withRuntimeLock(dir, () => {
      const activation = read(manifestFile); if (!activation) throw new Error("Run setup first");
      write(manifestFile, { ...activation, autoUpdate: enabled });
    });
    return status();
  }
  const save = value => write(statusFile, { ...value, checkedAt: now() });
  function schedule(target) {
    if (status().enabled && newerRelease(target, read(manifestFile)?.version) && read(statusFile)?.targetVersion !== target) save({ state: "waiting", targetVersion: target });
  }
  async function tick(target) {
    if (running) return running;
    running = check(target).catch(() => { /* Update failures never interrupt browsing. */ }).finally(() => { running = null; });
    return running;
  }
  async function check(target) {
    if (!releaseVersion(target) || !status().enabled) return;
    const initial = read(manifestFile);
    if (!newerRelease(target, initial.version)) return;
    const last = read(statusFile);
    if (last?.targetVersion === target && last.retryAt > now()) return;
    await withRuntimeLock(dir, async () => {
      // This long-lived worker lock is separate from the short launch gate.
      const browsersBusy = await busy();
      const allowed = await withRuntimeLock(dir, () => !activeRuntimeLeases(dir) && !browsersBusy);
      if (!allowed) { save({ state: "waiting", targetVersion: target }); return; }
      const destination = path.join(dir, "releases", target), root = path.join(destination, "node_modules/opencode-chromium");
      const stage = path.join(dir, `update-stage-${randomUUID()}`);
      try {
        const current = read(manifestFile);
        if (current?.root !== initial.root || current.autoUpdate === false || current.followBranch) return;
        if (!fs.existsSync(destination)) {
          save({ state: "downloading", targetVersion: target });
          fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
          await install(stage, target);
          validateRelease(path.join(stage, "node_modules/opencode-chromium"), target);
          fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(stage, destination);
        }
        validateRelease(root, target);
        const browsersStillBusy = await busy();
        await withRuntimeLock(dir, () => {
          const activation = read(manifestFile);
          if (activation?.root !== initial.root || activation.autoUpdate === false || activation.followBranch || !newerRelease(target, activation.version)) return;
          if (activeRuntimeLeases(dir) || browsersStillBusy) { save({ state: "waiting", targetVersion: target }); return; }
          write(manifestFile, { ...activation, root, version: target, pendingReload: false });
          save({ state: "ready", targetVersion: target });
        });
      } catch {
        save({ state: "retry", targetVersion: target, retryAt: now() + 6 * 3600000,
          reason: "Release unavailable or installation failed. Retrying later; your current runtime is unchanged." });
      } finally {
        // Only this worker's unique staging directory can be removed. Releases
        // remain immutable, including old versions still imported by an agent.
        if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      }
    }, "update-worker.lock");
  }
  return { status, configure, schedule, tick };
}

export function createIdleUpdateCheck({ updater, nativeVersion, target, active, canReconnect, retire, now = Date.now }) {
  let checking = false, idleSince = now();
  return async () => {
    if (checking || !target()) return;
    checking = true;
    try {
      if (active()) { idleSince = now(); return; }
      if (now() - idleSince < 60000 || !updater.status().enabled) return;
      await updater.tick(target());
      if (!updater.status().enabled || !newerRelease(updater.status().installedVersion, nativeVersion)) return;
      if (await canReconnect() && !active()) retire();
    } catch { /* Neither update failures nor busy profiles interrupt browsing. */ }
    finally { checking = false; }
  };
}
