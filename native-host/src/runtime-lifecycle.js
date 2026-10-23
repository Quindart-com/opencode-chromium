import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const runtimeLifecycleSource = () => fs.readFileSync(new URL(import.meta.url), "utf8");
export function runtimeDirectory() {
  return process.env.OPENCODE_BROWSER_RUNTIME_DIR ? path.resolve(process.env.OPENCODE_BROWSER_RUNTIME_DIR) :
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "OpenCode/browser") : path.join(os.homedir(), ".config/opencode/browser");
}
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};

// The same short lock protects startup leases and pointer changes. Downloads
// never hold this lock, so starting an agent never waits for an installation.
export async function withRuntimeLock(dir, action, name = "runtime-gate.lock") {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name), deadline = Date.now() + 5000;
  let descriptor;
  for (;;) {
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (!alive(JSON.parse(fs.readFileSync(file, "utf8")).pid)) { fs.unlinkSync(file); continue; } } catch { /* Another writer may be creating the lock. */ }
      if (Date.now() >= deadline) throw new Error("Runtime update is busy; retry shortly", { cause: error });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(file); }
}

export function activeRuntimeLeases(dir) {
  const directory = path.join(dir, "leases");
  if (!fs.existsSync(directory)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) { count++; continue; }
    const file = path.join(directory, name);
    try {
      if (alive(JSON.parse(fs.readFileSync(file, "utf8")).pid)) count++;
      else fs.unlinkSync(file);
    } catch { count++; }
  }
  return count;
}

export async function resolveRuntime(dir, lease = true) {
  return withRuntimeLock(dir, () => {
    const activation = JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8"));
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
