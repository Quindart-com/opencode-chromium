import { useCallback,useEffect,useRef,useState } from "react";
import { harnessLabels,type ConnectionSnapshot } from "../../../src/shared/connections.ts";
import { t } from "../../i18n";
import { errorMessage,sendMessage,type NativeStatus } from "./api";

const doctor = "opencode-chromium doctor --repair-runtime --json";
export default function HarnessConnections({ status }: { status: NativeStatus }) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const operation = useRef(0);
  const connected = status.state === "connected";
  const refresh = useCallback(async () => {
    const revision = ++operation.current;
    try {
      const response = await sendMessage<{ result?: ConnectionSnapshot; error?: string }>({ type: "GET_HARNESS_CONNECTIONS" });
      if (revision !== operation.current) return;
      setSnapshot(response.result ?? null);
      setMessage(response.result ? "" : t("connectionsUnsupported"));
    } catch { if (revision === operation.current) { setSnapshot(null); setMessage(t("connectionsUnavailable")); } }
  }, []);
  useEffect(() => {
    if (!connected) { operation.current++; setSnapshot(null); return; }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { window.clearInterval(timer); operation.current++; };
  }, [connected, refresh]);
  async function control(type: "DISCONNECT_HARNESS" | "RECONNECT_NATIVE_HOST", id?: string) {
    operation.current++; setBusy(true); setConfirm(null);
    try {
      const response = await sendMessage<{ error?: string }>({ type, params: { id } });
      if (response.error) throw new Error(response.error);
      setSnapshot(null); setMessage(type === "DISCONNECT_HARNESS" ? t("harnessDisconnected") : t("bridgeReconnecting"));
      if (type === "DISCONNECT_HARNESS") await refresh();
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const clients = connected ? snapshot?.clients ?? [] : [];
  return <section className="card harness-connections" aria-labelledby="harness-connections-title">
    <div className="connection-summary-heading"><h2 id="harness-connections-title">{t("harnessConnections")}</h2><button className="button-mini" disabled={busy || !connected} onClick={() => void refresh()}>{t("refreshConnections")}</button></div>
    <p className="help-note">{t("connectionLayers")}</p>
    <dl className="bridge-details"><dt>{t("localBridge")}</dt><dd>{connected ? t("bridgeResponding") : t("bridgeUnavailable")}{snapshot ? ` · v${snapshot.host.version ?? "?"} · PID ${snapshot.host.pid}` : ""}</dd></dl>
    {connected && !snapshot && <p role="status">{message || t("checkingConnection")}</p>}
    {snapshot && <>
      {clients.length === 0 && <p className="connection-empty">{t("noHarnessConnections")}</p>}
      <ul className="harness-list">{clients.map(client => <li key={client.id} className={`harness-row state-${client.state}`}>
        <div className="harness-row-title"><strong>{harnessLabels[client.harness] ?? harnessLabels.mcp}</strong><span>{t(client.state === "responding" ? "harnessResponding" : client.state === "stale" ? "harnessStale" : "harnessUnidentified")}</span></div>
        <p>{client.transport.toUpperCase()} · {t("runtimeVersionLabel")} {client.runtimeVersion ?? "?"}{client.pid ? ` · PID ${client.pid}` : ""}{client.harnessVersion ? ` · ${t("harnessVersionLabel")} ${client.harnessVersion}` : ""}</p>
        <p>{t(client.phase === "used" ? "harnessToolReceived" : "harnessInitialized")}{client.pending ? ` · ${t("harnessPending", String(client.pending))}` : ""}</p>
        <p className="help-note">{t("harnessLastSeen", new Date(client.lastSeenAt).toLocaleTimeString())}</p>
        {confirm === client.id ? <div className="connection-controls"><p>{t("disconnectHarnessConfirm")}</p><button className="button" onClick={() => void control("DISCONNECT_HARNESS", client.id)} disabled={busy}>{t("disconnectBridge")}</button><button className="button-mini" onClick={() => setConfirm(null)}>{t("cancelConnectionAction")}</button></div> : <button className="button-mini" disabled={busy || client.pending > 0} onClick={() => setConfirm(client.id)}>{t("disconnectBridge")}</button>}
      </li>)}</ul>
      <p className="help-note">{t("harnessToolsExplanation")}</p>
    </>}
    <div className="connection-controls"><button className="button" disabled={busy} onClick={() => void control("RECONNECT_NATIVE_HOST")}>{t("reconnectBridge")}</button><button className="button-mini" onClick={() => { void navigator.clipboard.writeText(doctor).then(() => setMessage(t("doctorCopied")), () => setMessage(t("copyUnavailable"))); }}>{t("copyDoctor")}</button></div>
    <details className="advanced-details"><summary>{t("reconnectHarnessHelp")}</summary><p>{t("reconnectCodexHelp")}</p><p>{t("reconnectOpenCodeHelp")}</p><p>{t("reconnectDshHelp")}</p><code className="setup-command">{doctor}</code></details>
    <p role="status" className="feedback">{message}</p>
  </section>;
}
