import { useCallback,useEffect,useRef,useState } from "react";
import { harnessLabels,type ConnectionSnapshot } from "../../../src/shared/connections.ts";
import type { LocalAction } from "../../../src/shared/local-actions.ts";
import { t } from "../../i18n";
import { sendMessage,type NativeStatus } from "./api";
import useLocalAction,{ localActionLabel } from "./useLocalAction";

const targets = ["codex", "opencode", "dsh"] as const;
const icons = { codex: "/images/harness/codex-light.png", opencode: "/images/harness/opencode.svg", dsh: "/images/harness/deepseek.svg" };
export default function HarnessConnections({ status, profileLabel }: { status: NativeStatus; profileLabel?: string | null }) {
  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null), [unsupported, setUnsupported] = useState(false);
  const [bridgeBusy, setBridgeBusy] = useState(false), [bridgeError, setBridgeError] = useState("");
  const operation = useRef(0), connected = status.state === "connected";
  const local = useLocalAction();
  const refresh = useCallback(async () => {
    const revision = ++operation.current;
    try {
      const response = await sendMessage<{ result?: ConnectionSnapshot }>({ type: "GET_HARNESS_CONNECTIONS" });
      if (revision !== operation.current) return;
      setSnapshot(response.result ?? null); setUnsupported(!response.result?.harnesses);
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
  const actions = [local.action, ...(snapshot?.actions ?? [])].filter((value): value is LocalAction => !!value).sort((a, b) => b.updatedAt - a.updatedAt);
  return <section className="card connection-panel" aria-labelledby="harness-connections-title">
    <div className="connection-panel-heading"><div><h2 id="harness-connections-title">{t("harnessConnections")}</h2><p className="connection-profile">{profileLabel || t("thisProfile")}</p></div><button type="button" className="icon-button" aria-label={t("refreshConnections")} title={t("refreshConnections")} onClick={() => void refresh()}>↻</button></div>
    <div className="bridge-strip"><span className={"status-dot " + (connected ? "is-online" : "is-offline")} /><span>{t(connected ? "bridgeReady" : "bridgeUnavailable")}</span><span className="bridge-version">{snapshot?.host.version ? "v" + snapshot.host.version : status.nativeHostVersion ? "v" + status.nativeHostVersion : ""}</span><button type="button" className="icon-button" disabled={bridgeBusy} aria-label={t("reconnectBridge")} title={t("reconnectBridge")} onClick={() => void reconnectBridge()}>↻</button></div>
    <ul className="agent-rows">{targets.map(target => {
      const links = snapshot?.clients.filter(client => client.harness === target) ?? [], alive = connected && links.some(client => client.state === "responding"), pending = links.some(client => client.pending > 0);
      const availability = snapshot?.harnesses?.find(row => row.harness === target), installed = availability?.installed || links.length > 0;
      const job = actions.find(action => action.kind === "reconnect" && action.target === target), working = !!job && ["queued", "running"].includes(job.state);
      const unknown = connected && unsupported, checking = connected && !snapshot && !unsupported;
      const state = pending || working ? "busy" : alive ? "online" : unknown || checking ? "unknown" : !installed && snapshot?.harnesses ? "absent" : "offline";
      const stateLabel = state === "online" ? "statusConnected" : state === "busy" ? "statusBusy" : state === "unknown" ? checking ? "checkingConnection" : "statusUnknown" : state === "absent" ? "statusNotInstalled" : "statusDisconnected";
      const version = availability?.version ?? links.find(link => link.harnessVersion)?.harnessVersion;
      return <li className="agent-row" key={target}><div className={"agent-icon agent-" + target} aria-hidden="true"><img src={icons[target]} alt="" /></div><div className="agent-identity"><strong>{harnessLabels[target]}</strong><div><span className={"connection-badge badge-" + state}><i />{t(stateLabel)}</span>{version && <small>v{version}</small>}</div>{job && !working && job.state !== "succeeded" && <p className="agent-feedback" role="status">{localActionLabel(job)}</p>}</div><button type="button" className={"button-mini agent-action" + (!alive ? " action-primary" : "")} disabled={!connected || unknown || checking || !installed || pending || working} aria-label={t(alive ? "reconnectNamed" : "connectNamed", harnessLabels[target])} onClick={() => void local.start("START_HARNESS_RECONNECT", { target })}>{working ? t("actionRunning") : t(alive ? "reconnectAgent" : "connectAgent")}</button></li>;
    })}</ul>
    {unsupported && connected && <div className="connection-upgrade"><span>{t("connectionUpgrade")}</span><button type="button" className="button-mini action-primary" disabled={local.working} onClick={() => void local.start("INSTALL_RUNTIME_UPDATE")}>{t("updateCli")}</button></div>}
    <div className="connection-panel-footer"><span>{t("agentsKeepRunning")}</span><button type="button" className="text-button" disabled={!connected || local.working || unsupported} onClick={() => void local.start("RUN_CONNECTION_DOCTOR")}>{t("runConnectionChecks")}</button></div>
    {(local.feedback || bridgeError) && <p className={"action-feedback " + (local.error || local.action?.state === "failed" ? "is-error" : local.action?.state === "waiting" ? "is-waiting" : "")} role="status">{bridgeError || local.feedback}</p>}
  </section>;
}
