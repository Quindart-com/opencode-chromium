import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { FrameDecoder,writeFrame } from "../shared/node-framing.ts";
import { readProfileRegistrations,removeProfileRegistrationFile,type ProfileRegistration } from "../shared/profile-registry.ts";
import { record } from "../shared/values.ts";
import { controlToken } from "./auth.ts";
import { participantActive,participants,processAlive,type ParticipantState } from "./leases.ts";

export const ABANDONED_SESSION_GRACE_MS = 5 * 60 * 1000;
export const OFFLINE_PROFILE_GRACE_MS = 15 * 60 * 1000;
type RpcReply = { reachable: boolean; result: Record<string, unknown> | null };
type RequestProfile = (profile: ProfileRegistration, method: string, params?: Record<string, unknown>) => Promise<RpcReply>;

function requestProfile(profile: ProfileRegistration, method: string, params: Record<string, unknown> = {}): Promise<RpcReply> {
  return new Promise(resolve => {
    const socket = net.createConnection(profile.ipcPath);
    let finished = false;
    const finish = (reply: RpcReply) => { if (finished) return; finished = true; clearTimeout(timer); socket.destroy(); resolve(reply); };
    const timer = setTimeout(() => finish({ reachable: false,result: null }), 2000);
    const decoder = new FrameDecoder({ onMessage: value => {
      const message = record(value);
      finish({ reachable: true,result: message.error ? null : record(message.result) });
    } });
    socket.on("connect", () => { void writeFrame(socket, { jsonrpc: "2.0",id: 1,method,params }).catch(() => finish({ reachable: false,result: null })); });
    socket.on("data", chunk => { try { decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); } catch { finish({ reachable: true,result: null }); } });
    socket.on("error", () => finish({ reachable: false,result: null }));
  });
}

function lastSeenAt(profile: ProfileRegistration) {
  const recorded = Date.parse(profile.lastSeenAt ?? "");
  if (Number.isFinite(recorded)) return recorded;
  try { return profile.registrationPath ? fs.statSync(profile.registrationPath).mtimeMs : 0; } catch { return 0; }
}
function participantEligible(row: ParticipantState, now: number, graceMs: number) {
  const approvalsExpired = row.approvals === 0 || typeof row.approvalExpiresAt === "number" && row.approvalExpiresAt <= now;
  return !participantActive(row) && approvalsExpired && now - (row.abandonedAt ?? row.heartbeatAt ?? 0) >= graceMs;
}

/** Reconcile only ownership whose process is dead and whose extension agrees it is inactive. */
export async function reconcileRuntimeState(dir: string, options: {
  now?: number; participantGraceMs?: number; profileGraceMs?: number; request?: RequestProfile;
  registrations?: ReturnType<typeof readProfileRegistrations>;
} = {}) {
  const now = options.now ?? Date.now(), participantGraceMs = options.participantGraceMs ?? ABANDONED_SESSION_GRACE_MS;
  const profileGraceMs = options.profileGraceMs ?? OFFLINE_PROFILE_GRACE_MS, request = options.request ?? requestProfile;
  const reconciliationToken = controlToken(dir);
  const rows = participants(dir), liveSessions = new Set(rows.filter(participantActive).flatMap(row => row.sessions));
  const candidates = rows.filter(row => participantEligible(row, now, participantGraceMs));
  const registrations = options.registrations ?? readProfileRegistrations();
  const byProfile = new Map(registrations.map(profile => [profile.profileId, profile]));
  const requested = new Map<string, Set<string>>();
  for (const row of candidates) for (const profileId of row.profiles ?? []) {
    const ids = requested.get(profileId) ?? new Set<string>();
    for (const sessionId of row.sessions) if (!liveSessions.has(sessionId)) ids.add(sessionId);
    requested.set(profileId, ids);
  }

  const settled = new Map<string, Set<string>>();
  let releasedSessions = 0, removedProfiles = 0;
  for (const [profileId, sessionIds] of requested) {
    const profile = byProfile.get(profileId); if (!profile || !sessionIds.size) continue;
    const reply = await request(profile, "runtime.reconcileSessions", { sessionIds: [...sessionIds],inactiveBefore: now - participantGraceMs,reconciliationToken });
    const ids = Array.isArray(reply.result?.settledSessionIds) ? reply.result.settledSessionIds.filter((id): id is string => typeof id === "string") : [];
    settled.set(profileId, new Set(ids)); releasedSessions += ids.length;
  }

  let removedParticipants = 0;
  for (const row of candidates) {
    const unresolved = row.sessions.filter(sessionId => !liveSessions.has(sessionId) && (!(row.profiles?.length) || !row.profiles.every(profileId => settled.get(profileId)?.has(sessionId))));
    if (unresolved.length) continue;
    fs.rmSync(path.join(dir, "participants", `${row.id}.json`), { force: true }); removedParticipants++;
  }

  for (const profile of registrations) {
    if (profile.hostPid && processAlive(profile.hostPid) || now - lastSeenAt(profile) < profileGraceMs) continue;
    const reply = await request(profile, "runtime.activity");
    if (!reply.reachable && profile.registrationPath) { removeProfileRegistrationFile(profile.registrationPath); removedProfiles++; }
  }
  return { removedParticipants,releasedSessions,removedProfiles,deferredParticipants: candidates.length - removedParticipants };
}
