import { useEffect,useState } from "react";
import { browser } from "wxt/browser";
import { t } from "../../i18n";
import { versionNotice } from "../../version-status";
import { sendMessage,type NativeStatus } from "./api";
import useLocalAction from "./useLocalAction";
import { requiresRuntimeSetup } from "../../runtime-update";
import RuntimeSetup from "./RuntimeSetup";
import type { MajorReview } from "./RuntimeApproval";

export default function VersionNotice({ status, showSnoozed, onReviewMajor }: { status: NativeStatus; showSnoozed: boolean; onReviewMajor(review: MajorReview): void }) {
  const extension = browser.runtime.getManifest().version;
  const notice = versionNotice(extension, status);
  const [dismissed, setDismissed] = useState<string | null>(null), [feedback, setFeedback] = useState("");
  const local = useLocalAction();
  const [versions, setVersions] = useState<{ installedVersion?: string; targetVersion?: string; desired?: { version: string } }>({});
  const [setupRequired, setSetupRequired] = useState(false), [checking, setChecking] = useState(true);
  useEffect(() => {
    let disposed = false;
    setChecking(true); setSetupRequired(false);
    if (!notice || notice.kind === "extension") { setChecking(false); return; }
    void sendMessage<{ result?: { state?: string; controllerSupported?: boolean; installedVersion?: string; targetVersion?: string; desired?: { version: string } } }>({ type: "GET_RUNTIME_UPDATES" }).then(response => {
      if (!disposed) { setSetupRequired(requiresRuntimeSetup(response.result)); setVersions(response.result ?? {}); }
    }).catch(() => {}).finally(() => { if (!disposed) setChecking(false); });
    return () => { disposed = true; };
  }, [notice?.kind, notice?.host]);
  const needsSetup = setupRequired || requiresRuntimeSetup(local.action);
  async function install() {
    const approvalRequired = local.action?.code === "major_approval_required";
    const target = local.action?.details?.targetVersion ?? versions.targetVersion;
    if (approvalRequired && target) {
      onReviewMajor({ current: versions.desired?.version ?? versions.installedVersion ?? notice?.host ?? null, target,
        approve: () => { void local.start("INSTALL_RUNTIME_UPDATE", { approvedMajor: true }); } });
      return;
    }
    await local.start("INSTALL_RUNTIME_UPDATE");
  }
  if (!notice || (!showSnoozed && (notice.snoozed || dismissed === notice.key))) return null;
  return <aside className="card version-notice" aria-label={t("versionNotice")}>
    <h2>{notice.kind === "extension" ? t("versionBehind") : t("updateTools")}</h2>
    <p className="help-note">{t("extensionLabel")} {extension} · {t("localHost")} {notice.host ?? t("memoryUnknown")}</p>
    {notice.kind === "extension" ? <><p>{t("storeAutoUpdate")}</p><a href="https://quindart-com.github.io/opencode-chromium/updates/" target="_blank" rel="noopener noreferrer">{t("whatsNew")}</a></> : <>
      {needsSetup ? showSnoozed ? <p>{t("runtimeSetupHelp")}</p> : <RuntimeSetup /> : <><p>{t("updateAutomaticHelp")}</p>{!showSnoozed && <button type="button" className="button button-primary" disabled={checking || local.working} onClick={() => void install()}>{t(local.working ? "actionUpdating" : "updateCli")}</button>}</>}
    </>}
    {!notice.snoozed && dismissed !== notice.key ? <button type="button" className="button-mini" onClick={() => void sendMessage<{ ok: boolean }>({ type: "SNOOZE_VERSION_NOTICE" }).then(response => { if (response.ok) setDismissed(notice.key); else setFeedback(t("reminderFail")); }, () => setFeedback(t("reminderFail")))}>{t("remindWeek")}</button> : null}
    {(local.feedback || feedback) && <p role="status" className={"action-feedback " + (local.error || local.action?.state === "failed" ? "is-error" : local.action?.state === "waiting" ? "is-waiting" : "")}>{local.feedback || feedback}</p>}
  </aside>;
}
