import { useEffect,useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { setDocumentLanguage,t } from "../../i18n";
import "./welcome.css";

const setupCommand = "npx -y opencode-chromium@latest setup --all";
const repository = "https://github.com/Quindart-com/opencode-chromium";

function Welcome() {
  const updated = new URLSearchParams(location.search).get("view") === "updated";
  const version = browser.runtime.getManifest().version;
  const firefox = browser.runtime.getURL("/").startsWith("moz-extension:");
  const [feedback, setFeedback] = useState("");
  const [showUpdates, setShowUpdates] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void browser.storage.local.get("showReleaseNotes").then(value => setShowUpdates(value.showReleaseNotes !== false)).catch(() => setFeedback(t("welcomeReadFailure"))).finally(() => setLoaded(true));
  }, []);
  async function copySetup() {
    try { await navigator.clipboard.writeText(setupCommand); setFeedback(t("welcomeCopied")); }
    catch { setFeedback(t("welcomeCopyFailure")); }
  }
  async function toggleUpdates(value: boolean) {
    const previous = showUpdates;
    setShowUpdates(value);
    setSaving(true);
    try { await browser.storage.local.set({ showReleaseNotes: value }); setShowUpdates(value); setFeedback(t("welcomeSaved")); }
    catch { setShowUpdates(previous); setFeedback(t("welcomeSaveFailure")); }
    finally { setSaving(false); }
  }
  async function openPanel() {
    try { await browser.action.openPopup(); }
    catch { setFeedback(t("welcomeOpenFailure")); }
  }
  return <main>
    <header><img src="/images/icon128.png" width="40" height="40" alt="" /><a href={repository} target="_blank" rel="noreferrer">OpenCode Browser</a><span className="version">v{version}</span></header>
    <section className="intro">
      <h1>{updated ? t("welcomeUpdated") : t("welcomeIntro")}</h1>
      <p>{updated ? t("welcomeChanges") : t("welcomeDescription")}</p>
    </section>
    {updated ? <section className="changes" aria-labelledby="changes-title">
      <h2 id="changes-title">{t("newRelease")}</h2>
      <ul>
        <li><strong>{t("beforeAfter")}</strong> {t("compareSnapshots")}</li>
        <li><strong>{t("tabPurpose")}</strong> {t("tabGroups")}</li>
        <li><strong>{t("moreContext")}</strong> {t("contextDetails")}</li>
        <li><strong>{t("clearerSetup")}</strong> {t("setupDetails")}</li>
        <li><strong>{t("saferSessions")}</strong> {t("saferDetails")}</li>
      </ul>
      <a className="text-link" href={`https://quindart-com.github.io/opencode-chromium/updates/#v${version}`} target="_blank" rel="noreferrer">{t("readNotes")}</a>
    </section> : <section aria-labelledby="setup-title">
      <h2 id="setup-title">{t("connectAgent")}</h2>
      <p>{t("runTerminal")}</p>
      <div className="command"><code>{setupCommand}</code><button onClick={() => void copySetup()}>{t("copyCommand")}</button></div>
      <p className="hint">{t("reopenAgent")}</p>
      {firefox && <details><summary>{t("firefoxExtra")}</summary><p>{t("welcomeFirefox")}</p><a href={`${repository}/blob/master/docs/firefox.md`} target="_blank" rel="noreferrer">{t("firefoxInstructions")}</a></details>}
      <ol className="steps">
        <li><strong>{t("openExtension")}</strong><span>{t("welcomeOverview")}</span></li>
        <li><strong>{t("askAgent")}</strong><span>{t("welcomeExample")}</span></li>
        <li><strong>{t("chooseSharing")}</strong><span>{t("welcomeSharing")}</span></li>
      </ol>
    </section>}
    <section className="next">
      <div><h2>{t("readyBrowse")}</h2><p>{t("checkConnection")}</p></div>
      <button className="primary" onClick={() => void openPanel()}>{t("openPanel")}</button>
    </section>
    <p className="feedback" role="status">{feedback}</p>
    <footer>
      <label><input type="checkbox" checked={showUpdates} disabled={saving || !loaded} onChange={event => void toggleUpdates(event.target.checked)} />{t("showNotes")}</label>
      <nav aria-label={t("help")}><a href={`${repository}/blob/master/docs/runtime-updates.md#connection-recovery`} target="_blank" rel="noreferrer">{t("help")}</a><a href={`${repository}/blob/master/docs/PRIVACY.md`} target="_blank" rel="noreferrer">{t("privacy")}</a><button className="text-button" onClick={() => window.close()}>{t("closeGuide")}</button></nav>
    </footer>
  </main>;
}

setDocumentLanguage();
document.title = `${t("connectAgent")} · OpenCode Browser`;
createRoot(document.getElementById("root")!).render(<Welcome />);
