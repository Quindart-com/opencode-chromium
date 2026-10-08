import { useEffect, useState } from "react";
import { sendMessage } from "./api";
import type { DecisionSettings } from "./decision-types";

const defaults: DecisionSettings = { provider: "off", route: "openrouter", shareText: false, shareImages: false, keyEnv: "OPENROUTER_API_KEY" };
const selection = (settings: DecisionSettings) => settings.provider === "jev" ? `jev-${settings.route}` : settings.provider;
type TestResult = { ok: boolean; settings?: DecisionSettings; message?: string; elapsedMs?: number; authMs?: number;
  usage?: { input_tokens: number; output_tokens: number; cost?: number } };

export default function ProviderSettings() {
  const [settings, setSettings] = useState(defaults);
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const enabled = settings.provider !== "off";
  const luna = settings.provider === "openai-decisions";
  useEffect(() => {
    let disposed = false;
    void sendMessage<{ result?: DecisionSettings; error?: string }>({ type: "GET_DECISION_SETTINGS" }).then(response => {
      if (disposed) return;
      if (!response.result) throw new Error("unavailable");
      setSettings(response.result); setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError(true); setMessage("Connect the native host, then reopen Settings."); }
    });
    void import("wxt/browser").then(async ({ browser }) => {
      const state = await browser.storage.local.get("localModelDeprecationDismissed");
      if (!disposed) setDismissed(state.localModelDeprecationDismissed === true);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  function choose(value: string) {
    const route = value === "jev-typesafe" ? "typesafe" : "openrouter";
    setSettings({ ...settings, provider: value === "off" ? "off" : value === "openai-decisions" ? "openai-decisions" : "jev", route,
      keyEnv: route === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY", shareImages: false,
      credentialConfigured: route === settings.route && settings.credentialConfigured });
    setApiKey(""); setMessage(""); setTest(null); setError(false);
  }
  async function save() {
    setBusy(true); setError(false); setMessage(""); setTest(null);
    try {
      const next = { ...settings, shareText: enabled, shareImages: luna && settings.shareImages };
      if (enabled) {
        const response = await sendMessage<{ result?: TestResult }>({ type: "TEST_DECISION_CONNECTION", settings: next, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
        if (!response.result) throw new Error("Could not connect to the native host. Reconnect and try again.");
        setTest(response.result); setError(!response.result.ok);
        setMessage(response.result.message ?? "Connection test failed.");
        if (response.result.ok && response.result.settings) { setSettings(response.result.settings); setApiKey(""); }
      } else {
        const response = await sendMessage<{ result?: DecisionSettings }>({ type: "SET_DECISION_SETTINGS", settings: next });
        if (!response.result) throw new Error("Could not save. Reconnect the native host and try again.");
        setSettings(response.result); setApiKey(""); setMessage("Decision assistance is off. Local search and replay stay available.");
      }
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : "Could not save settings."); }
    finally { setBusy(false); }
  }
  async function removeKey() {
    setBusy(true);
    try {
      const response = await sendMessage<{ result?: DecisionSettings }>({ type: "REMOVE_DECISION_KEY" });
      if (!response.result) throw new Error("Could not remove the stored key.");
      setSettings(response.result); setApiKey(""); setTest(null); setError(false);
      setMessage("Stored key removed. An environment key, if configured, remains available.");
    } catch { setError(true); setMessage("Could not remove the key. Reconnect and try again."); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    const { browser } = await import("wxt/browser");
    await browser.storage.local.set({ localModelDeprecationDismissed: true }); setDismissed(true);
  }
  return <section className="provider-settings" aria-labelledby="decision-heading">
    <h2 id="decision-heading">Decision assistance</h2>
    <p className="provider-intro">Find relevant targets and choose saved recipes. Your agent controls the actions; replay keeps its safety checks.</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="provider-field">
        <label htmlFor="decision-provider">Service</label>
        <select id="decision-provider" value={selection(settings)} disabled={!loaded || busy} onChange={event => choose(event.target.value)}>
          <option value="off">Off · Local search and replay</option>
          <option value="jev-openrouter">Jev · OpenRouter</option>
          <option value="jev-typesafe">Jev · TypeSafe</option>
          <option value="openai-decisions">OpenAI Luna · OpenRouter</option>
        </select>
      </div>
      {enabled && <>
        <div className="provider-field">
          <label htmlFor="decision-api-key">API key</label>
          <input id="decision-api-key" type="password" value={apiKey} spellCheck={false} autoComplete="new-password" maxLength={1024}
            placeholder={settings.credentialConfigured ? "Key saved · Enter a replacement" : "Paste your API key"}
            disabled={busy} onChange={event => { setApiKey(event.target.value); setTest(null); setMessage(""); }} aria-describedby="decision-key-help" />
          <p id="decision-key-help">Saved privately by the native host. Never stored in browser storage or returned to your agent.</p>
        </div>
        <p className="provider-consent">Enabling assistance sends bounded search or replay intent and candidate descriptions to {settings.route === "openrouter" ? "OpenRouter" : "TypeSafe"}. Your agent remains in control of actions.</p>
        {luna && <label className="checkbox-row"><input type="checkbox" checked={settings.shareImages} disabled={busy} onChange={event => setSettings({ ...settings, shareImages: event.target.checked })} /><span>Allow screenshots for ambiguous visual targets<small className="help-note">Off by default. One bounded screenshot may be sent to OpenRouter when local search is ambiguous.</small></span></label>}
        <details className="provider-advanced">
          <summary>Advanced · Environment variable</summary>
          <div className="provider-field">
            <label htmlFor="decision-key-env">Variable name</label>
            <input id="decision-key-env" value={settings.keyEnv} pattern="[A-Z_][A-Z0-9_]*" required spellCheck={false} autoComplete="off" disabled={busy}
              onChange={event => setSettings({ ...settings, keyEnv: event.target.value })} />
            <p>Optional alternative to a saved key. The variable must exist in the native host’s environment.</p>
          </div>
          {settings.credentialConfigured && <button type="button" className="provider-dismiss" disabled={busy} onClick={() => void removeKey()}>Remove saved key</button>}
        </details>
      </>}
      <div className="provider-save-row">
        <button className="provider-save" type="submit" disabled={!loaded || busy}>{busy ? "Testing…" : enabled ? "Save & test connection" : "Save settings"}</button>
      </div>
      {enabled && <p className="provider-test-help">Tests your key and selected model with one small, billable synthetic decision.</p>}
      <p className={`provider-feedback${error ? " provider-feedback-error" : test?.ok ? " provider-feedback-ok" : ""}`} role="status" aria-live="polite">
        {message || (!loaded ? "Loading settings…" : settings.ready ? "Decision assistance enabled" : enabled ? "Save and test to enable assistance." : "Local search is active")}
        {test?.elapsedMs !== undefined && <span className="provider-timing">{test.authMs !== undefined ? `Key check ${Math.round(test.authMs)} ms · ` : ""}Decision {Math.round(test.elapsedMs)} ms
          {test.usage ? ` · ${test.usage.input_tokens} input tokens${test.usage.cost !== undefined ? ` · $${test.usage.cost.toFixed(6)}` : ""}` : ""}</span>}
      </p>
    </form>
    {!dismissed && <details className="provider-migration">
      <summary>Local model migration</summary>
      <p>Embedded models are deprecated and will move to an optional package. They stay available during migration, with at least 90 days’ notice before removal. Your memory records and cached models are preserved.</p>
      <button className="provider-dismiss" type="button" onClick={() => void dismiss().catch(() => { setError(true); setMessage("Could not dismiss the notice."); })}>Dismiss notice</button>
    </details>}
  </section>;
}
