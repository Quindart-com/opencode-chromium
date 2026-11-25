import { useEffect,useRef,useState } from "react";
import { browser } from "wxt/browser";
import { t } from "../../i18n";
import { sendMessage } from "./api";

type Settings = { enabled: boolean; configured: boolean; environmentDisabled: boolean; browserAllowed?: boolean };
export default function TelemetrySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  useEffect(() => {
    let disposed = false;
    void sendMessage<{ result?: Settings; error?: string }>({ type: "GET_TELEMETRY_SETTINGS" }).then(reply => {
      if (!reply.result) throw new Error(t("diagnosticsLoadFail"));
      if (!disposed) setSettings(reply.result);
    }).catch(() => { if (!disposed) setError(t("diagnosticsLoadFail")); });
    return () => { disposed = true; };
  }, []);
  async function change(enabled: boolean) {
    if (saving.current || !settings) return;
    saving.current = true; setBusy(true); setError("");
    try {
      if (enabled && settings.browserAllowed === false) {
        const granted = await browser.permissions.request({ data_collection: ["technicalAndInteraction"] } as unknown as Parameters<typeof browser.permissions.request>[0]);
        if (!granted) { setError(t("diagnosticsBrowserPermission")); return; }
      }
      const reply = await sendMessage<{ result?: Settings; error?: string }>({ type: "SET_TELEMETRY_SETTINGS", enabled });
      if (!reply.result) throw new Error(t("diagnosticsSaveFail"));
      setSettings(reply.result);
    } catch { setError(t("diagnosticsSaveFail")); }
    finally { saving.current = false; setBusy(false); }
  }
  const enabled = settings?.enabled === true && settings.browserAllowed !== false;
  return <section className="setting-row upload-settings compact-upload" aria-labelledby="diagnostics-title">
    <div><h2 id="diagnostics-title">{t("anonymousDiagnostics")}</h2><small id="diagnostics-copy">{t("diagnosticsDescription")}</small></div>
    <button type="button" role="switch" aria-label={t("anonymousDiagnostics")} aria-describedby="diagnostics-copy" aria-checked={enabled}
      className={`switch${enabled ? " on" : ""}`} disabled={busy || !settings || settings.environmentDisabled}
      onClick={event => { if (event.nativeEvent.isTrusted) void change(!enabled); }}><span /></button>
    {error && <p role="alert" className="upload-error">{error}</p>}
  </section>;
}
