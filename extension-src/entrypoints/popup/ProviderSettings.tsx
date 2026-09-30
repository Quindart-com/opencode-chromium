import { useEffect, useState } from "react";
import { sendMessage } from "./api";

type Settings = { provider: "off" | "jev" | "openai-decisions"; shareText: boolean; shareImages: boolean;
  route: "typesafe" | "openrouter"; keyEnv: string; ready?: boolean; reason?: string | null };
const defaults: Settings = { provider: "off", route: "typesafe", shareText: false, shareImages: false, keyEnv: "TYPESAFE_API_KEY" };
const selection = (settings: Settings) => settings.provider === "jev" ? `jev-${settings.route}` : settings.provider;
const editable = ({ provider, route, keyEnv, shareText, shareImages }: Settings) => JSON.stringify({ provider, route, keyEnv, shareText, shareImages });

export default function ProviderSettings() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const [saved, setSaved] = useState<Settings>(defaults);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const enabled = settings.provider === "jev";
  const dirty = editable(settings) !== editable(saved);
  useEffect(() => {
    let disposed = false;
    void sendMessage<{ result?: Settings; error?: string }>({ type: "GET_DECISION_SETTINGS" }).then(response => {
      if (disposed) return;
      if (!response.result) throw new Error(response.error ?? "Connect the native host to load provider settings.");
      setSettings(response.result);
      setSaved(response.result);
      setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError(true); setMessage("Connect the native host, then reopen Settings."); }
    }).finally(() => { if (!disposed) setLoading(false); });
    void import("wxt/browser").then(async ({ browser }) => {
      const state = await browser.storage.local.get("localModelDeprecationDismissed");
      if (!disposed) setDismissed(state.localModelDeprecationDismissed === true);
    }).catch(() => { /* Keep the notice visible when storage is unavailable. */ });
    return () => { disposed = true; };
  }, []);
  function choose(value: string) {
    if (value === "off") {
      setSettings({ ...settings, provider: "off" });
      setMessage(""); setError(false);
      return;
    }
    const route = value === "jev-openrouter" ? "openrouter" : "typesafe";
    setSettings({ ...settings, provider: value.startsWith("jev-") ? "jev" : "off", route,
      keyEnv: value.startsWith("jev-") && route !== settings.route ? (route === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY") : settings.keyEnv,
      shareImages: false });
    setMessage("");
    setError(false);
  }
  async function save() {
    setBusy(true);
    setError(false);
    try {
      const response = await sendMessage<{ result?: Settings; error?: string }>({ type: "SET_DECISION_SETTINGS", settings });
      if (response.error || !response.result) throw new Error(response.error ?? "Connect the native host and try again.");
      setSettings(response.result);
      setSaved(response.result);
      setMessage("Changes saved.");
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : "Could not save. Try again."); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    try {
      const { browser } = await import("wxt/browser");
      await browser.storage.local.set({ localModelDeprecationDismissed: true });
      setDismissed(true);
    } catch { setError(true); setMessage("Could not dismiss the notice. Try again."); }
  }
  const status = loading ? "Loading settings…" : dirty ? "Unsaved changes" : saved.provider === "off" ? "Cloud assistance is off" : saved.ready ? "Ready to use" : !saved.shareText ? "Text sharing is off" : "Credential needed";
  return <section className="provider-settings" aria-labelledby="decision-heading">
    <div className="provider-heading"><h2 id="decision-heading">Decision assistance</h2><span className="provider-experimental">Experimental</span></div>
    <p className="provider-intro">Help find the right target on a page. Your agent still controls actions and approvals.</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="provider-field">
        <label htmlFor="decision-provider">Provider</label>
        <select id="decision-provider" value={selection(settings)} disabled={!loaded || busy} onChange={event => choose(event.target.value)}>
          <option value="off">Off · Use local retrieval</option>
          <option value="jev-openrouter">Jev via OpenRouter</option>
          <option value="jev-typesafe">Jev via TypeSafe</option>
          <option value="openai-decisions" disabled>OpenAI Luna · Preview unavailable</option>
        </select>
      </div>
      {enabled && <>
        <label className="provider-sharing" htmlFor="decision-share-text">
          <span className="provider-sharing-copy"><span>Share page text</span><span id="decision-sharing-help">Send search queries and candidate labels/text to {settings.route === "openrouter" ? "OpenRouter" : "TypeSafe"}. Screenshots are never sent.</span></span>
          <input id="decision-share-text" type="checkbox" role="switch" aria-describedby="decision-sharing-help" checked={settings.shareText} disabled={loading || busy} onChange={event => { setSettings({ ...settings, shareText: event.target.checked }); setMessage(""); }} />
          <span className="provider-switch" aria-hidden="true" />
        </label>
        <details className="provider-advanced">
          <summary>Connection settings</summary>
          <div className="provider-field">
            <label htmlFor="decision-key-env">Credential variable</label>
            <input id="decision-key-env" value={settings.keyEnv} pattern="[A-Z_][A-Z0-9_]*" required spellCheck={false} autoComplete="off" aria-describedby="decision-key-help" disabled={busy} onChange={event => { setSettings({ ...settings, keyEnv: event.target.value }); setMessage(""); }} />
            <p id="decision-key-help">Use an environment variable name, not your API key. Set its value in the native host environment.</p>
          </div>
        </details>
      </>}
      <div className="provider-save-row">
        <p className={`provider-feedback${error ? " provider-feedback-error" : ""}`} role="status" aria-live="polite">{message || status}</p>
        <button className="provider-save" type="submit" disabled={loading || busy || !dirty}>{busy ? "Saving…" : "Save changes"}</button>
      </div>
    </form>
    {!dismissed && <details className="provider-migration">
      <summary>Local models are changing</summary>
      <p>Embedded models are deprecated and will move to an optional package. They stay available during migration, with at least 90 days’ notice before removal. Your memory records and cached models are preserved.</p>
      <button className="provider-dismiss" type="button" onClick={() => void dismiss()}>Dismiss notice</button>
    </details>}
  </section>;
}
