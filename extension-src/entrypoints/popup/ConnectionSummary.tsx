import { t } from "../../i18n";
import { useEffect, useState } from "react";
import { sendMessage, type NativeStatus, type Profile } from "./api";
import HarnessConnections from "./HarnessConnections";

const setupCommand = "npx -y opencode-chromium@latest setup --all";

export default function ConnectionSummary({ status, onProfiles }: { status: NativeStatus; onProfiles: () => void }): React.JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [copyState, setCopyState] = useState("");
  const connected = status.state === "connected";
  const checking = status.state === "unknown" || status.state === "reconnecting" || status.state === "connecting";
  useEffect(() => {
    let active = true;
    void sendMessage<{ profile?: Profile }>({ type: "GET_PROFILE" }).then(response => {
      if (active && response.profile) setProfile(response.profile);
    }).catch(() => {});
    return () => { active = false; };
  }, [connected]);
  async function copySetup() {
    try { await navigator.clipboard.writeText(setupCommand); setCopyState(t("welcomeCopied")); }
    catch { setCopyState(t("copyUnavailable")); }
  }
  return <><section className={`connection-summary${connected ? " is-connected" : ""}`} aria-labelledby="connection-summary-heading">
    <div className="connection-summary-heading">
      <h2 id="connection-summary-heading">{connected ? t("runtimeConnected") : checking ? t("checkingConnection") : t("connectBrowser")}</h2>
      {connected && <button type="button" className="button-mini" onClick={onProfiles}>{t("profiles")}</button>}
    </div>
    <p>{connected ? t("runtimeExplanation") : checking ? t("runtimeChecking") : t("runtimeInstall")}</p>
    {connected && <p className="current-profile">{t("thisBrowser")}{" "}<strong>{profile?.profileLabel || t("unnamedProfile")}</strong></p>}
    {!connected && !checking && <>
      <code className="setup-command">{setupCommand}</code>
      <div className="setup-actions"><button type="button" className="button button-primary" onClick={() => void copySetup()}>{t("copySetup")}</button><a href="https://github.com/Quindart-com/opencode-chromium#get-started" target="_blank" rel="noopener noreferrer">{t("setupGuide")}</a></div>
      <p className="setup-feedback" role="status">{copyState}</p>
    </>}
    {status.error && <details className="connection-diagnostics"><summary>{t("connectionDetails")}</summary><p>{status.error}</p></details>}
  </section><HarnessConnections status={status} /></>;
}
