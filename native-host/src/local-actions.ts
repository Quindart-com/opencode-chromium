import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { atomicJson,processAlive } from "./runtime-participants.ts";
import { runtimeDirectory,withRuntimeLock } from "./runtime-lifecycle.ts";
import { record } from "../../src/shared/values.ts";
import type { LocalAction,LocalActionKind } from "../../src/shared/local-actions.ts";
import { detectHarnesses } from "../../src/management/harnesses.ts";
import { safeClientVersion } from "../../src/shared/connections.ts";

const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
interface Job extends LocalAction { pid: number }
function readJob(dir: string, id: string): Job | null {
  if (!validId(id)) return null;
  try {
    const row = record(JSON.parse(fs.readFileSync(path.join(dir, "local-actions", id + ".json"), "utf8")) as unknown);
    return row.id === id && ["reconnect", "diagnose", "update"].includes(String(row.kind)) && ["queued", "running", "succeeded", "waiting", "failed"].includes(String(row.state)) &&
      Number.isSafeInteger(row.pid) && Number(row.pid) > 0 && typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) && typeof row.code === "string" &&
      (row.kind !== "reconnect" || ["codex", "opencode", "dsh"].includes(String(row.target))) ? row as unknown as Job : null;
  } catch { return null; }
}
function publicJob(job: Job | null): LocalAction | null {
  if (!job) return null;
  const { id,kind,target,state,code,updatedAt } = job;
  if (["queued", "running"].includes(state) && (!processAlive(job.pid) || Date.now() - updatedAt > 900000)) return { id,kind,target,state: "failed",code: "worker_stopped",updatedAt };
  return { id,kind,target,state,code: /^[a-z_]{1,40}$/.test(code) ? code : "action_failed",updatedAt };
}
export function createLocalActions({ dir = runtimeDirectory(), launch = spawn, cli = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url)) } = {}) {
  const folder = path.join(dir, "local-actions");
  let detectedAt = 0, detected: ReturnType<typeof detectHarnesses> = [];
  function harnesses() {
    if (Date.now() - detectedAt > 30000) { detected = detectHarnesses(undefined, { versions: false }); detectedAt = Date.now(); }
    return (["codex", "opencode", "dsh"] as const).map(harness => {
      const row = detected.find(value => value.id === harness);
      return { harness, installed: row?.detected ?? false, configured: row?.managed ?? false, version: safeClientVersion(row?.version) };
    });
  }
  function status(id?: string) {
    if (id) return publicJob(readJob(dir, id));
    try {
      return fs.readdirSync(folder).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readJob(dir, name.slice(0, -5)))
        .filter((row): row is Job => row !== null).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map(publicJob);
    } catch { return []; }
  }
  async function start(kind: LocalActionKind, target?: unknown) {
    if (!["reconnect", "diagnose", "update"].includes(kind) || kind === "reconnect" && !["codex", "opencode", "dsh"].includes(String(target))) throw new Error("Unknown local action");
    return withRuntimeLock(dir, () => {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      const existing = (status() as LocalAction[]).find(row => row.kind === kind && row.target === target && ["queued", "running"].includes(row.state));
      if (existing) return existing;
      const id = randomUUID(), file = path.join(folder, id + ".json");
      const job: Job = { id,kind, ...(kind === "reconnect" ? { target: target as LocalAction["target"] } : {}), state: "queued", code: "queued", updatedAt: Date.now(), pid: process.pid };
      atomicJson(file, job);
      try {
        const child = launch(process.execPath, [cli, "local-action", "--job", id], { detached: true, windowsHide: true, stdio: "ignore", env: { ...process.env, OPENCODE_BROWSER_RUNTIME_DIR: dir } });
        child.once("error", () => { try { atomicJson(file, { ...job, state: "failed", code: "worker_start_failed", updatedAt: Date.now() }); } catch { /* Status detects a stopped worker too. */ } });
        job.pid = child.pid ?? process.pid; atomicJson(file, job); child.unref();
      } catch { job.state = "failed"; job.code = "worker_start_failed"; atomicJson(file, job); }
      return publicJob(job)!;
    }, "local-actions.lock");
  }
  return { harnesses, status, start };
}
export async function runLocalActionJob(id: string, dir = runtimeDirectory()) {
  const job = await withRuntimeLock(dir, () => readJob(dir, id), "local-actions.lock");
  if (!job || job.pid !== process.pid || !["queued", "running"].includes(job.state)) throw new Error("Local action expired");
  const save = async (state: Job["state"], code: string) => withRuntimeLock(dir, () => {
    job.state = state; job.code = code; job.updatedAt = Date.now(); atomicJson(path.join(dir, "local-actions", id + ".json"), job);
  }, "local-actions.lock");
  await save("running", "running");
  try {
    let result: { ok: boolean; code: string };
    if (job.kind === "reconnect") {
      const { reconnectHarness } = await import("../../src/management/harness-reconnect.ts");
      result = await reconnectHarness(job.target, dir);
    } else if (job.kind === "update") {
      const { installPublishedUpdate } = await import("../../src/management/manual-update.ts");
      result = await installPublishedUpdate(dir);
    } else {
      const { connectionDoctor } = await import("../../src/cli/connection-doctor.ts");
      const connection = await connectionDoctor({ repairRuntime: true });
      result = { ok: connection.ok, code: connection.ok ? "healthy" : "needs_attention" };
    }
    await save(["busy", "waiting_for_harness", "update_waiting"].includes(result.code) ? "waiting" : result.ok ? "succeeded" : "failed", result.code);
  } catch { await save("failed", "action_failed"); }
  return publicJob(job);
}
