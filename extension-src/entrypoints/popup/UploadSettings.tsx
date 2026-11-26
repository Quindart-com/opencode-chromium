import { useEffect,useState } from "react";
import { t } from "../../i18n";
import { sendMessage } from "./api";

export default function UploadSettings({ compact = false }: { compact?: boolean }) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    sendMessage<{ result?: { allowWithoutConfirmation: boolean }; error?: string }>({ type: "GET_UPLOAD_SETTINGS" })
      .then(reply => {
        if (typeof reply.result?.allowWithoutConfirmation !== "boolean" || reply.error) throw new Error(reply.error ?? t("settingsStatusUnavailable"));
        if (!disposed) setAllowed(reply.result.allowWithoutConfirmation);
      })
      .catch(reason => { if (!disposed) setError(String(reason.message ?? reason)); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  async function change(value: boolean) {
    if (busy || allowed === null) return;
    const previous = allowed; setAllowed(value);
    setBusy(true); setError("");
    try {
      const reply = await sendMessage<{ result?: { allowWithoutConfirmation: boolean }; error?: string }>({ type: "SET_UPLOAD_SETTINGS", allowWithoutConfirmation: value });
      if (reply.error || typeof reply.result?.allowWithoutConfirmation !== "boolean") throw new Error(reply.error ?? t("uploadSaveFail"));
      setAllowed(reply.result.allowWithoutConfirmation);
    } catch (reason) { setAllowed(previous); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  const disabled = busy || allowed === null;
  if (compact) return <section className="setting-row upload-settings compact-upload" aria-labelledby="upload-settings-title" aria-busy={busy}>
    <div><h2 id="upload-settings-title">{t("fileUploads")}</h2><small id="upload-permission-copy">{t(allowed === null ? busy ? "loadingSettings" : "memoryUnavailableShort" : allowed ? "uploadsWithoutAsking" : "alwaysAskUploads")}</small></div>
    <button type="button" role="switch" aria-label={t("allowUnconfirmed")} aria-describedby="upload-permission-copy" aria-checked={allowed === true} className={`switch${allowed ? " on" : ""}`} disabled={disabled} onClick={event => { if (event.nativeEvent.isTrusted) void change(!allowed); }}><span /></button>
    {error && <p role="alert" className="upload-error">{error}</p>}
  </section>;
  return <section className="card upload-settings" aria-labelledby="upload-settings-title">
    <h2 id="upload-settings-title">{t("fileUploads")}</h2>
    <label className="upload-preference"><input type="checkbox" checked={allowed === true} disabled={disabled} aria-describedby="upload-permission-copy" onChange={event => { if (event.nativeEvent.isTrusted) void change(event.target.checked); }} /> {t("allowUnconfirmed")}</label>
    <p id="upload-permission-copy">{t("uploadDefault")}</p>
    <p className="upload-risk">{t("uploadRisk")}</p>
    {error && <p role="alert" className="upload-error">{error}</p>}
  </section>;
}
