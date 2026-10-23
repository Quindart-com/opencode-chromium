import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
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
    void browser.storage.local.get("showReleaseNotes").then(value => setShowUpdates(value.showReleaseNotes !== false)).catch(() => setFeedback("Could not read your update preference. Try again.")).finally(() => setLoaded(true));
  }, []);
  async function copySetup() {
    try { await navigator.clipboard.writeText(setupCommand); setFeedback("Setup command copied."); }
    catch { setFeedback("Could not copy. Select the command below and copy it manually."); }
  }
  async function toggleUpdates(value: boolean) {
    const previous = showUpdates;
    setShowUpdates(value);
    setSaving(true);
    try { await browser.storage.local.set({ showReleaseNotes: value }); setShowUpdates(value); setFeedback("Update preference saved."); }
    catch { setShowUpdates(previous); setFeedback("Could not save your preference. Try again."); }
    finally { setSaving(false); }
  }
  async function openPanel() {
    try { await browser.action.openPopup(); }
    catch { setFeedback("Open the extension from your browser toolbar to check the connection."); }
  }
  return <main>
    <header><img src="/images/icon128.png" width="40" height="40" alt="" /><a href={repository} target="_blank" rel="noreferrer">OpenCode Browser</a><span className="version">v{version}</span></header>
    <section className="intro">
      <h1>{updated ? "Your browser tools, updated." : "Your browser. Your agent. Connected."}</h1>
      <p>{updated ? "Here’s what’s new, and where to find it." : "Search pages, complete forms and check your work in the browser you already use. Start with one setup command."}</p>
    </section>
    {updated ? <section className="changes" aria-labelledby="changes-title">
      <h2 id="changes-title">New in this release</h2>
      <ul>
        <li><strong>Before and after.</strong> Compare page snapshots or pixels to see exactly what changed.</li>
        <li><strong>Tabs with a purpose.</strong> Agents can name their session’s tab group.</li>
        <li><strong>More page context.</strong> Bounded frame inspection and experimental WebMCP discovery.</li>
        <li><strong>Clearer setup.</strong> Connection guidance, a steadier panel layout and improved harness installation.</li>
        <li><strong>Safer sessions.</strong> Scoped downloads, URL policy checks and cleanup of browser overrides.</li>
      </ul>
      <a className="text-link" href={`https://quindart-com.github.io/opencode-chromium/updates/#v${version}`} target="_blank" rel="noreferrer">Read the release notes</a>
    </section> : <section aria-labelledby="setup-title">
      <h2 id="setup-title">Connect your coding agent</h2>
      <p>Run this in a terminal. Setup connects the supported harnesses it finds and registers the browser’s native host.</p>
      <div className="command"><code>{setupCommand}</code><button onClick={() => void copySetup()}>Copy command</button></div>
      <p className="hint">Then reopen your desktop agent, or reconnect MCP in your terminal client.</p>
      {firefox && <details><summary>Firefox and LibreWolf need one extra launch step</summary><p>Trusted clicks, typing and dialogs require Firefox’s Remote Agent. Enable it on a loopback port, then connect the matching browser profile. The add-on alone cannot provide this control.</p><a href={`${repository}/blob/master/docs/firefox.md`} target="_blank" rel="noreferrer">Firefox launch instructions</a></details>}
      <ol className="steps">
        <li><strong>Open the extension.</strong><span>Overview checks the local runtime. Profiles lets you name this browser, such as “work” or “personal.”</span></li>
        <li><strong>Ask your agent to browse.</strong><span>Try: “Open example.com in my personal browser and describe the page.”</span></li>
        <li><strong>Choose what you share.</strong><span>Settings keeps decision assistance off by default. Screenshot sharing is a separate opt-in; uploads ask for confirmation.</span></li>
      </ol>
    </section>}
    <section className="next">
      <div><h2>Ready to browse?</h2><p>Check the connection in Overview, then return to your agent.</p></div>
      <button className="primary" onClick={() => void openPanel()}>Open extension panel</button>
    </section>
    <p className="feedback" role="status">{feedback}</p>
    <footer>
      <label><input type="checkbox" checked={showUpdates} disabled={saving || !loaded} onChange={event => void toggleUpdates(event.target.checked)} />Show release notes after updates</label>
      <nav aria-label="Help"><a href={`${repository}/blob/master/docs/troubleshooting.md`} target="_blank" rel="noreferrer">Help</a><a href={`${repository}/blob/master/docs/PRIVACY.md`} target="_blank" rel="noreferrer">Privacy</a><button className="text-button" onClick={() => window.close()}>Close this guide</button></nav>
    </footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Welcome />);
