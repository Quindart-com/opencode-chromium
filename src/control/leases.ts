// This module is copied alongside the managed supervisor. Keep it dependency-free.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withRuntimeLock } from "./state.ts";

export interface ParticipantState {
  id: string; pid: number; kind: "supervisor" | "runtime" | "host";
  version: string; root?: string; inFlight: number; sessions: string[]; approvals: number;
  contractVersion?: number; desiredVersion?: string; harness?: string; profileId?: string; heartbeatAt?: number; draining?: boolean;
  abandonedAt?: number; approvalExpiresAt?: number;
  prepared?: string; committed?: string; error?: string;
  profiles?: string[];
}
export interface SwitchJournal {
  id: string; pid: number; phase: "preparing" | "committed" | "aborted";
  previous: { root: string; version?: string | null; generation?: number };
  next: { root: string; version: string; generation: number };
}
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function participantActive(row: ParticipantState) { return !row.abandonedAt && processAlive(row.pid); }
export function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    const deadline = Date.now() + 1000;
    for (;;) {
      try { fs.renameSync(temp, file); break; }
      catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw error;
        // Windows scanners and short-lived readers can hold the destination.
        // Never unlink the previous record: readers must see a complete value.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function readJournal(dir: string): SwitchJournal | null {
  const file = path.join(dir, "activation-journal.json");
  if (!fs.existsSync(file)) return null;
  let value: SwitchJournal;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as SwitchJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!value.id || !Number.isSafeInteger(value.pid) || !["preparing", "committed", "aborted"].includes(value.phase) || !value.next?.root || !value.previous?.root) throw new Error("Invalid activation journal");
  return value;
}
export function participants(dir: string): ParticipantState[] {
  const folder = path.join(dir, "participants");
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => name.endsWith(".json")).flatMap(name => {
    let value: ParticipantState;
    try { value = JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")) as ParticipantState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (!value.id || `${value.id}.json` !== name || !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      !["supervisor", "runtime", "host"].includes(value.kind) || !Number.isSafeInteger(value.inFlight) || value.inFlight < 0 ||
      !Array.isArray(value.sessions) || !value.sessions.every(id => typeof id === "string") || !Number.isSafeInteger(value.approvals) || value.approvals < 0) throw new Error("Invalid runtime participant");
    return [value];
  });
}
export function participantBusy(row: ParticipantState) { return row.inFlight > 0 || row.sessions.length > 0 || row.approvals > 0; }
// Reap only after every extension has independently confirmed that no session remains.
export function reapParticipants(dir: string, verifiedProfiles: readonly string[] = []) {
  for (const row of participants(dir)) {
    const independentlyIdle = row.inFlight === 0 && row.approvals === 0 && !!row.profiles?.length && row.profiles.every(id => verifiedProfiles.includes(id));
    if (!participantActive(row) && (!participantBusy(row) || independentlyIdle)) fs.rmSync(path.join(dir, "participants", `${row.id}.json`), { force: true });
  }
}
export function createParticipant(dir: string, kind: ParticipantState["kind"], version: string, root?: string, metadata: Partial<ParticipantState> = {}) {
  // Crashes skip exit handlers. Reap only dead, idle owners before adding a new
  // one; unfinished sessions and approvals still require extension verification.
  try { reapParticipants(dir); } catch { /* Admission/update checks still report invalid records. */ }
  const state: ParticipantState = { id: `${process.pid}-${randomUUID()}`, pid: process.pid, kind, version, root, inFlight: 0, sessions: [], approvals: 0, heartbeatAt: Date.now(), ...metadata };
  const folder = path.join(dir, "participants");
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, `${state.id}.json`);
  let closed = false;
  const publish = (patch: Partial<ParticipantState> = {}) => { if (closed) return; Object.assign(state, patch, { heartbeatAt: Date.now() }); atomicJson(file, state); };
  publish();
  const heartbeat = setInterval(() => publish(), 15000); heartbeat.unref();
  const close = () => { closed = true; clearInterval(heartbeat); fs.rmSync(file, { force: true }); };
  process.once("exit", close);
  return { state, publish, close() { process.removeListener("exit", close); close(); },
    abandon(patch: Partial<ParticipantState> = {}) {
      if (closed) return;
      publish({ ...patch,abandonedAt: Date.now() });
      closed = true; clearInterval(heartbeat); process.removeListener("exit", close);
    },
    async enter() {
      const deadline = Date.now() + 45000;
      for (;;) {
        if (closed) throw new Error("Runtime participant closed");
        const admitted = await withRuntimeLock(dir, () => {
          const journal = readJournal(dir);
          if (journal) {
            if (processAlive(journal.pid)) return false;
            // The atomic runtime pointer is the commit record. Supervisors reconcile
            // it before dispatch, even if the coordinator died after publishing it.
            fs.unlinkSync(path.join(dir, "activation-journal.json"));
          }
          publish({ inFlight: state.inFlight + 1 }); return true;
        });
        if (admitted) return;
        if (Date.now() >= deadline) throw new Error("Runtime activation is still recovering; retry this call");
        await sleep(20);
      }
    },
    leave(patch: Partial<ParticipantState> = {}) { publish({ ...patch, inFlight: Math.max(0, state.inFlight - 1) }); },
  };
}
