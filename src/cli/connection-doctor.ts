import { browserRequest,closeBrowserClients,listBrowserProfiles } from "../browser/client.ts";
import { participants,reapParticipants } from "../../native-host/src/runtime-participants.ts";
import { runtimeDir } from "./native-host.ts";
import { record } from "../shared/values.ts";

/** Probe the actual extension, not just the host's cached connected indicator. */
export async function connectionDoctor({ profileId, repairRuntime = false }: { profileId?: string; repairRuntime?: boolean } = {}) {
  let removed = 0;
  const checks: { name: string; ok: boolean; code?: string }[] = [];
  try {
    if (repairRuntime) {
      const before = participants(runtimeDir()).length;
      reapParticipants(runtimeDir());
      removed = before - participants(runtimeDir()).length;
    }
    const profiles = await listBrowserProfiles({ fresh: true, timeoutMs: 1500 });
    const selected = profileId ? profiles.filter(profile => profile.profileId === profileId) : profiles;
    if (!selected.length) checks.push({ name: "browser-host", ok: false, code: "NO_BROWSER_PROFILE" });
    await Promise.all(selected.map(async profile => {
      try {
        const reply = record(await browserRequest("getUserTabs", {}, { profileId: profile.profileId, timeoutMs: 2000, recover: false }));
        checks.push({ name: "extension-response", ok: Array.isArray(reply.tabs) });
      } catch { checks.push({ name: "extension-response", ok: false, code: "EXTENSION_UNRESPONSIVE" }); }
    }));
  } catch (error) {
    checks.push({ name: "browser-host", ok: false, code: String(record(error).code ?? "CONNECTION_FAILED") });
  } finally { closeBrowserClients(); }
  return { ok: checks.length > 0 && checks.every(check => check.ok), removed, checks };
}
