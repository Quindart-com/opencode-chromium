import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeActivation } from "../../src/shared/runtime-config.ts";
import { activeRuntimeLeases,withRuntimeLock } from "./runtime-lifecycle.ts";
import { atomicJson,participantBusy,participants,processAlive,readJournal,reapParticipants,sleep,type SwitchJournal } from "./runtime-participants.ts";

async function waitFor(dir: string, ids: string[], key: "prepared" | "committed", id: string) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const rows = participants(dir).filter(row => ids.includes(row.id));
    const error = rows.find(row => row.error)?.error;
    if (error) throw new Error(error);
    if (ids.every(identity => rows.some(row => row.id === identity && processAlive(row.pid) && row[key] === id) ||
      !rows.some(row => row.id === identity) && !processAlive(Number(identity.split("-")[0])))) return;
    if (Date.now() >= deadline) throw new Error("A managed MCP connection did not acknowledge the update");
    await sleep(25);
  }
}

/** All request admission uses the same gate as this transaction. Downloads never do. */
export async function activateRelease(dir: string, next: { root: string; version: string }, busy: () => Promise<boolean>, verifiedProfiles: () => readonly string[] = () => [], preparing: () => void = () => {}, reconnectHosts: () => Promise<void> = async () => {}) {
  const file = path.join(dir, "runtime.json"), journalFile = path.join(dir, "activation-journal.json");
  let journal: SwitchJournal | null = null;
  if (await busy()) return false;
  const admitted = await withRuntimeLock(dir, async () => {
    if (readJournal(dir)) return false;
    reapParticipants(dir, verifiedProfiles());
    if (activeRuntimeLeases(dir) || participants(dir).some(participantBusy)) return false;
    const previous = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeActivation;
    if (previous.autoUpdate === false || previous.followBranch) return false;
    journal = { id: randomUUID(), pid: process.pid, phase: "preparing", previous,
      next: { ...next, generation: (previous.generation ?? 0) + 1 } };
    atomicJson(journalFile, journal); return true;
  });
  if (!admitted || !journal) return false;
  const transaction = journal as SwitchJournal;
  // Registration is allowed while preparing, but requests cannot pass admission.
  const ids = participants(dir).filter(row => row.kind === "supervisor").map(row => row.id);
  try {
    preparing();
    await waitFor(dir, ids, "prepared", transaction.id);
    const browsersBusy = await busy();
    await withRuntimeLock(dir, () => {
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeActivation;
      if (current.root !== transaction.previous.root || current.autoUpdate === false || current.followBranch || browsersBusy || participants(dir).some(participantBusy)) throw new Error("Runtime activity changed during preparation");
      atomicJson(file, { ...current, ...transaction.next, stagedRelease: undefined, pendingReload: false });
      atomicJson(journalFile, { ...transaction, phase: "committed" });
    });
    await waitFor(dir, ids, "committed", transaction.id);
    await reconnectHosts();
    return true;
  } catch (error) {
    await withRuntimeLock(dir, () => {
      const current = JSON.parse(fs.readFileSync(file, "utf8")) as RuntimeActivation;
      atomicJson(file, { ...current, ...transaction.previous, autoUpdate: current.autoUpdate });
      atomicJson(journalFile, { ...transaction, phase: "aborted" });
    });
    await reconnectHosts().catch(() => { /* The previous pointer remains authoritative during recovery. */ });
    // Supervisors keep the old worker until the journal is removed. Requests
    // reconcile the authoritative pointer again before being dispatched.
    throw error;
  } finally {
    await withRuntimeLock(dir, () => { if (readJournal(dir)?.id === transaction.id) fs.unlinkSync(journalFile); });
  }
}
