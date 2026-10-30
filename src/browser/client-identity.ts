import { safeClientVersion,type ClientIdentity,type HarnessKind } from "../shared/connections.ts";

let identity: ClientIdentity = { harness: "sdk", harnessVersion: null, transport: "sdk", phase: "initialized", pid: process.pid };
let presence: ReturnType<typeof setInterval> | null = null;
const owners = new Set<symbol>();
export const browserClientIdentity = () => ({ ...identity });
export function markBrowserClientUsed() { identity.phase = "used"; }
export function startBrowserClientPresence(harness: HarnessKind, version: unknown, transport: ClientIdentity["transport"], announce: () => Promise<unknown>) {
  const owner = Symbol(); owners.add(owner);
  identity = { harness, harnessVersion: safeClientVersion(version), transport, phase: "initialized", pid: process.pid };
  const ping = () => { void announce().catch(() => {}); };
  ping();
  if (!presence) { presence = setInterval(ping, 15000); presence.unref(); }
  return () => { owners.delete(owner); if (!owners.size) stopBrowserClientPresence(); };
}
export function stopBrowserClientPresence() { if (presence) clearInterval(presence); presence = null; owners.clear(); }
