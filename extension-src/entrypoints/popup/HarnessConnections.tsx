import { useCallback,useEffect,useRef,useState } from "react";
import { harnessLabels,harnessTargets,type ConnectionSnapshot } from "../../../src/shared/connections.ts";
import type { LocalAction } from "../../../src/shared/control-protocol.ts";
import { harnessDefinitions } from "../../../src/shared/harnesses.ts";
import { t } from "../../i18n";
import { sendMessage,type NativeStatus } from "./api";
import useLocalAction,{ localActionLabel } from "./useLocalAction";


export default function HarnessConnections({ status, diagnostics = false }: { status: NativeStatus; diagnostics?: boolean }) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null), [unsupported, setUnsupported] = useState(false);
  const [bridgeBusy, setBridgeBusy] = useState(false), [bridgeError, setBridgeError] = useState("");
  const operation = useRef(0), connected = status.state === "connected";
  const local = useLocalAction();
  const refresh = useCallback(async () => {
    const revision = ++operation.current;
    try {
      const response = await sendMessage<{ result?: ConnectionSnapshot }>({ type: "GET_HARNESS_CONNECTIONS" });
      if (revision !== operation.current) return;
      if (!response.result?.host || !Array.isArray(response.result.clients)) { setSnapshot(null); setUnsupported(true); return; }
      setSnapshot(response.result ?? null); setUnsupported(!response.result?.harnesses && response.result?.controllerSupported !== true);
    } catch { if (revision === operation.current) { setSnapshot(null); setUnsupported(true); } }
  }, []);
  useEffect(() => {
    if (!connected) { operation.current++; setSnapshot(null); return; }
    void refresh(); const timer = window.setInterval(() => void refresh(), 3000);
    return () => { window.clearInterval(timer); operation.current++; };
  }, [connected, refresh]);
  useEffect(() => { if (local.action && !local.working) void refresh(); }, [local.action?.state, local.working, refresh]);
  async function reconnectBridge() {
    setBridgeBusy(true); setBridgeError("");
    try { const response = await sendMessage<{ error?: string }>({ type: "RECONNECT_NATIVE_HOST" }); if (response.error) throw new Error("busy"); }
    catch { setBridgeError(t("actionBusy")); } finally { setBridgeBusy(false); }
  }
  const actions = [local.action, ...(Array.isArray(snapshot?.actions) ? snapshot.actions : [])].filter((value): value is LocalAction => !!value).sort((a, b) => b.updatedAt - a.updatedAt);
  const feedback = bridgeError || local.error || (local.action?.kind === "reconnect" ? "" : local.feedback);
  const targets = harnessTargets.filter(target => snapshot?.harnesses?.some(row => row.harness === target && row.installed) || snapshot?.clients.some(client => client.harness === target && client.state === "responding"));
  const online = targets.filter(target => snapshot?.clients.some(client => client.harness === target && client.state === "responding")).length;
  const checkingBridge = ["unknown", "connecting", "reconnecting"].includes(status.state ?? "unknown");
  return <section className="card connection-panel" aria-labelledby="harness-connections-title">
    {diagnostics && <><div className="section-heading"><h2>{t("localBridge")}</h2><span className={connected ? "online-text" : "warning-text"}>{t(connected ? "statusConnected" : "notConnected")}</span></div><dl className="bridge-details"><div><dt>{t("bridgeVersion")}</dt><dd>{snapshot?.host.version ?? status.nativeHostVersion ?? "—"}</dd></div><div><dt>{t("lastCheck")}</dt><dd>{status.lastChecked ? new Date(status.lastChecked).toLocaleTimeString() : "—"}</dd></div></dl><div className="connection-controls"><button className="button" type="button" disabled={!connected || local.working || unsupported} onClick={() => void local.start("RUN_CONNECTION_DOCTOR")}>{t("runConnectionChecks")}</button><button className="button" type="button" disabled={bridgeBusy} onClick={() => void reconnectBridge()}>{t("reconnectBridge")}</button></div><p className="help-note">{t("harnessToolsExplanation")}</p><hr /></>}
    <div className="connection-panel-heading"><h2 id="harness-connections-title">{t("harnessConnections")}</h2><span className={connected ? "online-text" : "warning-text"} role="status">{connected ? snapshot ? t("harnessConnectionCount", [String(online), String(targets.length)]) : t("checking") : t(checkingBridge ? "checking" : "notConnected")}</span></div>
    {!connected ? <div className="bridge-recovery"><h3>{t(checkingBridge ? "checkingBridge" : "bridgeNotConnected")}</h3><p>{t(checkingBridge ? "runtimeChecking" : "bridgeConnectHelp")}</p><div className="split-actions"><a className="button" href="/welcome.html" target="_blank" rel="noopener">{t("openSetupGuide")}</a><button className="button" type="button" disabled={bridgeBusy || checkingBridge} onClick={() => void reconnectBridge()}>{t(bridgeBusy ? "reconnecting" : "retry")}</button></div></div> : <ul className="agent-rows">{targets.map(target => {
      const links = snapshot?.clients.filter(client => client.harness === target) ?? [], alive = connected && links.some(client => client.state === "responding"), pending = links.some(client => client.pending > 0);
      const availability = snapshot?.harnesses?.find(row => row.harness === target), installed = availability?.installed || links.length > 0;
      const ambiguousClaude = target.startsWith("claude-") && snapshot?.clients.some(client => client.harness === "claude" && client.state === "responding");
      const job = actions.find(action => action.kind === "reconnect" && action.target === target), working = !!job && ["queued", "running"].includes(job.state);
      const unknown = connected && unsupported, checking = connected && !snapshot && !unsupported;
      const state = pending || working ? "busy" : alive ? "online" : unknown || checking || ambiguousClaude ? "unknown" : !installed && snapshot?.harnesses ? "absent" : "offline";
      const stateLabel = state === "online" ? "statusConnected" : state === "busy" ? "statusBusy" : state === "unknown" ? checking ? "checkingConnection" : ambiguousClaude ? "statusAmbiguous" : "statusUnknown" : state === "absent" ? "statusNotInstalled" : "statusDisconnected";
      const icon = ["codex", "opencode", "dsh"].includes(target) ? `/images/popup/${target}.png` : harnessDefinitions[target].icon;
      return <li className="agent-row" key={target}><div className={"agent-icon agent-" + target} aria-hidden="true"><img src={icon} alt="" width="20" height="20" /></div><div className="agent-identity"><strong>{harnessLabels[target]}</strong>{job && !working && job.state !== "succeeded" && <p className="agent-feedback" role="status">{localActionLabel(job)}</p>}</div>{alive && !pending && !working ? <span className="connection-badge badge-online">{t("statusConnected")}</span> : <button type="button" className={`button-mini agent-action badge-${state}`} disabled={!connected || unknown || checking || ambiguousClaude || !installed || pending || working} aria-label={t("connectNamed", harnessLabels[target])} onClick={() => void local.start("START_HARNESS_RECONNECT", { target })}>{working ? t("connectingAgent") : ambiguousClaude ? t(stateLabel) : pending ? t("statusBusy") : t("connectAgent")}</button>}</li>;
    })}{!snapshot && !unsupported && <li className="help-note" role="status">{t("checkingConnection")}</li>}</ul>}
    {connected && snapshot?.harnesses && !snapshot.harnesses.some(row => row.installed) && !snapshot.clients.some(client => harnessTargets.some(target => target === client.harness) && client.state === "responding") && <p className="help-note">{t("noHarnessesDetected")}</p>}
    {unsupported && connected && <p className="connection-upgrade">{t("connectionUpgrade")}</p>}
    {feedback && <p className={"action-feedback " + (bridgeError || local.error || local.action?.state === "failed" ? "is-error" : local.action?.state === "waiting" ? "is-waiting" : "")} role="status">{feedback}</p>}
  </section>;
}
