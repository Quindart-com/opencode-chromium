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

  return <aside className="card version-notice" aria-label="Version update notice">
    <h2>{notice.kind === "extension" ? "Your extension is behind your local tools" : notice.kind === "unknown" ? "Check your local tool version" : "Update your local browser tools"}</h2>
    <p>{notice.kind === "unknown" ? "A local component does not report its version, so we cannot check whether everything matches." : "Your installed versions differ. Keeping them aligned helps avoid unexpected browser errors."}</p>
    <p className="help-note">Extension {extension} · Local host {notice.host ?? "unknown"}{notice.clients.length ? ` · Connected CLI/MCP ${notice.clients.join(", ")}` : " · No client version reported"}</p>
    <details open={showSnoozed}><summary>How to update</summary>
    {notice.kind === "extension" ? <p>Chrome Web Store updates install automatically. Check for an extension update; if the release is still under review, wait for approval. You do not need to downgrade your local tools.</p> : <>
      <p>For a global npm installation, run:</p>
      <code className="update-command">{command}</code>
      <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(command).then(() => setFeedback("Update command copied."), () => setFeedback("Could not copy. Select the command above."))}>Copy update command</button>
      <p>Then restart your browser and agent app. If you use npx or a pinned client configuration, update that package version too.</p>
    </>}
    <details><summary>Need help updating?</summary><p>Update the installation used by your native host. If the notice remains after restarting, rerun the native-host setup for that installation.</p><a href="https://github.com/Quindart-com/opencode-chromium#native-host-and-extension" target="_blank" rel="noopener noreferrer">Open setup instructions</a></details>
    </details>
    {!notice.snoozed && dismissed !== notice.key ? <button type="button" className="button-mini" onClick={() => void sendMessage<{ ok: boolean }>({ type: "SNOOZE_VERSION_NOTICE" }).then((response) => { if (response.ok) setDismissed(notice.key); else setFeedback("Could not save the reminder. Please try again."); }, () => setFeedback("Could not save the reminder. Please try again."))}>Remind me in a week</button> : <p className="help-note">Reminder snoozed. These instructions remain available in Settings.</p>}
    <p role="status" className="feedback">{feedback}</p>
  </aside>;
}
