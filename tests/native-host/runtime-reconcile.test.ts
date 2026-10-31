import { expect,test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { atomicJson,participants } from "../../src/control/leases.ts";
import { reconcileRuntimeState } from "../../src/control/reconcile.ts";
import { normalizeProfileRegistration } from "../../src/shared/profile-registry.ts";

async function deadPid() {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true });
  await once(child, "exit"); return child.pid!;
}

test("reconciliation releases only dead, expired ownership confirmed by the extension", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-reconcile-")), folder = path.join(dir, "participants"); fs.mkdirSync(folder);
  try {
    const base = { pid: process.pid,kind: "runtime",version: "1.0.0",inFlight: 1,approvals: 0,heartbeatAt: 100,abandonedAt: 100,profiles: ["profile"] };
    atomicJson(path.join(folder, "dead.json"), { ...base,id: "dead",sessions: ["abandoned"] });
    atomicJson(path.join(folder, "approval.json"), { ...base,id: "approval",sessions: ["approval-session"],approvals: 1 });
    const registration = normalizeProfileRegistration({ profileId: "profile",ipcPath: "fixture" })!;
    const calls: string[][] = [], tokens: string[] = [];
    const result = await reconcileRuntimeState(dir, { now: 1000,participantGraceMs: 100,registrations: [{ ...registration,registrationPath: path.join(dir, "profile.json") }],
      request: async (_profile, method, params = {}) => { calls.push([method, ...((params.sessionIds as string[] | undefined) ?? [])]); if (typeof params.reconciliationToken === "string") tokens.push(params.reconciliationToken); return { reachable: true,result: method === "runtime.reconcileSessions" ? { settledSessionIds: ["abandoned"] } : {} }; } });
    expect(result).toMatchObject({ removedParticipants: 1,releasedSessions: 1,deferredParticipants: 0 });
    expect(calls).toEqual([["runtime.reconcileSessions", "abandoned"]]);
    expect(tokens).toHaveLength(1); expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(participants(dir).map(row => row.id)).toEqual(["approval"]);
  } finally { fs.rmSync(dir, { recursive: true,force: true }); }
});

test("a live replacement lease suppresses stale release and dead offline registrations age out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-reconcile-")), folder = path.join(dir, "participants"); fs.mkdirSync(folder);
  try {
    const pid = await deadPid(), row = { kind: "runtime",version: "1.0.0",inFlight: 0,approvals: 0,heartbeatAt: 0,sessions: ["shared"],profiles: ["profile"] };
    atomicJson(path.join(folder, "dead.json"), { ...row,id: "dead",pid });
    atomicJson(path.join(folder, "live.json"), { ...row,id: "live",pid: process.pid,heartbeatAt: 1000 });
    const registrationPath = path.join(dir, "profile.json"); fs.writeFileSync(registrationPath, "{}");
    const registration = normalizeProfileRegistration({ profileId: "profile",ipcPath: "offline",hostPid: pid,lastSeenAt: new Date(0).toISOString() })!;
    let calls = 0;
    const result = await reconcileRuntimeState(dir, { now: 2000,participantGraceMs: 100,profileGraceMs: 100,registrations: [{ ...registration,registrationPath }],
      request: async () => { calls++; return { reachable: false,result: null }; } });
    expect(result).toMatchObject({ removedParticipants: 1,releasedSessions: 0,removedProfiles: 1 });
    expect(calls).toBe(1); expect(fs.existsSync(registrationPath)).toBe(false);
    expect(participants(dir).map(value => value.id)).toEqual(["live"]);
  } finally { fs.rmSync(dir, { recursive: true,force: true }); }
});
