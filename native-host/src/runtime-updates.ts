import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { RuntimeActivation } from "../../src/shared/runtime-config.ts";
import { record } from "../../src/shared/values.ts";
import { FrameDecoder,writeFrame } from "./framing.ts";
import { runProcess } from "./process-effect.ts";
import type { ProfileRegistration } from "./profile-registry.ts";
import { activeRuntimeLeases,parseRuntimeActivation,withRuntimeLock } from "./runtime-lifecycle.ts";

const read = (file: string): Record<string, unknown> | null => { try { return record((JSON.parse(fs.readFileSync(file, "utf8")) as unknown)); } catch { return null; } };
const activationAt = (file: string): RuntimeActivation | null => { try { return parseRuntimeActivation(read(file)); } catch { return null; } };
export interface UpdateState { state?: string; targetVersion?: string; retryAt?: number; reason?: string; checkedAt?: number }
const updateAt = (file: string): UpdateState => {
  const value = read(file);
  return { state: typeof value?.state === "string" ? value.state : undefined, targetVersion: typeof value?.targetVersion === "string" ? value.targetVersion : undefined,
    retryAt: typeof value?.retryAt === "number" ? value.retryAt : undefined, reason: typeof value?.reason === "string" ? value.reason : undefined,
    checkedAt: typeof value?.checkedAt === "number" ? value.checkedAt : undefined };
};
export function probeRuntimeActivity(profile: Pick<ProfileRegistration, "ipcPath" | "hostPid">) {
  return new Promise<boolean>(resolve => {
    const socket = net.createConnection(profile.ipcPath);
    const finish = (busy: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(busy); };
    const timer = setTimeout(() => finish(true), 1500);
    const decoder = new FrameDecoder({ onMessage: message => { const result = record(record(message).result); finish(!Object.keys(result).length || Number(result.clients) > 0 || Number(result.pending) > 0); } });
    socket.on("connect", () => { void writeFrame(socket, { jsonrpc: "2.0", id: 1, method: "runtime.activity", params: {} }).catch(() => finish(true)); });
    socket.on("data", chunk => { try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch { finish(true); } });
    socket.on("error", () => {
      if (profile.hostPid === null) { finish(true); return; }
      try { process.kill(profile.hostPid, 0); finish(true); } catch (error) { finish(record(error).code !== "ESRCH"); }
    });
  });
}
function write(file: string, value: object) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export const releaseVersion = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(value);
export function newerRelease(first: unknown, second: unknown) {
  if (!releaseVersion(first) || !releaseVersion(second)) return false;
  const a = first.split(".").map(Number), b = second.split(".").map(Number);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return (a[index] ?? 0) > (b[index] ?? 0);
  return false;
}
export const packagedRuntime = (root: string): boolean => !fs.existsSync(path.join(root, "src")) && !fs.existsSync(path.join(root, ".git"));
export function validateRelease(root: string, version: string) {
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
async function run(args: readonly string[], cwd: string, timeout = 180000): Promise<void> {
  const executable = process.versions.bun ? (process.env.PATH ?? "").split(path.delimiter)
    .map(directory => path.join(directory, process.platform === "win32" ? "node.exe" : "node"))
    .find(file => fs.existsSync(file)) : process.execPath;
  if (!executable) throw new Error("Node.js and npm are required for automatic updates");
  await runProcess(executable, args, { cwd, timeoutMs: timeout });
}
export async function installRelease(stage: string, version: string) {
  fs.writeFileSync(path.join(stage, "package.json"), '{"private":true}\n');
  await run([npmCli(), "install", "--prefix", stage, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--registry=https://registry.npmjs.org", `opencode-chromium@${version}`], stage);
  const root = path.join(stage, "node_modules/opencode-chromium");
  validateRelease(root, version);
  await run([path.join(root, "dist/cli/index.js"), "version"], root, 15000);
}

export function createRuntimeUpdater({ dir, install = installRelease, now = Date.now, busy = async () => false }: { dir: string; install?: typeof installRelease; now?: () => number; busy?: () => Promise<boolean> }) {
  const manifestFile = path.join(dir, "runtime.json"), statusFile = path.join(dir, "update-status.json");
  let running: Promise<void>|null = null;
  function status() {
    const activation = activationAt(manifestFile);
    const supported = !!activation?.root && !activation.followBranch && packagedRuntime(activation.root);
    return { supported, enabled: supported && activation?.autoUpdate !== false, installedVersion: activation?.version ?? null,
      ...(updateAt(statusFile) ?? {}), ...(!supported ? { state: "manual", reason: "Development or unmanaged installation; run setup from a published package." } : {}) };
  }
  async function configure(enabled: boolean) {
    if (typeof enabled !== "boolean") throw new Error("Expected an update preference");
    await withRuntimeLock(dir, () => {
      const activation = activationAt(manifestFile); if (!activation) throw new Error("Run setup first");
      write(manifestFile, { ...activation, autoUpdate: enabled });
    });
    return status();
  }
  const save = (value: UpdateState): void => write(statusFile, { ...value, checkedAt: now() });
  function schedule(target: unknown) {
    if (releaseVersion(target) && status().enabled && newerRelease(target, activationAt(manifestFile)?.version) && updateAt(statusFile)?.targetVersion !== target) save({ state: "waiting", targetVersion: target });
  }
  async function tick(target: unknown) {
    if (running) return running;
    running = check(target).catch(() => { /* Update failures never interrupt browsing. */ }).finally(() => { running = null; });
    return running;
  }
  async function check(target: unknown) {
    if (!releaseVersion(target) || !status().enabled) return;
    const initial = activationAt(manifestFile);
    if (!initial || !newerRelease(target, initial.version)) return;
    const last = updateAt(statusFile);
    if (last?.targetVersion === target && (last.retryAt ?? 0) > now()) return;
    await withRuntimeLock(dir, async () => {
      // This long-lived worker lock is separate from the short launch gate.
      const browsersBusy = await busy();
      const allowed = await withRuntimeLock(dir, () => !activeRuntimeLeases(dir) && !browsersBusy);
      if (!allowed) { save({ state: "waiting", targetVersion: target }); return; }
      const destination = path.join(dir, "releases", target), root = path.join(destination, "node_modules/opencode-chromium");
      const stage = path.join(dir, `update-stage-${randomUUID()}`);
      try {
        const current = activationAt(manifestFile);
        if (!current || current.root !== initial.root || current.autoUpdate === false || current.followBranch) return;
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
          const activation = activationAt(manifestFile);
          if (!activation || activation.root !== initial.root || activation.autoUpdate === false || activation.followBranch || !newerRelease(target, activation.version)) return;
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

export function createIdleUpdateCheck({ updater, nativeVersion, target, active, canReconnect, retire, now = Date.now }: { updater: ReturnType<typeof createRuntimeUpdater>; nativeVersion: string; target(): string | null | undefined; active(): boolean; canReconnect(): Promise<boolean>; retire(): void; now?: () => number }) {
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
