import fs from "node:fs";
import path from "node:path";
import { desiredRuntime,selectDesiredRuntime,type RuntimeRelease } from "../shared/runtime-config.ts";
import { atomicJson } from "./leases.ts";
import { parseRuntimeActivation,withRuntimeLock } from "./state.ts";

function releaseContract(root: string): number {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { toolContractVersion?: number };
    return Number.isSafeInteger(pkg.toolContractVersion) && Number(pkg.toolContractVersion) > 0 ? Number(pkg.toolContractVersion) : 1;
  } catch { return 1; }
}

/** Publish a validated desired target. Existing leases stay pinned. */
export async function activateRelease(dir: string, next: { root: string; version: string; contractVersion?: number }, _busy: () => Promise<boolean> = async () => false, _verifiedProfiles: () => readonly string[] = () => [], preparing: () => void = () => {}, reconnectHosts: () => Promise<void> = async () => {}) {
  const file = path.join(dir, "runtime.json");
  const activated = await withRuntimeLock(dir, () => {
    const current = parseRuntimeActivation(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
    if (current.autoUpdate === false || current.followBranch) return false;
    const previous = desiredRuntime(current);
    if (previous.root === next.root && previous.version === next.version) return true;
    const desired: RuntimeRelease = { root: next.root, version: next.version,
      contractVersion: next.contractVersion ?? releaseContract(next.root), installedAt: new Date().toISOString(), activatedAt: new Date().toISOString() };
    preparing();
    atomicJson(file, selectDesiredRuntime(current, desired, previous));
    return true;
  });
  if (activated) await reconnectHosts();
  return activated;
}

export async function rollbackRelease(dir: string) {
  const file = path.join(dir, "runtime.json");
  return withRuntimeLock(dir, () => {
    const current = parseRuntimeActivation(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
    if (!current.fallback) return { ok: false, code: "fallback_unavailable" };
    const desired = desiredRuntime(current);
    atomicJson(file, selectDesiredRuntime(current, { ...current.fallback, activatedAt: new Date().toISOString() }, desired));
    return { ok: true, code: "rollback_started", version: current.fallback.version };
  });
}
