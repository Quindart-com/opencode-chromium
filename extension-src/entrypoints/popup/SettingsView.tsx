import { t } from "../../i18n";
import { type NativeStatus, type SemanticState } from "./api";
import ConnectionView from "./ConnectionView";
import HarnessConnections from "./HarnessConnections";
import Icon from "./Icon";
import MemoryView from "./MemoryView";
import ProviderSettings from "./ProviderSettings";
import RuntimeUpdates from "./RuntimeUpdates";
import UploadSettings from "./UploadSettings";
import type { DecisionSettings } from "./decision-types";
import usePopupQuery from "./usePopupQuery";

export type SettingsSection = "decision" | "models" | "storage" | "updates" | "connection";
export default function SettingsView({ status, section, onSection }: { status: NativeStatus; section: SettingsSection | null; onSection: (section: SettingsSection | null) => void }) {
  const enabled = !section && status.state === "connected";
  const decisionQuery = usePopupQuery<DecisionSettings>("GET_DECISION_SETTINGS", "result", enabled);
  const semanticQuery = usePopupQuery<SemanticState>("GET_SEMANTIC_SETTINGS", "semantic", enabled);
  const updatesQuery = usePopupQuery<{ enabled: boolean }>("GET_RUNTIME_UPDATES", "result", enabled);
  const decision = decisionQuery.data, semantic = semanticQuery.data, updates = updatesQuery.data?.enabled;
  const failed = [decisionQuery, semanticQuery, updatesQuery].some(query => query.state === "error");
  const fallback = (state: string) => t(status.state !== "connected" || state === "error" ? "memoryUnavailableShort" : "loadingSettings");
  const row = (key: SettingsSection, title: string, detail: string) => <button type="button" className="setting-row" onClick={() => onSection(key)}><span><strong>{title}</strong><small>{detail}</small></span><Icon name="chevron-right" /></button>;
  const titles = { decision: t("decisionAssistance"), models: t("localSearchModels"), storage: t("storageCleanup"), updates: t("updates"), connection: t("connectionHelp") };
  if (section) return <div className={`settings-detail settings-${section}`}>
    <button className="section-collapse" type="button" onClick={() => onSection(null)}><h2>{titles[section]}</h2><Icon name="chevron-up" /></button>
    {section === "decision" && <ProviderSettings />}
    {section === "models" && <ConnectionView status={status} view="settings" />}
    {section === "storage" && <MemoryView view="settings" />}
    {section === "updates" && <RuntimeUpdates />}
    {section === "connection" && <HarnessConnections status={status} diagnostics />}
  </div>;
  const activeModel = semantic?.models?.find(model => model.id === semantic.settings?.modelId);
  return <div className="settings-list">
    {row("decision", titles.decision, decision ? decision.provider === "off" ? t("localSearchOnly") : t(decision.ready ? "statusConnected" : "assistanceNeedsConnection") : fallback(decisionQuery.state))}
    {row("models", titles.models, semantic ? `${t(semantic.settings?.enabled ? "onLabel" : "offLabel")}${activeModel ? ` · ${activeModel.label}` : ""}` : fallback(semanticQuery.state))}
    <UploadSettings compact />
    <MemoryView view="toggle" />
    <MemoryView view="storage-summary" onView={() => onSection("storage")} />
    {row("updates", titles.updates, updates === undefined ? fallback(updatesQuery.state) : t(updates ? "automaticUpdatesOn" : "updatesOff"))}
    {row("connection", titles.connection, t("connectionHelpDetail"))}
    {failed && <div className="split-actions"><p role="status" className="help-note">{t("settingsStatusUnavailable")}</p><button className="button" type="button" onClick={() => { decisionQuery.retry(); semanticQuery.retry(); updatesQuery.retry(); }}>{t("retry")}</button></div>}
  </div>;
}
