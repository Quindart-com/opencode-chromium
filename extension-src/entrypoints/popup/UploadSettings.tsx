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
      if (reply.error || !reply.result) throw new Error(reply.error ?? "Could not save upload preference");
      setAllowed(reply.result.allowWithoutConfirmation);
    } catch (reason) { setAllowed(previous); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="card upload-settings" aria-labelledby="upload-settings-title">
    <h2 id="upload-settings-title">File uploads</h2>
    <label className="upload-preference"><input type="checkbox" checked={allowed} disabled={busy} aria-describedby="upload-permission-copy" onChange={event => { if (event.nativeEvent.isTrusted) void change(event.target.checked); }} /> Allow uploads without confirmation</label>
    <p id="upload-permission-copy">Off by default. Review the file names and destination, then allow or cancel each upload. Closing the request cancels it.</p>
    <p className="upload-risk">Turning this on lets agents send any accessible local file, including images and private documents, to websites without asking you. Websites can read and keep the uploaded files. File access restrictions still apply.</p>
    {error && <p role="alert" className="upload-error">{error}</p>}
  </section>;
}
