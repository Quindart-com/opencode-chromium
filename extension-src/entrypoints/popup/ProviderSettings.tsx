import { t } from "../../i18n";
import { useEffect, useState } from "react";
import { sendMessage } from "./api";
import type { DecisionSettings } from "./decision-types";

const providerMessages = new Map<string, string>([
  ["Connected. API key and decision model verified.", "providerSuccess"],
  ["API key rejected. Check the key and selected service.", "providerInvalidKey"],
  ["This key does not have access to the decision model.", "providerDenied"],
  ["Add credits or increase your API key's spending limit.", "providerCredit"],
  ["Service rate limit reached. Try the test again later.", "providerRate"],
  ["Connection timed out. Check your network and try again.", "providerTimeout"],
  ["Check your provider settings and API key.", "providerCheck"],
  ["Invalid provider and service.", "providerCheck"],
  ["Enter an API key or configure the environment variable in Advanced settings.", "providerNeedKey"],
  ["OpenRouter is unavailable. Try again later.", "providerUnavailable"],
  ["Could not reach OpenRouter. Check your network and try again.", "providerNetwork"],
  ["The decision test failed. Settings were not changed; try again later.", "providerDecisionFail"],
]);
const translateProviderMessage = (message: string) => {
  const key = providerMessages.get(message);
  return key ? t(key) : message;
};

const defaults: DecisionSettings = { provider: "off", route: "openrouter", shareText: false, shareImages: false, keyEnv: "OPENROUTER_API_KEY" };
const selection = (settings: DecisionSettings) => settings.provider === "jev" ? `jev-${settings.route}` : settings.provider === "openai-decisions" && settings.route === "openai" ? "openai-direct" : settings.provider;
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
  const jev = settings.provider === "jev";
  useEffect(() => {
    let disposed = false;
    void sendMessage<{ result?: DecisionSettings; error?: string }>({ type: "GET_DECISION_SETTINGS" }).then(response => {
      if (disposed) return;
      if (!response.result) throw new Error("unavailable");
      setSettings(response.result); setLoaded(true);
    }).catch(() => {
      if (!disposed) { setError(true); setMessage(t("connectReopen")); }
    });
    void import("wxt/browser").then(async ({ browser }) => {
      const state = await browser.storage.local.get("localModelDeprecationDismissed");
      if (!disposed) setDismissed(state.localModelDeprecationDismissed === true);
    }).catch(() => {});
    return () => { disposed = true; };
  }, []);
  function choose(value: string) {
    const route = value === "jev-typesafe" ? "typesafe" : value === "openai-direct" ? "openai" : "openrouter";
    setSettings({ ...settings, provider: value === "off" ? "off" : value === "openai-decisions" || value === "openai-direct" ? "openai-decisions" : "jev", route,
      keyEnv: route === "openrouter" ? "OPENROUTER_API_KEY" : route === "openai" ? "OPENAI_API_KEY" : "TYPESAFE_API_KEY", shareImages: false,
      credentialConfigured: route === settings.route && settings.credentialConfigured });
    setApiKey(""); setMessage(""); setTest(null); setError(false);
  }
  async function save() {
    setBusy(true); setError(false); setMessage(""); setTest(null);
    try {
      const next = { ...settings, shareText: enabled, shareImages: enabled && settings.shareImages };
      if (enabled) {
        const response = await sendMessage<{ result?: TestResult }>({ type: "TEST_DECISION_CONNECTION", settings: next, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
        if (!response.result) throw new Error(t("cannotConnect"));
        setTest(response.result); setError(!response.result.ok);
        setMessage(response.result.message ? translateProviderMessage(response.result.message) : t("testFailed"));
        if (response.result.ok && response.result.settings) { setSettings(response.result.settings); setApiKey(""); }
      } else {
        const response = await sendMessage<{ result?: DecisionSettings }>({ type: "SET_DECISION_SETTINGS", settings: next });
        if (!response.result) throw new Error(t("cannotSaveReconnect"));
        setSettings(response.result); setApiKey(""); setMessage(t("decisionOff"));
      }
    } catch (cause) { setError(true); setMessage(cause instanceof Error ? cause.message : t("cannotSaveSettings")); }
    finally { setBusy(false); }
  }
  async function removeKey() {
    setBusy(true);
    try {
      const response = await sendMessage<{ result?: DecisionSettings }>({ type: "REMOVE_DECISION_KEY" });
      if (!response.result) throw new Error(t("cannotRemoveKey"));
      setSettings(response.result); setApiKey(""); setTest(null); setError(false);
      setMessage(t("keyRemoved"));
    } catch { setError(true); setMessage(t("removeKeyFailure")); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    const { browser } = await import("wxt/browser");
    await browser.storage.local.set({ localModelDeprecationDismissed: true }); setDismissed(true);
  }
  return <section className="provider-settings" aria-labelledby="decision-heading">
    <h2 id="decision-heading">{t("decisionAssistance")}</h2>
    <p className="provider-intro">{t("decisionHelp")}</p>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="provider-field">
        <label htmlFor="decision-provider">{t("service")}</label>
        <select id="decision-provider" value={selection(settings)} disabled={!loaded || busy} onChange={event => choose(event.target.value)}>
          <option value="off">{t("serviceOff")}</option>
          <option value="jev-openrouter">Jev · OpenRouter</option>
          <option value="jev-typesafe">Jev · TypeSafe</option>
          <option value="openai-decisions">OpenAI Luna · OpenRouter</option>
          <option value="openai-direct">OpenAI Luna · OpenAI Platform</option>
        </select>
      </div>
      {enabled && <>
        <div className="provider-field">
          <label htmlFor="decision-api-key">{t("apiKey")}</label>
          <input id="decision-api-key" type="password" value={apiKey} spellCheck={false} autoComplete="new-password" maxLength={1024}
            placeholder={settings.credentialConfigured ? t("replaceKey") : t("pasteKey")}
            disabled={busy} onChange={event => { setApiKey(event.target.value); setTest(null); setMessage(""); }} aria-describedby="decision-key-help" />
          <p id="decision-key-help">{t("keyPrivacy")}</p>
        </div>
        <p className="provider-consent">{t("providerConsent", settings.route === "openrouter" ? "OpenRouter" : settings.route === "openai" ? "OpenAI Platform" : "TypeSafe")}</p>
        <label className="checkbox-row"><input type="checkbox" checked={settings.shareImages} disabled={busy} onChange={event => setSettings({ ...settings, shareImages: event.target.checked })} /><span>{t(jev ? "imageFallback" : "imageScreenshots")}<small className="help-note">{t(jev ? "imageJevNotice" : "imageNotice", settings.route === "openrouter" ? "OpenRouter" : settings.route === "openai" ? "OpenAI Platform" : "TypeSafe")}</small></span></label>
        <details className="provider-advanced">
          <summary>{t("envVariable")}</summary>
          <div className="provider-field">
            <label htmlFor="decision-key-env">{t("variableName")}</label>
            <input id="decision-key-env" value={settings.keyEnv} pattern="[A-Z_][A-Z0-9_]*" required spellCheck={false} autoComplete="off" disabled={busy}
              onChange={event => setSettings({ ...settings, keyEnv: event.target.value })} />
            <p>{t("environmentAlternative")}</p>
          </div>
          {settings.credentialConfigured && <button type="button" className="provider-dismiss" disabled={busy} onClick={() => void removeKey()}>{t("removeKey")}</button>}
        </details>
      </>}
      <div className="provider-save-row">
        <button className="provider-save" type="submit" disabled={!loaded || busy}>{t(busy ? "testing" : enabled ? "saveTest" : "saveSettings")}</button>
      </div>
      {enabled && <p className="provider-test-help">{t("testKeyHelp")}</p>}
      <p className={`provider-feedback${error ? " provider-feedback-error" : test?.ok ? " provider-feedback-ok" : ""}`} role="status" aria-live="polite">
        {message || (!loaded ? t("loadingSettings") : settings.ready ? t("decisionEnabled") : enabled ? t("saveTestEnable") : t("localSearchActive"))}
        {test?.elapsedMs !== undefined && <span className="provider-timing">{test.authMs !== undefined ? `${t("keyCheck", String(Math.round(test.authMs)))} ` : ""}{t("decision")} {Math.round(test.elapsedMs)} ms
          {test.usage ? ` · ${t("inputTokens", String(test.usage.input_tokens))}${test.usage.cost !== undefined ? ` · $${test.usage.cost.toFixed(6)}` : ""}` : ""}</span>}
      </p>
    </form>
    {!dismissed && <details className="provider-migration">
      <summary>{t("modelMigration")}</summary>
      <p>{t("migrationText")}</p>
      <button className="provider-dismiss" type="button" onClick={() => void dismiss().catch(() => { setError(true); setMessage(t("dismissFailure")); })}>{t("dismissNotice")}</button>
    </details>}
  </section>;
}
