import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomicJson, createParticipant, participantActive, participants, reapParticipants, sleep } from "../../src/control/leases.ts";
import { withRuntimeLock } from "../../src/control/state.ts";

test("pinned participants publish admission even while the blue-green update gate is held", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "participant-admission-"));
  const participant = createParticipant(dir, "runtime", "2.0.5");
  let releaseGate!: () => void;
  const held = new Promise<void>(resolve => { releaseGate = resolve; });
  const gate = withRuntimeLock(dir, () => held);
  const admission = participant.enter();
  try {
    // The gate is already held. A normal request publishes its lease before
    // yielding, so the coordinator can see it without serializing tool calls.
    expect(participants(dir)[0]?.inFlight).toBe(1);
    await admission;
    participant.leave();
    expect(participants(dir)[0]?.inFlight).toBe(0);
  } finally {
    releaseGate();
    await gate;
    await admission;
    participant.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a live legacy activation journal blocks new admission until the coordinator clears it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "participant-admission-"));
  const file = path.join(dir, "activation-journal.json");
  const participant = createParticipant(dir, "host", "2.0.5");
  try {
    await participant.enter();
    participant.leave();
    expect(participants(dir)[0]?.inFlight).toBe(1);
    atomicJson(file, { id: "legacy", pid: process.pid, phase: "preparing",
      previous: { root: dir }, next: { root: dir, version: "2.0.6", generation: 2 } });
    const pending = participant.enter();
    const waiting = participants(dir)[0]?.inFlight;
    fs.unlinkSync(file);
    await pending;
    expect(waiting).toBe(0);
    expect(participants(dir)[0]?.inFlight).toBe(1);
    participant.leave();
  } finally {
    participant.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the native host keeps a durable busy lease across overlapping and adjacent relay requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "participant-admission-"));
  const host = createParticipant(dir, "host", "2.0.5");
  const busyOnDisk = () => (participants(dir)[0]?.inFlight ?? 0) > 0;
  try {
    await host.enter();
    await host.enter();
    expect(host.state.inFlight).toBe(2);
    host.leave();
    expect(busyOnDisk()).toBe(true);
    host.leave();
    expect(host.state.inFlight).toBe(0);
    expect(busyOnDisk()).toBe(true);

    await host.enter();
    await sleep(60);
    expect(busyOnDisk()).toBe(true);
    host.leave();
    await sleep(60);
    expect(busyOnDisk()).toBe(false);
  } finally {
    host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("starting a participant reaps dead idle records but preserves sessions, approvals, in-flight work and live owners", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "participant-recovery-"));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  await once(child, "exit");
  const folder = path.join(dir, "participants"); fs.mkdirSync(folder);
  let current: ReturnType<typeof createParticipant> | undefined;
  try {
    const base = { pid: child.pid!, kind: "runtime", version: "1.0.0", sessions: [], inFlight: 0, approvals: 0 };
    for (let index = 0; index < 350; index++) atomicJson(path.join(folder, `idle-${index}.json`), { ...base, id: `idle-${index}` });
    for (const patch of [{ id: "session", sessions: ["unfinished"] }, { id: "approval", approvals: 1 }, { id: "request", inFlight: 1 }, { id: "live", pid: process.pid }]) {
      atomicJson(path.join(folder, `${patch.id}.json`), { ...base, ...patch });
    }
    current = createParticipant(dir, "runtime", "1.0.0");
    const ids = participants(dir).map(row => row.id);
    expect(ids).toHaveLength(5);
    for (const id of ["session", "approval", "request", "live", current.state.id]) expect(ids).toContain(id);
  } finally { current?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("profile verification cannot reap a dead participant with an in-flight request", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "participant-recovery-")), folder = path.join(dir, "participants"); fs.mkdirSync(folder);
  try {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true }); await once(child, "exit");
    atomicJson(path.join(folder, "request.json"), { id: "request",pid: child.pid!,kind: "runtime",version: "1.0.0",sessions: ["session"],profiles: ["profile"],inFlight: 1,approvals: 0 });
    reapParticipants(dir, ["profile"]);
    expect(participants(dir).map(row => row.id)).toEqual(["request"]);
  } finally { fs.rmSync(dir, { recursive: true,force: true }); }
});

test("clean shutdown preserves unfinished ownership as a non-active tombstone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "participant-recovery-"));
  try {
    const owner = createParticipant(dir, "runtime", "1.0.0");
    owner.publish({ sessions: ["unfinished"],profiles: ["profile"] }); owner.abandon();
    const [row] = participants(dir); expect(row?.sessions).toEqual(["unfinished"]); expect(participantActive(row!)).toBe(false);
    reapParticipants(dir, ["profile"]); expect(participants(dir)).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true,force: true }); }
});
