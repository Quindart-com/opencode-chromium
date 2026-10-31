import { useEffect,useState } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";
import { setDocumentLanguage } from "../../i18n";
import { formatBytes,sendMessage } from "../popup/api";
import "../popup/popup.css";

type UploadRequest = { destination: string; files: Array<{ name: string; path: string; size: number; preview?: string }> };
function ConfirmUpload() {
  const token = new URL(location.href).searchParams.get("token");
  const [request, setRequest] = useState<UploadRequest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    sendMessage<{ result?: UploadRequest; error?: string }>({ type: "GET_UPLOAD_REQUEST", token }).then(reply => {
      if (!reply.result || reply.error) throw new Error(reply.error ?? browser.i18n.getMessage("uploadExpired"));
      setRequest(reply.result);
    }).catch(reason => setError(String(reason.message ?? reason)));
  }, [token]);
  async function decide(allow: boolean) {
    setBusy(true);
    try {
      const reply = await sendMessage<{ error?: string }>({ type: "RESOLVE_UPLOAD_REQUEST", token, allow });
      if (reply.error) throw new Error(reply.error);
      window.close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
  }
  return <main className="upload-confirm">
    <header className="upload-identity"><img src="/images/icon32.png" width="32" height="32" alt="" /><span>opencode-chromium</span></header>
    <h1>{browser.i18n.getMessage("uploadTitle")}</h1>
    {request ? <>
      <p>{browser.i18n.getMessage(request.files.length === 1 ? "uploadSendOne" : "uploadSendMany")}</p>
      <p className="upload-destination">{request.destination}</p>
      <p>{browser.i18n.getMessage("uploadWebsiteWarning")}</p>
      <ul className="upload-files">{request.files.map((file, index) => <li key={index}>
        {file.preview && <img className="upload-preview" src={file.preview} alt={browser.i18n.getMessage("uploadPreview", [file.name])} />}
        <div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span><details><summary>{browser.i18n.getMessage("uploadFileLocation")}</summary><p>{file.path}</p></details></div>
      </li>)}</ul>
      <p className="upload-expiry">{browser.i18n.getMessage("uploadExpiry")}</p>
      <div className="upload-actions">
        <button className="button" autoFocus disabled={busy} onClick={event => { if (event.nativeEvent.isTrusted) void decide(false); }}>{browser.i18n.getMessage("uploadCancel")}</button>
        <button className="button button-primary" disabled={busy || !!error} onClick={event => { if (event.nativeEvent.isTrusted) void decide(true); }}>{browser.i18n.getMessage(busy ? "uploadSaving" : "uploadAllow")}</button>
      </div>
    </> : !error && <p role="status">{browser.i18n.getMessage("uploadLoading")}</p>}
    {error && <p role="alert" className="upload-error">{error}</p>}
  </main>;
}
setDocumentLanguage();
document.title = `${browser.i18n.getMessage("uploadTitle")} · opencode-chromium`;
const root = document.getElementById("root");
if (!root) throw new Error("Missing upload confirmation root");
createRoot(root).render(<ConfirmUpload />);
