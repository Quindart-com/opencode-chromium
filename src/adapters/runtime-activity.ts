import fs from "node:fs";
import path from "node:path";
import { createParticipant } from "../../native-host/src/runtime-participants.ts";
import type { AgentBrowserRuntime } from "../core/runtime.ts";
import { PLUGIN_VERSION } from "../core/versions.ts";

// Adapters own tracking: unmanaged SDK instances retain their existing lifecycle.
const trackers = new WeakMap<AgentBrowserRuntime, ReturnType<typeof createTracker>>();
export function trackRuntime(runtime: AgentBrowserRuntime) {
  let tracker = trackers.get(runtime);
  if (!tracker) { tracker = createTracker(runtime); trackers.set(runtime, tracker); }
  return tracker;
}
function createTracker(runtime: AgentBrowserRuntime) {
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
  return {
    async call<T>(action: () => T | Promise<T>): Promise<T> {
      await participant?.enter();
      try { return await action(); } finally { participant?.leave(snapshot()); }
    },
    close() { clearInterval(timer); participant?.close(); },
  };
}
