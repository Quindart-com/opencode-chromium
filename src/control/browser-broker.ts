import { spawn,type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FrameDecoder,writeFrame } from "../shared/node-framing.ts";
import { PRODUCT } from "../shared/product.ts";
import { desiredRuntime,type RuntimeRelease } from "../shared/runtime-config.ts";
import { record } from "../shared/values.ts";
import { controlToken } from "./auth.ts";
import { createController } from "./controller.ts";
import { createParticipant } from "./leases.ts";
import { reconcileRuntimeState } from "./reconcile.ts";
import { parseRuntimeActivation } from "./state.ts";

type RpcId = string | number;
type RpcMessage = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

export async function runBrowserBroker(dir: string) {
  const controller = createController({ dir });
  const reconciliationToken = controlToken(dir);
  const selected = (): RuntimeRelease => desiredRuntime(parseRuntimeActivation(JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as unknown));
  let release = selected(), child: ChildProcessWithoutNullStreams | null = null, closing = false, swapping = false, maintenanceRunning = false, extensionVersion: string | null = null, lastMaintenanceAt = 0;
  const extensionRequests = new Set<RpcId>(), childRequests = new Set<RpcId>(), profileHelloRequests = new Set<RpcId>();
  const probes = new Map<string, { resolve(value: Record<string, unknown> | null): void; timer: ReturnType<typeof setTimeout> }>();
  const lease = createParticipant(dir, "host", release.version, release.root, { contractVersion: release.contractVersion, harness: "browser" });

  const sendExtension = (message: unknown) => writeFrame(process.stdout, message);
  const sendChild = (message: unknown) => {
    if (!child?.stdin.writable) throw Object.assign(new Error("Browser worker is restarting"), { code: "worker_restarting" });
    return writeFrame(child.stdin, message);
  };

  function failForwarded(message = "Browser worker restarted; retry the request") {
    for (const id of extensionRequests) {
      void sendExtension({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message,
          data: { code: "worker_restarted", retryable: true, uncertain: false },
        },
      });
    }
    extensionRequests.clear(); childRequests.clear(); profileHelloRequests.clear();
  }

  function startWorker(next = selected()) {
    release = next;
    const entry = path.join(release.root, "native-host", "dist", "runtime.js");
    if (!fs.statSync(entry).isFile()) throw new Error("Desired browser worker is incomplete");
    const worker = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, [PRODUCT.runtimeEnvironment]: dir } });
    child = worker;
    lease.publish({ root: release.root,version: release.version,contractVersion: release.contractVersion,desiredVersion: release.version,draining: false });
    const output = new FrameDecoder({ onMessage: value => {
      const message = record(value) as RpcMessage;
      if (typeof message.id === "string" && probes.has(message.id) && !message.method) {
        const probe = probes.get(message.id)!; probes.delete(message.id); clearTimeout(probe.timer); probe.resolve(record(message.result)); return;
      }
      const profileHello = message.id !== undefined && !message.method && profileHelloRequests.delete(message.id);
      if (profileHello && !message.error) {
        value = { ...message,result: { ...record(message.result),reconciliationToken } };
      }
      if (message.id !== undefined && !message.method) extensionRequests.delete(message.id);
      if (message.id !== undefined && message.method) childRequests.add(message.id);
      void sendExtension(value).catch(() => shutdown());
    } });
    worker.stdout.on("data", chunk => { try { output.push(chunk); } catch { worker.kill(); } });
    worker.stderr.on("data", chunk => process.stderr.write(chunk));
    worker.once("error", error => process.stderr.write(`[controller] browser worker failed: ${error.message}\n`));
    worker.once("exit", () => {
      if (child !== worker) return;
      child = null;
      failForwarded();
      for (const probe of probes.values()) { clearTimeout(probe.timer); probe.resolve(null); } probes.clear();
      if (!closing) { try { startWorker(selected()); } catch (error) { process.stderr.write(`[controller] ${error instanceof Error ? error.message : String(error)}\n`); shutdown(); } }
    });
  }

  async function control(method: string, params: Record<string, unknown>) {
    if (method === "runtime.updateNow") method = "control.update";
    if (method === "runtime.actionStatus") method = "control.job";
    if (method === "connections.reconnect") method = "control.reconnect";
    if (method === "connections.diagnose") method = "control.diagnose";
    if (method === "runtime.updateConfigure") method = "control.configure";
    if (method === "runtime.updateStatus") {
      const status = controller.status({ extensionVersion });
      return { supported: true,enabled: status.enabled,state: status.state,targetVersion: status.staged?.version ?? status.desired.version,
        installedVersion: status.desired.version,stagedVersion: status.staged?.version,loadedVersions: status.components.filter(item => item.component === "active-worker").map(item => item.version).filter(Boolean),
        blockerCount: status.blockerCount,reason: status.reason,components: status.components,controllerVersion: status.components.find(item => item.component === "controller")?.version };
    }
    return controller.handle(method, { ...params,extensionVersion });
  }

  const legacyControl = new Set(["runtime.updateNow", "runtime.actionStatus", "runtime.updateStatus", "runtime.updateConfigure", "connections.reconnect", "connections.diagnose"]);
  async function route(value: unknown) {
    const message = record(value) as RpcMessage;
    if (message.method === "profile.hello") {
      if (message.id !== undefined) profileHelloRequests.add(message.id);
      if (typeof record(message.params).extensionVersion === "string") extensionVersion = String(record(message.params).extensionVersion);
    }
    if (message.id !== undefined && !message.method) childRequests.delete(message.id);
    if (message.method && (message.method.startsWith("control.") || legacyControl.has(message.method))) {
      if (message.id === undefined) return;
      try {
        const result = await control(message.method, message.params ?? {});
        if (result === undefined) throw Object.assign(new Error(`Control method not found: ${message.method}`), { code: "method_not_found" });
        await sendExtension({ jsonrpc: "2.0",id: message.id,result });
      } catch (error) {
        const fields = record(error);
        await sendExtension({ jsonrpc: "2.0",id: message.id,error: { code: -32000,message: error instanceof Error ? error.message : String(error),data: { code: fields.code ?? "control_failed",retryable: fields.retryable === true } } });
      }
      return;
    }
    if (message.id !== undefined && message.method) extensionRequests.add(message.id);
    await sendChild(value);
  }

  function probe(): Promise<Record<string, unknown> | null> {
    if (!child || extensionRequests.size || childRequests.size) return Promise.resolve(null);
    const id = `controller-${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { probes.delete(id); resolve(null); }, 2000);
      probes.set(id, { resolve,timer });
      void sendChild({ jsonrpc: "2.0",id,method: "runtime.activity",params: {} }).catch(() => { clearTimeout(timer); probes.delete(id); resolve(null); });
    });
  }

  async function reconcile() {
    if (swapping || closing) return;
    if (!maintenanceRunning && Date.now() - lastMaintenanceAt >= 60000) {
      lastMaintenanceAt = Date.now(); maintenanceRunning = true;
      void reconcileRuntimeState(dir).catch(() => {}).finally(() => { maintenanceRunning = false; });
    }
    const desired = selected();
    lease.publish({ desiredVersion: desired.version,draining: desired.root !== release.root });
    if (desired.root === release.root) return;
    swapping = true;
    try {
      const activity = await probe();
      if (activity?.extensionIdle !== true || Number(activity.clients ?? 0) > 0 || Number(activity.unmanaged ?? 0) > 0 || Number(activity.pending ?? 0) > 0) return;
      const previous = child;
      if (!previous) return;
      child = null;
      previous.kill("SIGTERM");
      startWorker(desired);
    } finally { swapping = false; }
  }

  const input = new FrameDecoder({ onMessage: value => { void route(value).catch(error => { process.stderr.write(`[controller] ${String(error)}\n`); shutdown(); }); } });
  const timer = setInterval(() => { void reconcile(); }, 5000); timer.unref();
  function shutdown() {
    if (closing) return; closing = true; clearInterval(timer); child?.kill("SIGTERM"); child = null; lease.close();
  }
  startWorker(release);
  process.stdin.on("data", chunk => {
    try {
      if (typeof chunk !== "string") input.push(chunk);
    } catch {
      shutdown();
      process.exitCode = 1;
      process.stdin.destroy();
    }
  });
  process.stdin.on("end", shutdown);
  process.once("SIGTERM", () => { shutdown(); process.exit(0); });
  process.once("SIGINT", () => { shutdown(); process.exit(0); });
  process.once("exit", shutdown);
}
