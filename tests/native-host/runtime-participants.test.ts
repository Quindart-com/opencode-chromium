import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomicJson, createParticipant, participantActive, participants, reapParticipants } from "../../src/control/leases.ts";

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
