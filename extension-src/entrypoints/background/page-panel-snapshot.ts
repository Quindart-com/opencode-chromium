import { projectPagePanel,type PagePanelUsage } from "../../page-panel/protocol.ts";
import type { NativeRpc } from "./native-rpc.ts";

export async function pagePanelSnapshot(rpc: NativeRpc, status: { state?: string }, profile: () => Promise<unknown>, usage: PagePanelUsage) {
  if (status.state !== "connected") return projectPagePanel(false, null, null, null);
  const read = (method: string, params = {}) => rpc.request(method, params, { timeoutMs: 2500 }).catch(() => null);
  const current = await profile().catch(() => null);
  const profileId = current && typeof current === "object" && "profileId" in current && typeof current.profileId === "string" ? current.profileId : null;
  const [connections, decision, memory] = await Promise.all([
    read("connections.list"), read("decision.status", { usage: { period: usage.period, provider: usage.provider === "current" ? undefined : usage.provider } }), profileId ? read("memory.stats", { profileIds: [profileId] }) : Promise.resolve(null),
  ]);
  return projectPagePanel(status.state === "connected", connections, decision, memory);
}
