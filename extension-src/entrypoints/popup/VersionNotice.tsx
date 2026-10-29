import { t } from "../../i18n";
import { useState } from "react";
import { browser } from "wxt/browser";
import { versionNotice } from "../../version-status";
import { sendMessage, type NativeStatus } from "./api";
import useLocalAction from "./useLocalAction";

export default function VersionNotice({ status, showSnoozed }: { status: NativeStatus; showSnoozed: boolean }) {
  const extension = browser.runtime.getManifest().version;
  const notice = versionNotice(extension, status);
  const [dismissed, setDismissed] = useState<string | null>(null), [feedback, setFeedback] = useState("");
  const local = useLocalAction();
  if (!notice || (!showSnoozed && (notice.snoozed || dismissed === notice.key))) return null;
  return <aside className="card version-notice" aria-label={t("versionNotice")}>
    <h2>{notice.kind === "extension" ? t("versionBehind") : t("updateTools")}</h2>
    <p className="help-note">{t("extensionLabel")} {extension} · {t("localHost")} {notice.host ?? t("memoryUnknown")}</p>
    {notice.kind === "extension" ? <><p>{t("storeAutoUpdate")}</p><a href="https://quindart-com.github.io/opencode-chromium/updates/" target="_blank" rel="noopener noreferrer">{t("whatsNew")}</a></> : <>
      <p>{t("updateAutomaticHelp")}</p><button type="button" className="button button-primary" disabled={local.working} onClick={() => void local.start("INSTALL_RUNTIME_UPDATE")}>{t(local.working ? "actionUpdating" : "updateCli")}</button>
    </>}
    {!notice.snoozed && dismissed !== notice.key ? <button type="button" className="button-mini" onClick={() => void sendMessage<{ ok: boolean }>({ type: "SNOOZE_VERSION_NOTICE" }).then(response => { if (response.ok) setDismissed(notice.key); else setFeedback(t("reminderFail")); }, () => setFeedback(t("reminderFail")))}>{t("remindWeek")}</button> : null}
    {(local.feedback || feedback) && <p role="status" className={"action-feedback " + (local.error || local.action?.state === "failed" ? "is-error" : local.action?.state === "waiting" ? "is-waiting" : "")}>{local.feedback || feedback}</p>}
  </aside>;
}
