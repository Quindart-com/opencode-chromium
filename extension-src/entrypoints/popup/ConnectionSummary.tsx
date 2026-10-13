import { useEffect, useState } from "react";
import { sendMessage, type NativeStatus, type Profile } from "./api";

const setupCommand = "npx -y opencode-chromium@latest setup --all";

export default function ConnectionSummary({ status, onProfiles }: { status: NativeStatus; onProfiles: () => void }): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [copyState, setCopyState] = useState("");
  const connected = status.state === "connected";
  const checking = status.state === "unknown" || status.state === "reconnecting";
  useEffect(() => {
    let active = true;
    void sendMessage<{ profile?: Profile }>({ type: "GET_PROFILE" }).then(response => {
      if (active && response.profile) setProfile(response.profile);
    }).catch(() => {});
    return () => { active = false; };
  }, [connected]);
  async function copySetup() {
    try { await navigator.clipboard.writeText(setupCommand); setCopyState("Setup command copied."); }
    catch { setCopyState("Copy unavailable. Select the command below instead."); }
  }
  return <section className={`connection-summary${connected ? " is-connected" : ""}`} aria-labelledby="connection-summary-heading">
    <div className="connection-summary-heading">
      <h2 id="connection-summary-heading">{connected ? "Browser connected" : checking ? "Checking connection" : "Connect your browser"}</h2>
      {connected && <button type="button" className="button-mini" onClick={onProfiles}>Profiles</button>}
    </div>
    <p>{connected ? "The extension is connected to your local runtime. Choose this profile in your agent to start browsing." : checking ? "Looking for the local runtime. Your settings stay on this device." : "Install the local bridge to connect this extension to your coding agent."}</p>
    {connected && <p className="current-profile">This browser profile: <strong>{profile?.profileLabel || "Unnamed profile"}</strong></p>}
    {!connected && !checking && <>
      <code className="setup-command">{setupCommand}</code>
      <div className="setup-actions"><button type="button" className="button button-primary" onClick={() => void copySetup()}>Copy setup command</button><a href="https://github.com/Quindart-com/opencode-chromium#get-started" target="_blank" rel="noopener noreferrer">Setup guide</a></div>
      <p className="setup-feedback" role="status">{copyState}</p>
    </>}
    {status.error && <details className="connection-diagnostics"><summary>Connection details</summary><p>{status.error}</p></details>}
  </section>;
}
