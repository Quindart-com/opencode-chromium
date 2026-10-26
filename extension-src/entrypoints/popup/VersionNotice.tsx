import { t } from "../../i18n";
import { useState } from "react";
import { browser } from "wxt/browser";
import { versionNotice } from "../../version-status";
import { sendMessage, type NativeStatus } from "./api";

export default function VersionNotice({ status, showSnoozed }: { status: NativeStatus; showSnoozed: boolean }) {
  const extension = browser.runtime.getManifest().version;
  const notice = versionNotice(extension, status);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  if (!notice || (!showSnoozed && (notice.snoozed || dismissed === notice.key))) return null;
  const command = `npm install -g opencode-chromium@${notice?.kind === "unknown" ? "latest" : extension}`;

  return <aside className="card version-notice" aria-label={t("versionNotice")}>
    <h2>{notice.kind === "extension" ? t("versionBehind") : notice.kind === "unknown" ? t("checkToolVersion") : t("updateTools")}</h2>
    <p>{notice.kind === "unknown" ? t("versionMissing") : t("versionMismatch")}</p>
    <p className="help-note">{t("extensionLabel")}{" "}{extension} · {t("localHost")} {notice.host ?? t("memoryUnknown")}{notice.clients.length ? ` · ${t("connectedClients", notice.clients.join(", "))}` : ` · ${t("noClientVersion")}`}</p>
    <details open={showSnoozed}><summary>{t("howUpdate")}</summary>
    {notice.kind === "extension" ? <p>{t("storeAutoUpdate")}</p> : <>
      <p>{t("globalNpm")}</p>
      <code className="update-command">{command}</code>
      <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(command).then(() => setFeedback(t("updateCopied")), () => setFeedback(t("updateCopyFail")))}>{t("copyUpdate")}</button>
      <p>{t("postUpdateMaster")}</p>
    </>}
    <details><summary>{t("updateHelp")}</summary><p>{t("updateInstallHelp")}</p><a href="https://github.com/Quindart-com/opencode-chromium#native-host-and-extension" target="_blank" rel="noopener noreferrer">{t("openSetup")}</a></details>
    </details>
    {!notice.snoozed && dismissed !== notice.key ? <button type="button" className="button-mini" onClick={() => void sendMessage<{ ok: boolean }>({ type: "SNOOZE_VERSION_NOTICE" }).then((response) => { if (response.ok) setDismissed(notice.key); else setFeedback(t("reminderFail")); }, () => setFeedback(t("reminderFail")))}>{t("remindWeek")}</button> : <p className="help-note">{t("snoozed")}</p>}
    <p role="status" className="feedback">{feedback}</p>
  </aside>;
}
