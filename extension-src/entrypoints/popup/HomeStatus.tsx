import { t } from "../../i18n";
import { type NativeStatus, type SemanticState } from "./api";
import type { DecisionSettings } from "./decision-types";
import Icon from "./Icon";
import usePopupQuery from "./usePopupQuery";

export default function HomeStatus({ status }: { status: NativeStatus }) {
  const decisionQuery = usePopupQuery<DecisionSettings>("GET_DECISION_SETTINGS", "result", status.state === "connected");
  const semanticQuery = usePopupQuery<SemanticState>("GET_SEMANTIC_SETTINGS", "semantic", status.state === "connected");
  const decision = decisionQuery.data, semantic = semanticQuery.data;
  const failed = decisionQuery.state === "error" || semanticQuery.state === "error";
  return <>
    <section className="browser-tools" aria-labelledby="browser-tools-title"><h2 id="browser-tools-title">{t("availableToAgent")}</h2><ul>{[["find-pages", "findPages"], ["fill-forms", "fillForms"], ["capture", "captureScreens"]].map(([icon, label]) => <li key={icon}><Icon name={icon!} /><span>{t(label!)}</span></li>)}</ul></section>
    <section className="home-decision"><h2>{t("decisionAssistance")}</h2><p role={failed ? "status" : undefined}>{status.state !== "connected" ? t("assistanceBridgeUnavailable") : failed ? t("assistanceStatusUnavailable") : !decision || !semantic ? t("checking") : `${t(semantic.settings?.enabled ? "localSearchOn" : "localSearchOff")} · ${t(decision.provider !== "off" && decision.shareText ? decision.ready ? "cloudOn" : "assistanceNeedsConnection" : "cloudOff")}`}</p>{failed && <button className="text-button" type="button" onClick={() => { decisionQuery.retry(); semanticQuery.retry(); }}>{t("retry")}</button>}</section>
  </>;
}
