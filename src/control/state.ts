import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PRODUCT } from "../shared/product.ts";
import { desiredRuntime,type RuntimeActivation,type RuntimeRelease } from "../shared/runtime-config.ts";

export const runtimeLifecycleSource = () => fs.readFileSync(new URL("./state.js", import.meta.url), "utf8");
export function runtimeDirectory() {
  const configured = process.env[PRODUCT.runtimeEnvironment];
  return configured ? path.resolve(configured) : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), ...PRODUCT.runtimeDirectory)
    : path.join(os.homedir(), ".config", ...PRODUCT.runtimeDirectory.map(value => value.toLowerCase()));
}
const alive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) !== "ESRCH"; }
};

function errorCode(error: unknown): unknown { return typeof error === "object" && error !== null && "code" in error ? error.code : undefined; }
function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

export function parseRuntimeActivation(value: unknown): RuntimeActivation {
  const data = record(value);
  if (typeof data.root !== "string" || !data.root) throw new TypeError("Runtime root is missing");
  for (const key of ["sourceRoot", "linkedAt", "fingerprint", "blockedAutomaticVersion"] as const) if (data[key] !== undefined && typeof data[key] !== "string") throw new TypeError(`Invalid runtime ${key}`);
  if (data.version !== undefined && data.version !== null && typeof data.version !== "string") throw new TypeError("Invalid runtime version");
  for (const key of ["followBranch", "pendingReload", "stateIsolation", "autoUpdate"] as const) if (data[key] !== undefined && typeof data[key] !== "boolean") throw new TypeError(`Invalid runtime ${key}`);
  if (data.channel !== undefined && data.channel !== "development" && data.channel !== "production") throw new TypeError("Invalid runtime channel");
  if (data.generation !== undefined && (!Number.isSafeInteger(data.generation) || Number(data.generation) < 0)) throw new TypeError("Invalid runtime generation");
  if (data.stagedRelease !== undefined && (typeof record(data.stagedRelease).root !== "string" || typeof record(data.stagedRelease).version !== "string")) throw new TypeError("Invalid staged release");
  const activation = data as unknown as RuntimeActivation;
  for (const [name, release] of [["desired", activation.desired], ["fallback", activation.fallback]] as const) {
    if (!release) continue;
    if (typeof release.root !== "string" || !release.root || typeof release.version !== "string" || !release.version || !Number.isSafeInteger(release.contractVersion) || release.contractVersion < 1) throw new TypeError(`Invalid runtime ${name}`);
  }
  const desired: RuntimeRelease = desiredRuntime(activation);
  return { ...activation, schemaVersion: 2, desired, root: desired.root, version: desired.version };
}

// The same short lock protects startup leases and pointer changes. Downloads
// never hold this lock, so starting an agent never waits for an installation.
const RUNTIME_GATE = "runtime-gate.lock";
const LOCK_RETRY_MAX_MS = 50;

export async function withRuntimeLock<T>(dir: string, action: () => T | Promise<T>, name = RUNTIME_GATE): Promise<T> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name), deadline = Date.now() + 5000;
  const shortGate = name === RUNTIME_GATE;
  let backoffMs = shortGate ? 4 : LOCK_RETRY_MAX_MS;
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      break;
    } catch (error) {
      const code = errorCode(error);
      // On Windows an exclusive open can race the previous owner's unlink.
      const sharingConflict = process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "EACCES");
      if (code !== "EEXIST" && !sharingConflict) throw error;
      if (code === "EEXIST") {
        try {
          const owner = record(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
          if (!alive(owner.pid)) { fs.unlinkSync(file); continue; }
        } catch { /* The previous owner may still be creating or removing the lock. */ }
      }
      // A short, jittered retry avoids waking every waiting client on the
      // same 50 ms tick when an ordinary admission releases the gate.
      const retryMs = shortGate ? Math.ceil(backoffMs * (0.5 + Math.random() / 2)) : backoffMs;
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(retryMs, remaining)));
      if (Date.now() >= deadline) {
        if (sharingConflict) throw error;
        throw new Error("Runtime update is busy; retry shortly", { cause: error });
      }
      backoffMs = Math.min(backoffMs * 2, LOCK_RETRY_MAX_MS);
    }
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
    return await action();
  }
  finally { fs.closeSync(descriptor); fs.unlinkSync(file); }
}

export function activeRuntimeLeases(dir: string) {
  const directory = path.join(dir, "leases");
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) { count++; continue; }
    const file = path.join(directory, name);
    try {
      if (alive(record((JSON.parse(fs.readFileSync(file, "utf8")) as unknown)).pid)) count++;
      else fs.unlinkSync(file);
    } catch { count++; }
  }
  return count;
}

export async function resolveRuntime(dir: string, lease = true) {
  return withRuntimeLock(dir, () => {
    const activation = parseRuntimeActivation((JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as unknown));
    if (lease) {
      const directory = path.join(dir, "leases");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = path.join(directory, `${process.pid}-${randomUUID()}.json`);
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
      process.once("exit", () => { try { fs.unlinkSync(file); } catch { /* Crashed processes are reaped on the next check. */ } });
    }
    return activation;
  });
}
