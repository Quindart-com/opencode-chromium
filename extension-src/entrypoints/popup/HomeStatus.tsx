import { useState } from "react";
import { t } from "../../i18n";
import { type NativeStatus, type SemanticState } from "./api";
import type { DecisionSettings } from "./decision-types";
import Icon from "./Icon";
import type { SettingsSection } from "./SettingsView";
import usePopupQuery from "./usePopupQuery";

const capabilities = [
  { icon: "find-pages", label: "findPages", help: "findPagesCapabilityHelp" },
  { icon: "fill-forms", label: "fillForms", help: "fillFormsCapabilityHelp" },
  { icon: "capture", label: "captureScreens", help: "captureCapabilityHelp" },
] as const;

export default function HomeStatus({ status, onSettings }: { status: NativeStatus; onSettings: (section: SettingsSection) => void }) {
  const [expanded, setExpanded] = useState<typeof capabilities[number] | null>(null);
  const decisionQuery = usePopupQuery<DecisionSettings>("GET_DECISION_SETTINGS", "result", status.state === "connected");
  const semanticQuery = usePopupQuery<SemanticState>("GET_SEMANTIC_SETTINGS", "semantic", status.state === "connected");
  const decision = decisionQuery.data, semantic = semanticQuery.data;
  const failed = decisionQuery.state === "error" || semanticQuery.state === "error";
  const usable = status.state === "connected" && status.browserCompatible !== false;
  const checking = !status.state || ["unknown", "connecting", "reconnecting"].includes(status.state);
  const shared = decision?.ready && decision.provider !== "off" && decision.shareText && decision.shareImages;
  const capabilityLabel = !usable ? checking ? "checking" : "memoryUnavailableShort" : "capabilityAvailable";
  const captureLabel = !usable ? capabilityLabel : decisionQuery.state === "error" ? "statusUnknown" :
    !decision ? "checking" : shared ? "captureSharingOn" : "captureSharingOff";
  return <>
    <section className="browser-tools" aria-labelledby="browser-tools-title">
      <h2 id="browser-tools-title">{t("availableToAgent")}</h2>
      <ul>{capabilities.map(capability => <li key={capability.icon}>
        <button className="capability-button" type="button" aria-expanded={expanded === capability} aria-controls="browser-capability-detail"
          onClick={() => setExpanded(previous => previous === capability ? null : capability)}>
          <Icon name={capability.icon} /><span>{t(capability.label)}<small>{t(capability.icon === "capture" ? captureLabel : capabilityLabel)}</small></span>
        </button>
      </li>)}</ul>
      <div id="browser-capability-detail" className="capability-detail" hidden={!expanded}>
        {expanded && <><p>{t(usable ? expanded.help : checking ? "checkingBridge" : "bridgeRequired")}</p>
          {(expanded.icon === "capture" || !usable) && <button className="text-button" type="button" onClick={() => onSettings(usable ? "decision" : "connection")}>{t(usable ? "decisionAssistance" : "connectionHelp")}</button>}
        </>}
      </div>
    </section>
    <section className="home-decision"><h2>{t("decisionAssistance")}</h2><p role={failed ? "status" : undefined}>{status.state !== "connected" ? t("assistanceBridgeUnavailable") : failed ? t("assistanceStatusUnavailable") : !decision || !semantic ? t("checking") : `${t(semantic.settings?.enabled ? "localSearchOn" : "localSearchOff")} · ${t(decision.provider !== "off" && decision.shareText ? decision.ready ? "cloudOn" : "assistanceNeedsConnection" : "cloudOff")}`}</p>{failed && <button className="text-button" type="button" onClick={() => { decisionQuery.retry(); semanticQuery.retry(); }}>{t("retry")}</button>}</section>
  </>;
}
