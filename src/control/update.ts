import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { FrameDecoder,writeFrame } from "../shared/node-framing.ts";
import { PRODUCT } from "../shared/product.ts";
import { desiredRuntime,type RuntimeActivation } from "../shared/runtime-config.ts";
import { isMajorUpgrade,isNewerVersion,validVersion } from "../shared/semver.ts";
import { record } from "../shared/values.ts";
import { activateRelease } from "./activation.ts";
import { atomicJson,participantBusy,participants,processAlive } from "./leases.ts";
import { npmCliFile,npmNode } from "./npm-client.ts";
import { runProcess } from "./process.ts";
import { activeRuntimeLeases,parseRuntimeActivation,withRuntimeLock } from "./state.ts";

interface ProfileRegistration { ipcPath: string; hostPid?: number }

const read = (file: string): Record<string, unknown> | null => { try { return record((JSON.parse(fs.readFileSync(file, "utf8")) as unknown)); } catch { return null; } };
const activationAt = (file: string): RuntimeActivation | null => { try { return parseRuntimeActivation(read(file)); } catch { return null; } };
export interface UpdateState { state?: string; targetVersion?: string; retryAt?: number; reason?: string; checkedAt?: number }
const updateAt = (file: string): UpdateState => {
  const value = read(file);
  return { state: typeof value?.state === "string" ? value.state : undefined, targetVersion: typeof value?.targetVersion === "string" ? value.targetVersion : undefined,
    retryAt: typeof value?.retryAt === "number" ? value.retryAt : undefined, reason: typeof value?.reason === "string" ? value.reason : undefined,
    checkedAt: typeof value?.checkedAt === "number" ? value.checkedAt : undefined };
};
export function queryRuntimeActivity(profile: Pick<ProfileRegistration, "ipcPath" | "hostPid">) {
  return new Promise<Record<string, unknown> | null>(resolve => {
    const socket = net.createConnection(profile.ipcPath);
    const finish = (value: Record<string, unknown> | null): void => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), 1500);
    const decoder = new FrameDecoder({ onMessage: message => finish(record(record(message).result)) });
    socket.on("connect", () => { void writeFrame(socket, { jsonrpc: "2.0", id: 1, method: "runtime.activity", params: {} }).catch(() => finish(null)); });
    socket.on("data", chunk => { try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch { finish(null); } });
    socket.on("error", () => {
      // A dead host alone does not prove that its extension has no retained tabs.
      finish(null);
    });
  });
}
export async function probeRuntimeActivity(profile: Pick<ProfileRegistration, "ipcPath" | "hostPid">) {
  const result = await queryRuntimeActivity(profile);
  return result?.extensionIdle !== true || Number(result?.unmanaged ?? result?.clients) > 0 || Number(result?.pending) > 0;
}
function write(file: string, value: object) {
  atomicJson(file, value);
}
export const releaseVersion = (value: unknown): value is string => validVersion(value) && /^\d+\.\d+\.\d+$/.test(value);
export function newerRelease(first: unknown, second: unknown) {
  return isNewerVersion(first, second);
}
export const packagedRuntime = (root: string): boolean => !fs.existsSync(path.join(root, "src")) && !fs.existsSync(path.join(root, ".git"));
export function validateRelease(root: string, version: string) {
  const pkg = read(path.join(root, "package.json"));
  if (pkg?.name !== PRODUCT.packageName || pkg.version !== version || !packagedRuntime(root)) throw new Error("Invalid release");
  const build = read(path.join(root, "dist/build-manifest.json"));
  if (build?.name !== PRODUCT.packageName || build.version !== version || typeof build.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(build.sha256)) throw new Error("Invalid release manifest");
  for (const file of ["dist/cli/index.js", "dist/adapters/mcp/server.js", "dist/adapters/opencode/index.js", "native-host/dist/runtime.js", "extension/manifest.json", "extension-firefox/manifest.json"]) {
    if (!fs.statSync(path.join(root, file)).isFile()) throw new Error("Incomplete release");
  }
  for (const folder of ["extension", "extension-firefox"]) if (read(path.join(root, folder, "manifest.json"))?.version !== version) throw new Error("Release version mismatch");
  if (pkg.runtimeSupervisorProtocol === 1) for (const file of ["runtime-coordinator.js", "runtime-supervisor.js", "runtime-worker.js", "runtime-participants.js", "runtime-activation.js", "runtime-lifecycle.js"]) {
    if (!fs.statSync(path.join(root, "native-host/dist", file)).isFile()) throw new Error("Incomplete managed runtime");
  }
  if (pkg.runtimeControllerProtocol === 2) for (const file of ["controller.js", "jobs.js", "mcp-supervisor.js", "mcp-worker.js", "state.js", "leases.js", "update.js"]) {
    if (!fs.statSync(path.join(root, "dist/control", file)).isFile()) throw new Error("Incomplete runtime controller");
  }
}

async function run(args: readonly string[], cwd: string, timeout = 180000): Promise<void> {
  await runProcess(npmNode(), args, { cwd, timeoutMs: timeout });
}
export async function installRelease(stage: string, version: string) {
  fs.writeFileSync(path.join(stage, "package.json"), '{"private":true}\n');
  await run([npmCliFile(), "install", "--prefix", stage, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", `${PRODUCT.packageName}@${version}`], stage);
  const root = path.join(stage, `node_modules/${PRODUCT.packageName}`);
  validateRelease(root, version);
  await run([path.join(root, "dist/cli/index.js"), "version"], root, 15000);
}
export async function installGlobalRelease(version: string) {
  if (!releaseVersion(version)) throw new Error("Invalid production release");
  await run([npmCliFile(), "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", PRODUCT.packageName + "@" + version], process.cwd());
}

export function garbageCollectReleases(dir: string, now = Date.now(), graceMs = 7 * 24 * 60 * 60 * 1000) {
  const releases = path.resolve(dir, "releases"), manifest = activationAt(path.join(dir, "runtime.json"));
  if (!manifest || !fs.existsSync(releases)) return [];
  const roots = new Set([desiredRuntime(manifest).root, manifest.fallback?.root].filter((value): value is string => typeof value === "string").map(value => path.resolve(value)));
  let live: string[];
  try { live = participants(dir).filter(row => processAlive(row.pid) && typeof row.root === "string").map(row => path.resolve(row.root!)); }
  catch { return []; }
  const removed: string[] = [];
  for (const entry of fs.readdirSync(releases, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.resolve(releases, entry.name);
    if (path.dirname(candidate) !== releases || [...roots, ...live].some(root => root === candidate || root.startsWith(candidate + path.sep))) continue;
    const stat = fs.statSync(candidate);
    if (now - stat.mtimeMs < graceMs) continue;
    fs.rmSync(candidate, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function createRuntimeUpdater({ dir, install = installRelease, now = Date.now, busy = async () => false, verifiedProfiles = () => [], activate = activateRelease }: { dir: string; install?: typeof installRelease; now?: () => number; busy?: () => Promise<boolean>; verifiedProfiles?: () => readonly string[]; activate?: typeof activateRelease }) {
  const manifestFile = path.join(dir, "runtime.json"), statusFile = path.join(dir, "update-status.json");
  let running: Promise<void>|null = null;
  function status({ includeParticipants = true } = {}) {
    const activation = activationAt(manifestFile);
    const desired = activation ? desiredRuntime(activation) : null;
    const supported = !!desired?.root && !activation?.followBranch && packagedRuntime(desired.root);
    const update = updateAt(statusFile);
    if (update.state === "activating" && activation?.version === update.targetVersion) update.state = "ready";
    const participant = includeParticipants ? participantStatus(desired?.version) : {};
    const loadedVersions = "loadedVersions" in participant && Array.isArray(participant.loadedVersions) ? participant.loadedVersions : [];
    const draining = desired && loadedVersions.some((version: string) => version !== desired.version);
    return { supported, enabled: supported && activation?.autoUpdate !== false, installedVersion: desired?.version ?? null,
      desired: desired ?? null, fallback: activation?.fallback ?? null, stagedVersion: activation?.stagedRelease?.version ?? null, ...participant,
      ...update, ...(draining && ["ready", "activating", "draining"].includes(update.state ?? "") ? { state: "draining" } : {}),
      ...(!supported ? { state: "manual", reason: "Development or unmanaged installation; run setup from a published package." } : {}) };
  }
  function participantStatus(desiredVersion?: string) {
    try { const rows = participants(dir).filter(row => processAlive(row.pid)); return { blockerCount: rows.filter(row => participantBusy(row) && row.version !== desiredVersion).length + activeRuntimeLeases(dir), loadedVersions: [...new Set(rows.map(row => row.version))].sort(), workers: rows.map(row => ({ kind: row.kind, version: row.version, desiredVersion: row.desiredVersion ?? desiredVersion ?? null, draining: row.version !== desiredVersion })) }; }
    catch { return { blockerCount: 1, loadedVersions: [], registryError: true }; }
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
    if (releaseVersion(target) && status({ includeParticipants: false }).enabled && newerRelease(target, activationAt(manifestFile)?.version) && updateAt(statusFile)?.targetVersion !== target) save({ state: "waiting", targetVersion: target });
  }
  async function tick(target: unknown, { manual = false, approvedMajor = false } = {}) {
    if (running) return running;
    running = check(target, manual, approvedMajor).catch(() => { /* Update failures never interrupt browsing. */ }).finally(() => { running = null; });
    return running;
  }
  async function check(target: unknown, manual: boolean, approvedMajor: boolean) {
    const availability = status({ includeParticipants: false });
    if (!releaseVersion(target) || !availability.supported || !manual && !availability.enabled) return;
    const initial = activationAt(manifestFile);
    if (!initial || !newerRelease(target, initial.version) && initial.stagedRelease?.version !== target) return;
    if (isMajorUpgrade(target, initial.version)) {
      const major = Number(target.split(".")[0]);
      if (!approvedMajor && initial.approvedMajor !== major) { save({ state: "approval_required", targetVersion: target, reason: "A major upgrade requires explicit approval." }); return; }
      await withRuntimeLock(dir, () => { const current = activationAt(manifestFile); if (current) write(manifestFile, { ...current, approvedMajor: major }); });
    }
    const last = updateAt(statusFile);
    if (!manual && last?.targetVersion === target && (last.retryAt ?? 0) > now()) return;
    await withRuntimeLock(dir, async () => {
      // This long-lived worker lock is separate from the short launch gate.
      const destination = path.join(dir, "releases", target), root = path.join(destination, `node_modules/${PRODUCT.packageName}`);
      const stage = path.join(dir, `update-stage-${randomUUID()}`);
      try {
        const current = activationAt(manifestFile);
        if (!current || current.root !== initial.root || !manual && current.autoUpdate === false || current.followBranch) return;
        if (!fs.existsSync(destination)) {
          save({ state: "downloading", targetVersion: target });
          fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
          await install(stage, target);
          validateRelease(path.join(stage, `node_modules/${PRODUCT.packageName}`), target);
          fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.renameSync(stage, destination);
        }
        validateRelease(root, target);
        await withRuntimeLock(dir, () => {
          const activation = activationAt(manifestFile);
          if (!activation || activation.root !== initial.root || !manual && activation.autoUpdate === false || activation.followBranch || !newerRelease(target, activation.version)) return;
          write(manifestFile, { ...activation, stagedRelease: { root, version: target } });
        });
        save({ state: "staged", targetVersion: target });
        const activated = await activate(dir, { root, version: target }, busy, verifiedProfiles, () => save({ state: "activating", targetVersion: target }));
        save({ state: activated ? "draining" : "waiting", targetVersion: target });
      } catch (error) {
        if (error instanceof Error && /reconnect|contract|supervisor/i.test(error.message)) {
          save({ state: "reconnect_required", targetVersion: target, retryAt: now() + 6 * 3600000, reason: "This release changes the MCP contract. Run setup and reconnect MCP to adopt it." }); return;
        }
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

export function createIdleUpdateCheck({ updater, nativeVersion, target, active, canReconnect, retire, now = Date.now, quietMs = 60000 }: { updater: ReturnType<typeof createRuntimeUpdater>; nativeVersion: string; target(): string | null | undefined; active(): boolean; canReconnect(): Promise<boolean>; retire(): void; now?: () => number; quietMs?: number }) {
  let checking = false, idleSince = now();
  return async () => {
    if (checking || !target()) return;
    checking = true;
    try {
      if (!updater.status({ includeParticipants: false }).enabled) return;
      await updater.tick(target());
      if (active()) { idleSince = now(); return; }
      if (now() - idleSince < quietMs) return;
      const state = updater.status({ includeParticipants: false });
      if (!state.enabled || !newerRelease(state.installedVersion, nativeVersion)) return;
      if (await canReconnect() && !active()) retire();
    } catch { /* Neither update failures nor busy profiles interrupt browsing. */ }
    finally { checking = false; }
  };
}
