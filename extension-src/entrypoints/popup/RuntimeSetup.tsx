import { useState } from "react";
import { t } from "../../i18n";
import { runtimeSetupCommand } from "../../runtime-update";
import { sendMessage } from "./api";

/** Older hosts cannot install the new controller through the update RPC. */
export default function RuntimeSetup() {
  const [feedback, setFeedback] = useState(""), [reconnecting, setReconnecting] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(runtimeSetupCommand); setFeedback(t("welcomeCopied")); }
    catch { setFeedback(t("copyUnavailable")); }
  }
  async function reconnect() {
    setReconnecting(true);
    try {
      const response = await sendMessage<{ result?: { reconnecting?: boolean }; error?: string }>({ type: "RECONNECT_NATIVE_HOST" });
      setFeedback(response.result?.reconnecting ? t("bridgeReconnecting") : response.error ?? t("actionUnavailable"));
    } catch { setFeedback(t("actionUnavailable")); }
    finally { setReconnecting(false); }
  }
  return <div className="runtime-setup">
    <p>{t("runtimeSetupHelp")}</p>
    <code className="update-command">{runtimeSetupCommand}</code>
    <div className="setup-actions">
      <button type="button" className="button button-primary" onClick={() => void copy()}>{t("copySetup")}</button>
      <button type="button" className="button" disabled={reconnecting} onClick={() => void reconnect()}>{t(reconnecting ? "bridgeReconnecting" : "reconnectBridge")}</button>
    </div>
    {feedback && <p role="status">{feedback}</p>}
  </div>;
}
