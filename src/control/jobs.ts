import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalAction,LocalActionKind } from "../shared/control-protocol.ts";
import { harnessTargets } from "../shared/harnesses.ts";
import { PRODUCT } from "../shared/product.ts";
import { desiredRuntime } from "../shared/runtime-config.ts";
import { record } from "../shared/values.ts";
import { rollbackRelease } from "./activation.ts";
import { harnessControls,refreshHarnessControl } from "./harness-control.ts";
import { atomicJson,processAlive } from "./leases.ts";
import { npmMetadata } from "./npm-client.ts";
import { runProcess } from "./process.ts";
import { reconcileRuntimeState } from "./reconcile.ts";
import { parseRuntimeActivation,withRuntimeLock } from "./state.ts";
import { createRuntimeUpdater,garbageCollectReleases,installGlobalRelease,releaseVersion } from "./update.ts";

interface Job extends LocalAction { pid: number; approvedMajor?: boolean }
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const kinds: LocalActionKind[] = ["reconnect", "diagnose", "update", "rollback", "reconcile"];

function jobFile(dir: string, id: string) { return path.join(dir, "control-jobs", `${id}.json`); }
function readJob(dir: string, id: string): Job | null {
  if (!validId(id)) return null;
  try {
    const row = record(JSON.parse(fs.readFileSync(jobFile(dir, id), "utf8")) as unknown);
    return row.id === id && kinds.includes(row.kind as LocalActionKind) && ["queued", "running", "succeeded", "waiting", "blocked", "failed"].includes(String(row.state)) &&
      Number.isSafeInteger(row.pid) && Number(row.pid) > 0 && typeof row.updatedAt === "number" && typeof row.code === "string" ? row as unknown as Job : null;
  } catch { return null; }
}

function publicJob(job: Job | null): LocalAction | null {
  if (!job) return null;
  const { id,kind,target,state,updatedAt,details } = job;
  const stale = ["queued", "running"].includes(state) && (!processAlive(job.pid) || Date.now() - updatedAt > 900000);
  return { id,kind,target,state: stale ? "failed" : state,code: stale ? "worker_stopped" : /^[a-z_]{1,40}$/.test(job.code) ? job.code : "action_failed",updatedAt,details };
}

export function createControlJobs({ dir, launch = spawn }: { dir: string; launch?: typeof spawn }) {
  const folder = path.join(dir, "control-jobs");
  function status(id?: string): LocalAction | LocalAction[] | null {
    if (id) return publicJob(readJob(dir, id));
    try { return fs.readdirSync(folder).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readJob(dir, name.slice(0, -5)))
      .filter((row): row is Job => row !== null).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20).map(row => publicJob(row)!); }
    catch { return []; }
  }
  async function start(kind: LocalActionKind, options: { target?: unknown; approvedMajor?: boolean } = {}) {
    if (!kinds.includes(kind) || kind === "reconnect" && !harnessTargets.some(target => target === options.target)) throw Object.assign(new Error("Unknown control action"), { code: "invalid_action" });
    return withRuntimeLock(dir, () => {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const existing = (status() as LocalAction[]).find(row => row.kind === kind && row.target === options.target && ["queued", "running"].includes(row.state));
      if (existing) return existing;
      const id = randomUUID();
      const job: Job = { id,kind, ...(kind === "reconnect" ? { target: options.target as LocalAction["target"] } : {}), approvedMajor: options.approvedMajor === true,
        state: "queued",code: "queued",updatedAt: Date.now(),pid: process.pid };
      atomicJson(jobFile(dir, id), job);
      try {
        const child = launch(process.execPath, [fileURLToPath(import.meta.url), "--run", id, dir], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, [PRODUCT.runtimeEnvironment]: dir } });
        job.pid = child.pid ?? process.pid; atomicJson(jobFile(dir, id), job); child.unref();
      } catch { job.state = "failed"; job.code = "worker_start_failed"; atomicJson(jobFile(dir, id), job); }
      return publicJob(job)!;
    }, "control-jobs.lock");
  }
  return { status,start };
}

async function execute(job: Job, dir: string): Promise<{ state: Job["state"]; code: string; details?: LocalAction["details"] }> {
  if (job.kind === "rollback") { const result = await rollbackRelease(dir); return { state: result.ok ? "succeeded" : "failed",code: result.code }; }
  if (job.kind === "reconcile") {
    const reconciled = await reconcileRuntimeState(dir), removed = garbageCollectReleases(dir);
    const changed = reconciled.removedParticipants + reconciled.releasedSessions + reconciled.removedProfiles + removed.length;
    return { state: "succeeded",code: changed ? "reconciled" : "already_current",details: { blockerCount: reconciled.deferredParticipants } };
  }
  if (job.kind === "diagnose") {
    const status = createRuntimeUpdater({ dir }).status();
    return { state: status.supported ? "succeeded" : "failed",code: status.supported ? "healthy" : "needs_attention" };
  }
  if (job.kind === "reconnect") {
    const link = harnessControls(dir).find(row => row.harness === job.target);
    if (!link) return { state: "waiting",code: "waiting_for_harness" };
    const result = await refreshHarnessControl(link);
    return { state: result.ok ? "succeeded" : result.code === "busy" ? "waiting" : "failed",code: result.code };
  }
  const metadata = record(await npmMetadata());
  if (metadata.name !== PRODUCT.packageName || !releaseVersion(metadata.version)) return { state: "failed",code: "invalid_release" };
  const updater = createRuntimeUpdater({ dir });
  await updater.tick(metadata.version, { manual: true, approvedMajor: job.approvedMajor === true });
  const status = updater.status({ includeParticipants: false });
  if (status.state === "approval_required") return { state: "blocked",code: "major_approval_required",details: { targetVersion: metadata.version } };
  if (["retry", "failed"].includes(status.state ?? "")) return { state: "failed",code: "update_failed",details: { targetVersion: metadata.version } };
  await installGlobalRelease(metadata.version);
  const activation = parseRuntimeActivation(JSON.parse(fs.readFileSync(path.join(dir, "runtime.json"), "utf8")) as unknown);
  const desired = desiredRuntime(activation);
  const cli = path.join(desired.root, "dist", "cli", "index.js");
  if (fs.existsSync(cli)) await runProcess(process.execPath, [cli, "setup", "--all", "--production", "--json"], { cwd: desired.root, timeoutMs: 180000 });
  garbageCollectReleases(dir);
  return { state: "succeeded",code: "updated",details: { targetVersion: metadata.version } };
}

export async function runControlJob(id: string, dir: string) {
  const job = await withRuntimeLock(dir, () => readJob(dir, id), "control-jobs.lock");
  if (!job || job.pid !== process.pid || job.state !== "queued") throw new Error("Control job expired");
  const save = (patch: Partial<Job>) => withRuntimeLock(dir, () => { Object.assign(job, patch, { updatedAt: Date.now() }); atomicJson(jobFile(dir, id), job); }, "control-jobs.lock");
  await save({ state: "running",code: "running" });
  try { await save(await execute(job, dir)); }
  catch (error) { await save({ state: "failed",code: typeof record(error).code === "string" ? String(record(error).code) : "action_failed" }); }
  return publicJob(job);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) && process.argv[2] === "--run") {
  const [, , , id, dir] = process.argv;
  if (!id || !dir) throw new Error("Missing control job arguments");
  await runControlJob(id, dir);
}
