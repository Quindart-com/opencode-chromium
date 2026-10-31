import fs from "node:fs";
import path from "node:path";
import { createParticipant } from "../control/leases.ts";
import type { AgentBrowserRuntime } from "../core/runtime.ts";
import { PLUGIN_VERSION } from "../core/versions.ts";

// Adapters own tracking: unmanaged SDK instances retain their existing lifecycle.
const trackers = new WeakMap<AgentBrowserRuntime, ReturnType<typeof createTracker>>();
const activeRuntimes = new Set<WeakRef<AgentBrowserRuntime>>();
let processInFlight = 0;
function reconnectIdle() {
  if (processInFlight) return false;
  const now = Date.now();
  for (const reference of activeRuntimes) {
    const runtime = reference.deref();
    if (!runtime) { activeRuntimes.delete(reference); continue; }
    for (const approval of runtime.approvals.values()) if (approval.expiresAt > now) return false;
  }
  return true;
}
export function trackRuntime(runtime: AgentBrowserRuntime) {
  let tracker = trackers.get(runtime);
  if (!tracker) { tracker = createTracker(runtime); trackers.set(runtime, tracker); }
  return tracker;
}
function createTracker(runtime: AgentBrowserRuntime) {
  const reference = new WeakRef(runtime); activeRuntimes.add(reference);
  const dir = process.env.OPENCODE_BROWSER_RUNTIME_DIR;
  const participant = dir && fs.existsSync(path.join(dir, "runtime.json")) ? createParticipant(dir, "runtime", PLUGIN_VERSION) : null;
  if (participant) process.env.OPENCODE_BROWSER_COORDINATED = "1";
  const snapshot = () => {
    const now = Date.now();
    for (const [token, approval] of runtime.approvals) if (approval.expiresAt <= now) runtime.approvals.delete(token);
    return { sessions: [...runtime.sessions.keys()], approvals: runtime.approvals.size,
      profiles: [...new Set([...runtime.sessions.values()].map(session => session.profileId).filter((id): id is string => id !== null))] };
  };
  const timer = setInterval(() => {
    if (!participant) return;
    const state = snapshot();
    if (state.approvals !== participant.state.approvals || JSON.stringify(state.sessions) !== JSON.stringify(participant.state.sessions)) participant.publish(state);
  }, 1000);
  timer.unref();
  let inFlight = 0;
  return {
    idle() { const state = snapshot(); return inFlight === 0 && state.approvals === 0 && state.sessions.length === 0; },
    reconnectIdle,
    async call<T>(action: () => T | Promise<T>): Promise<T> {
      await participant?.enter();
      inFlight++; processInFlight++;
      try { return await action(); } finally { inFlight--; processInFlight--; participant?.leave(snapshot()); }
    },
    close() { clearInterval(timer); activeRuntimes.delete(reference); participant?.close(); },
  };
}
