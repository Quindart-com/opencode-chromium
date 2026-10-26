import { useEffect, useRef, useState } from "react";
import { sendMessage } from "./api";

type Updates = { supported: boolean; enabled: boolean; state?: string; targetVersion?: string; installedVersion?: string; stagedVersion?: string; loadedVersions?: string[]; blockerCount?: number; reason?: string };
const labels: Record<string, string> = {
  waiting: "Update scheduled. Waiting for agent sessions to finish.",
  downloading: "Downloading a matching runtime in the background.",
  staged: "Download verified. Checking that every browser session has finished.",
  activating: "Switching local tools to the updated runtime.",
  reconnect_required: "This release changes the tool connection. Run setup and reconnect MCP once.",
  ready: "Matching runtime installed. New agent sessions use it automatically.",
  retry: "Update deferred. The current runtime is still available; another attempt will run later.",
};
export default function RuntimeUpdates() {
  const [updates, setUpdates] = useState<Updates | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false), revision = useRef(0);
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      if (saving.current) return;
      const observed = revision.current;
      try {
        const response = await sendMessage<{ result?: Updates; error?: string }>({ type: "GET_RUNTIME_UPDATES" });
        if (!disposed && !saving.current && observed === revision.current) { setUpdates(response.result ?? null); setMessage(response.error ?? ""); }
      } catch { if (!disposed) setMessage("Connect the local runtime to check update settings."); }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 10000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  async function configure(enabled: boolean) {
    if (saving.current) return;
    const previous = updates;
    saving.current = true; revision.current++;
    setUpdates(previous ? { ...previous, enabled } : previous);
    setBusy(true);
    try {
      const response = await sendMessage<{ result?: Updates; error?: string }>({ type: "SET_RUNTIME_UPDATES", enabled });
      if (response.result) { setUpdates(response.result); setMessage("Update preference saved."); }
      else { setUpdates(previous); setMessage(response.error ?? "Could not save. Try again."); }
    } catch { setUpdates(previous); setMessage("Could not save. Reconnect the local runtime and try again."); }
    finally { saving.current = false; revision.current++; setBusy(false); }
  }
  return <section className="card" aria-labelledby="runtime-updates-title">
    <h2 id="runtime-updates-title">Updates</h2>
    <label className="checkbox-row"><input type="checkbox" checked={updates?.enabled ?? false} disabled={busy || !updates?.supported} onChange={event => void configure(event.target.checked)} /><span>Keep local browser tools up to date<small className="help-note">Download matching tools in the background and switch when all browser sessions have finished. Managed MCP connections stay open.</small></span></label>
    <p className="help-note">{updates?.supported ? !updates.enabled ? "Automatic runtime updates are off." : labels[updates.state ?? ""] ?? "Automatic checks run while the browser is connected. Downloads use npm." : updates?.reason ?? "Update the local runtime once to enable automatic updates."}</p>
    <p role="status" className="feedback">{message}</p>
    {updates?.supported && <p className="help-note">Selected: {updates.installedVersion ?? "unknown"}. Loaded: {updates.loadedVersions?.join(", ") || "no active workers"}.{updates.stagedVersion ? ` Downloaded: ${updates.stagedVersion}.` : ""}{updates.blockerCount ? ` Waiting on ${updates.blockerCount} active participant(s).` : ""}</p>}
    <a href="https://quindart-com.github.io/opencode-chromium/updates/" target="_blank" rel="noopener noreferrer">What’s new</a>
  </section>;
}
