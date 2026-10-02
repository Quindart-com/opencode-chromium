import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { sendMessage, formatBytes } from "../popup/api";
import "../popup/popup.css";

type UploadRequest = { destination: string; files: Array<{ name: string; path: string; size: number; preview?: string }> };
function ConfirmUpload() {
  const token = new URL(location.href).searchParams.get("token");
  const [request, setRequest] = useState<UploadRequest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    sendMessage<{ result?: UploadRequest; error?: string }>({ type: "GET_UPLOAD_REQUEST", token }).then(reply => {
      if (!reply.result || reply.error) throw new Error(reply.error ?? "This upload request has expired. Close this window and request the upload again.");
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
    <h1>Allow file upload?</h1>
    {request ? <>
      <p>An agent wants to send {request.files.length === 1 ? "this file" : "these files"} to:</p>
      <p className="upload-destination">{request.destination}</p>
      <p>The website can read and keep the uploaded files.</p>
      <ul className="upload-files">{request.files.map((file, index) => <li key={index}>
        {file.preview && <img className="upload-preview" src={file.preview} alt={`Preview of ${file.name}`} />}
        <div><strong>{file.name}</strong><span>{formatBytes(file.size)}</span><details><summary>File location</summary><p>{file.path}</p></details></div>
      </li>)}</ul>
      <p className="upload-expiry">This request expires after one minute. Closing the window cancels the upload.</p>
      <div className="upload-actions">
        <button className="button" autoFocus disabled={busy} onClick={event => { if (event.nativeEvent.isTrusted) void decide(false); }}>Cancel upload</button>
        <button className="button button-primary" disabled={busy || !!error} onClick={event => { if (event.nativeEvent.isTrusted) void decide(true); }}>{busy ? "Saving decision…" : "Allow upload"}</button>
      </div>
    </> : !error && <p role="status">Loading upload request…</p>}
    {error && <p role="alert" className="upload-error">{error}</p>}
  </main>;
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing upload confirmation root");
createRoot(root).render(<ConfirmUpload />);
