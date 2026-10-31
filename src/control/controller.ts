import fs from "node:fs";
import path from "node:path";
import { CONTROL_METHODS,type ComponentVersion,type ControlCapabilities,type ControlStatus } from "../shared/control-protocol.ts";
import { CONTROL_PROTOCOL_VERSION } from "../shared/product.ts";
import { desiredRuntime } from "../shared/runtime-config.ts";
import { validVersion } from "../shared/semver.ts";
import { record } from "../shared/values.ts";
import { harnessControls } from "./harness-control.ts";
import { createControlJobs } from "./jobs.ts";
import { participants,processAlive } from "./leases.ts";
import { parseRuntimeActivation } from "./state.ts";
import { createRuntimeUpdater } from "./update.ts";

export interface ControllerMetadata { protocolVersion: 2; controllerVersion: string; globalCliVersion: string | null; installedAt: string }
export function controllerMetadata(dir: string): ControllerMetadata {
  try {
    const value = record(JSON.parse(fs.readFileSync(path.join(dir, "controller.json"), "utf8")) as unknown);
    return { protocolVersion: 2, controllerVersion: validVersion(value.controllerVersion) ? value.controllerVersion : "0.0.0",
      globalCliVersion: validVersion(value.globalCliVersion) ? value.globalCliVersion : null,
      installedAt: typeof value.installedAt === "string" ? value.installedAt : new Date(0).toISOString() };
  } catch { return { protocolVersion: 2,controllerVersion: "0.0.0",globalCliVersion: null,installedAt: new Date(0).toISOString() }; }
}

export function createController({ dir }: { dir: string }) {
  const jobs = createControlJobs({ dir });
  const updater = createRuntimeUpdater({ dir });
  const capabilities: ControlCapabilities = { protocolVersion: CONTROL_PROTOCOL_VERSION,methods: CONTROL_METHODS,activation: "blue-green",majorUpgradeApproval: true,rollback: true };

  function status(params: Record<string, unknown> = {}): ControlStatus {
    const activation = parseRuntimeActivation(JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as unknown);
    const desired = desiredRuntime(activation), update = updater.status();
    const meta = controllerMetadata(dir);
    const components: ComponentVersion[] = [
      { component: "extension",version: validVersion(params.extensionVersion) ? params.extensionVersion : null,state: validVersion(params.extensionVersion) ? "current" : "unknown" },
      { component: "global-cli",version: meta.globalCliVersion,state: meta.globalCliVersion === desired.version ? "current" : meta.globalCliVersion ? "draining" : "unknown" },
      { component: "controller",version: meta.controllerVersion,state: "current" },
      { component: "desired-runtime",version: desired.version,state: update.state === "approval_required" ? "approval_required" : update.state === "retry" ? "failed" : "current" },
    ];
    try {
      for (const worker of participants(dir).filter(row => processAlive(row.pid))) components.push({ component: "active-worker",version: worker.version,
        state: worker.version === desired.version ? "current" : "draining",label: worker.kind });
      for (const harness of harnessControls(dir)) components.push({ component: "harness-adapter",version: harness.version,
        state: harness.version === desired.version ? "current" : "draining",label: harness.harness });
    } catch { components.push({ component: "active-worker",version: null,state: "unknown" }); }
    return { supported: true,protocolVersion: 2,enabled: update.enabled,state: update.state ?? "ready",desired,fallback: activation.fallback ?? null,
      staged: activation.stagedRelease ? { ...activation.stagedRelease,contractVersion: desired.contractVersion } : null,components,
      jobs: jobs.status() as ControlStatus["jobs"],blockerCount: Number(record(update).blockerCount ?? 0),...(update.reason ? { reason: update.reason } : {}) };
  }

  async function handle(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === "control.capabilities") return capabilities;
    if (method === "control.status") return status(params);
    if (method === "control.update") return jobs.start("update", { approvedMajor: params.approvedMajor === true });
    if (method === "control.job") return jobs.status(typeof params.id === "string" ? params.id : undefined);
    if (method === "control.rollback") return jobs.start("rollback");
    if (method === "control.reconcile") return jobs.start("reconcile");
    if (method === "control.reconnect") return jobs.start("reconnect", { target: params.target });
    if (method === "control.diagnose") return jobs.start("diagnose");
    if (method === "control.configure") return updater.configure(params.enabled === true);
    return undefined;
  }
  return { capabilities,status,handle };
}
