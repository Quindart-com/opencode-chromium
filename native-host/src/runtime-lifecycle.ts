import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeActivation } from "../../src/shared/runtime-config.ts";

export const runtimeLifecycleSource = () => fs.readFileSync(new URL("../dist/runtime-lifecycle.js", import.meta.url), "utf8");
export function runtimeDirectory() {
  return process.env.OPENCODE_BROWSER_RUNTIME_DIR ? path.resolve(process.env.OPENCODE_BROWSER_RUNTIME_DIR) :
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "OpenCode/browser") : path.join(os.homedir(), ".config/opencode/browser");
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
  for (const key of ["sourceRoot", "linkedAt", "fingerprint"] as const) if (data[key] !== undefined && typeof data[key] !== "string") throw new TypeError(`Invalid runtime ${key}`);
  if (data.version !== undefined && data.version !== null && typeof data.version !== "string") throw new TypeError("Invalid runtime version");
  for (const key of ["followBranch", "pendingReload", "stateIsolation", "autoUpdate"] as const) if (data[key] !== undefined && typeof data[key] !== "boolean") throw new TypeError(`Invalid runtime ${key}`);
  if (data.channel !== undefined && data.channel !== "development" && data.channel !== "production") throw new TypeError("Invalid runtime channel");
  return data as unknown as RuntimeActivation;
}

// The same short lock protects startup leases and pointer changes. Downloads
// never hold this lock, so starting an agent never waits for an installation.
export async function withRuntimeLock<T>(dir: string, action: () => T | Promise<T>, name = "runtime-gate.lock"): Promise<T> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name), deadline = Date.now() + 5000;
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try { if (!alive(record((JSON.parse(fs.readFileSync(file, "utf8")) as unknown)).pid)) { fs.unlinkSync(file); continue; } } catch { /* Another writer may be creating the lock. */ }
      if (Date.now() >= deadline) throw new Error("Runtime update is busy; retry shortly", { cause: error });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); }
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
