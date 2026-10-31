import { useEffect,useRef,useState } from "react";
import { t } from "../../i18n";
import { sendMessage } from "./api";
import useLocalAction from "./useLocalAction";

type Component = { component: string; version: string | null; state: string; label?: string };
type Updates = { supported: boolean; controllerSupported?: boolean; enabled: boolean; state?: string; targetVersion?: string; installedVersion?: string; stagedVersion?: string; loadedVersions?: string[]; blockerCount?: number; reason?: string;
  desired?: { version: string }; fallback?: { version: string } | null; staged?: { version: string } | null; components?: Component[] };
const labels: Record<string, string> = {
  waiting: t("runtimeScheduled"),
  downloading: t("runtimeDownloading"),
  staged: t("runtimeStaged"),
  activating: t("runtimeActivating"),
  reconnect_required: t("runtimeReconnectRequired"),
  ready: t("runtimeInstalled"),
  retry: t("runtimeDeferred"),
  draining: t("runtimeDraining"),
  approval_required: t("runtimeApprovalRequired"),
  bridge_required: t("bridgeRequired"),
};
export default function RuntimeUpdates() {
  const local = useLocalAction();
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
      } catch { if (!disposed) setMessage(t("runtimeReconnect")); }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 10000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [local.action?.state]);
  async function configure(enabled: boolean) {
    if (saving.current) return;
    const previous = updates;
    saving.current = true; revision.current++;
    setUpdates(previous ? { ...previous, enabled } : previous);
    setBusy(true);
    try {
      const response = await sendMessage<{ result?: Updates; error?: string }>({ type: "SET_RUNTIME_UPDATES", enabled });
      if (response.result) { setUpdates(response.result); setMessage(t("updatePrefSaved")); }
      else { setUpdates(previous); setMessage(response.error ?? t("saveTryAgain")); }
    } catch { setUpdates(previous); setMessage(t("runtimeSaveFail")); }
    finally { saving.current = false; revision.current++; setBusy(false); }
  }
  async function install() {
    const approvedMajor = updates?.state === "approval_required" ? window.confirm(t("majorUpgradeConfirm")) : false;
    if (updates?.state === "approval_required" && !approvedMajor) return;
    await local.start("INSTALL_RUNTIME_UPDATE", approvedMajor ? { approvedMajor: true } : {});
  }
  const desiredVersion = updates?.desired?.version ?? updates?.installedVersion ?? t("memoryUnknown");
  const activeVersions = updates?.components?.filter(item => item.component === "active-worker").map(item => item.version).filter((value): value is string => !!value) ?? updates?.loadedVersions ?? [];
  return <section className="card" aria-labelledby="runtime-updates-title">
    <h2 id="runtime-updates-title">{t("updates")}</h2>
    <button type="button" className="button button-primary" disabled={busy || local.working || updates?.supported === false} onClick={() => void install()}>{t(local.working ? "actionUpdating" : "checkInstallUpdates")}</button>
    {local.feedback && <p role="status" className={"action-feedback " + (local.error || local.action?.state === "failed" ? "is-error" : local.action?.state === "waiting" ? "is-waiting" : "")}>{local.feedback}</p>}
    <label className="checkbox-row"><input type="checkbox" checked={updates?.enabled ?? false} disabled={busy || !updates?.supported} onChange={event => void configure(event.target.checked)} /><span>{t("keepUpdated")}<small className="help-note">{t("runtimeUpdateHelp")}</small></span></label>
    <p className="help-note">{updates?.supported ? !updates.enabled ? t("updatesOff") : labels[updates.state ?? ""] ?? t("updateChecks") : updates?.reason ?? t("updateOnce")}</p>
    <p role="status" className="feedback">{message}</p>
    {updates?.reason && <p className="help-note">{updates.reason}</p>}
    {updates?.supported && <p className="help-note">{t("runtimeVersions", [desiredVersion, activeVersions.join(", ") || t("noWorkers")])}{(updates.staged?.version ?? updates.stagedVersion) ? " " + t("runtimeDownloaded", updates.staged?.version ?? updates.stagedVersion ?? "") : ""}{updates.blockerCount ? " " + t("runtimeWaiting", String(updates.blockerCount)) : ""}</p>}
    {!!updates?.components?.length && <ul className="runtime-components">{updates.components.map((component, index) => <li key={`${component.component}-${component.label ?? index}`}><span>{component.label ?? component.component}</span><strong>{component.version ?? t("memoryUnknown")}</strong><small>{component.state}</small></li>)}</ul>}
    <a href="https://quindart-com.github.io/opencode-chromium/updates/" target="_blank" rel="noopener noreferrer">{t("whatsNew")}</a>
  </section>;
}
