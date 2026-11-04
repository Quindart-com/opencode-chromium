import { useEffect,useState } from "react";
import { createRoot } from "react-dom/client";
import { setDocumentLanguage,t } from "../../i18n";
import { formatBytes,sendMessage } from "../popup/api";
import "../popup/popup.css";

type UploadRequest = { destination: string; files: Array<{ name: string; path: string; size: number; preview?: string }> };
type FailedRequest = { preparationFailed: true; nothingSent: true; newRequestAvailable: boolean };
function ConfirmUpload() {
  const token = new URL(location.href).searchParams.get("token");
  const [request, setRequest] = useState<UploadRequest | null>(null);
  const [failure, setFailure] = useState<FailedRequest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void sendMessage<{ result?: UploadRequest | FailedRequest; error?: string }>({ type: "GET_UPLOAD_REQUEST", token }).then(reply => {
      if (disposed) return;
      if (!reply.result || reply.error) { setError(t("uploadExpired")); return; }
      if ("preparationFailed" in reply.result && reply.result.nothingSent === true) setFailure(reply.result);
      else if ("files" in reply.result) setRequest(reply.result);
    }).catch(() => { if (!disposed) setError(t("uploadRequestUnavailable")); });
    return () => { disposed = true; };
  }, [token]);
  useEffect(() => {
    if (!failure) return;
    let pending = false, disposed = false;
    const timer = setInterval(() => {
      if (pending || document.hidden) return;
      pending = true;
      void sendMessage<{ result?: FailedRequest }>({ type: "GET_UPLOAD_REQUEST", token }).then(reply => {
        if (!disposed && reply.result?.preparationFailed && reply.result.nothingSent === true) setFailure(reply.result);
      }).catch(() => {}).finally(() => { pending = false; });
    }, 2000);
    return () => { disposed = true; clearInterval(timer); };
  }, [!!failure, token]);
  async function decide(allow: boolean) {
    setBusy(true);
    try {
      const reply = await sendMessage<{ error?: string }>({ type: "RESOLVE_UPLOAD_REQUEST", token, allow });
      if (reply.error) throw new Error("unavailable");
      window.close();
    } catch { setError(t("uploadRequestUnavailable")); setBusy(false); }
  }
  async function reviewNew() {
    setBusy(true);
    try {
      const reply = await sendMessage<{ result?: { reviewing?: boolean } }>({ type: "REVIEW_UPLOAD_REQUEST", token });
      if (reply.result?.reviewing) window.close();
      else setError(t("uploadNewUnavailable"));
    } catch { setError(t("uploadRequestUnavailable")); }
    finally { setBusy(false); }
  }
  return <main className={`upload-confirm${failure ? " preparation-failure" : ""}`}>
    <header className="upload-identity"><img src="/images/icon32.png" width="24" height="24" alt="" /><span>OpenCode Browser</span></header>
    {failure ? <section className="failure-content" aria-labelledby="failure-title">
      <h1 id="failure-title">{t("uploadPreparationTitle")}</h1>
      <p>{t("uploadPreparationDetails")}</p>
      <p id="approval-unavailable">{t("uploadApprovalUnavailable")}</p>
      <div className="review-actions">
        <button type="button" className="button button-primary" disabled={busy || !failure.newRequestAvailable} aria-describedby="approval-unavailable" title={t("uploadNewUnavailable")} onClick={event => { if (event.nativeEvent.isTrusted) void reviewNew(); }}>{t("uploadReviewNew")}</button>
        <button type="button" className="button" autoFocus disabled={busy} onClick={event => { if (event.nativeEvent.isTrusted) void decide(false); }}>{t("uploadCancelRequest")}</button>
        <button type="button" className="button" disabled aria-describedby="approval-unavailable">{t("uploadBackPreview")}</button>
      </div>
    </section> : <>
      <h1>{t("uploadTitle")}</h1>
      {request ? <>
        <p>{t(request.files.length === 1 ? "uploadSendOne" : "uploadSendMany")}</p>
        <p className="upload-destination">{request.destination}</p>
        <p>{t("uploadWebsiteWarning")}</p>
        <ul className="upload-files">{request.files.map((file, index) => <li key={index}>
          {file.preview && <img className="upload-preview" src={file.preview} alt={t("uploadPreview", [file.name])} />}
          <div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span><details><summary>{t("uploadFileLocation")}</summary><p>{file.path}</p></details></div>
        </li>)}</ul>
        <p className="upload-expiry">{t("uploadExpiry")}</p>
        <div className="upload-actions">
          <button className="button" autoFocus disabled={busy} onClick={event => { if (event.nativeEvent.isTrusted) void decide(false); }}>{t("uploadCancel")}</button>
          <button className="button button-primary" disabled={busy || !!error} onClick={event => { if (event.nativeEvent.isTrusted) void decide(true); }}>{t(busy ? "uploadSaving" : "uploadAllow")}</button>
        </div>
      </> : !error && <p role="status">{t("uploadLoading")}</p>}
    </>}
    {error && <p role="alert" className="upload-error">{error}</p>}
  </main>;
}
setDocumentLanguage();
document.title = `${t("uploadTitle")} · OpenCode Browser`;
const root = document.getElementById("root");
if (!root) throw new Error("Missing upload confirmation root");
createRoot(root).render(<ConfirmUpload />);
