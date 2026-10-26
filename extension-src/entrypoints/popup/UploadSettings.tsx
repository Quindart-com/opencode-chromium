import { t } from "../../i18n";
import { useEffect, useState } from "react";
import { sendMessage } from "./api";

export default function UploadSettings() {
  const [allowed, setAllowed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    sendMessage<{ result?: { allowWithoutConfirmation: boolean }; error?: string }>({ type: "GET_UPLOAD_SETTINGS" })
      .then(reply => { if (reply.error) throw new Error(reply.error); if (!disposed) setAllowed(reply.result?.allowWithoutConfirmation === true); })
      .catch(reason => { if (!disposed) setError(String(reason.message ?? reason)); })
      .finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, []);
  async function change(value: boolean) {
    const previous = allowed; setAllowed(value);
    setBusy(true); setError("");
    try {
      const reply = await sendMessage<{ result?: { allowWithoutConfirmation: boolean }; error?: string }>({ type: "SET_UPLOAD_SETTINGS", allowWithoutConfirmation: value });
      if (reply.error || !reply.result) throw new Error(reply.error ?? t("uploadSaveFail"));
      setAllowed(reply.result.allowWithoutConfirmation);
    } catch (reason) { setAllowed(previous); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="card upload-settings" aria-labelledby="upload-settings-title">
    <h2 id="upload-settings-title">{t("fileUploads")}</h2>
    <label className="upload-preference"><input type="checkbox" checked={allowed} disabled={busy} aria-describedby="upload-permission-copy" onChange={event => { if (event.nativeEvent.isTrusted) void change(event.target.checked); }} /> {t("allowUnconfirmed")}</label>
    <p id="upload-permission-copy">{t("uploadDefault")}</p>
    <p className="upload-risk">{t("uploadRisk")}</p>
    {error && <p role="alert" className="upload-error">{error}</p>}
  </section>;
}
