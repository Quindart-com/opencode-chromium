import { t } from "../../i18n";
import { useEffect, useState } from "react";
import { sendMessage } from "./api";
import type { DecisionSettings } from "./decision-types";

export default function DecisionOverview({ onConfigure }: { onConfigure: () => void }) {
  const [status, setStatus] = useState<DecisionSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await sendMessage<{ result?: DecisionSettings }>({ type: "GET_DECISION_SETTINGS" });
        if (!response.result) throw new Error("unavailable");
        if (active) { setStatus(response.result); setError(""); }
      } catch { if (active) setError(t("usageUnavailable")); }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const usage = status?.usage;
  const efficiency = status?.efficiency;
  const number = (value?: number) => value === undefined ? "—" : value.toLocaleString();
  const avoided = efficiency ? efficiency.skipped + efficiency.cacheHits + efficiency.coalesced + efficiency.budgetSkipped : undefined;
  const providerSelected = status && status.provider !== "off";
  const model = status?.provider === "openai-decisions" ? "OpenAI Luna" : "Jev";
  return <section className="decision-overview" aria-labelledby="jev-usage-heading">
    <div className="decision-overview-heading"><h2 id="jev-usage-heading">{t("decisionAssistance")}</h2><button type="button" className="button-mini" onClick={onConfigure}>{t("configure")}</button></div>
    <p className="decision-model">{!status ? error ? t("notConnected") : t("loading") : providerSelected ? model : t("localSearch")}</p>
    <p className="help-note">{error || (!status ? t("checkingConfiguration") : status.ready ? t("connectedThrough", status.route === "openrouter" ? "OpenRouter" : status.route === "openai" ? "OpenAI Platform" : "TypeSafe") : providerSelected && status.shareText ? t("assistanceNeedsConnection") : t("assistanceOff"))}</p>
    <details className="usage-details"><summary>{t("usagePerformance")}</summary>
    <dl className="decision-usage">
      <div><dt>{t("calls")}</dt><dd>{number(usage?.calls)}</dd></div>
      <div><dt>{t("selectedAbstained")}</dt><dd>{usage ? `${number(usage.selected)} / ${number(usage.abstained)}` : "—"}</dd></div>
      <div><dt>{t("tokens")}</dt><dd>{usage ? `${number(usage.inputTokens)} / ${number(usage.outputTokens)}` : "—"}</dd></div>
      <div><dt>{t("reportedCost")}</dt><dd>{usage?.costReportedCalls ? `$${usage.reportedCost.toFixed(6)}` : t("notReported")}</dd></div>
      <div><dt>{t("responseTime")}</dt><dd>{usage?.calls ? `${Math.round(usage.averageMs)} / ${Math.round(usage.lastMs)} ms` : "—"}</dd></div>
      <div><dt>{t("callsAvoided")}</dt><dd>{number(avoided)}</dd></div>
    </dl>
    <p className="provider-test-help">{usage ? t("usageReport", [String(usage.tests), String(usage.usageReportedCalls), String(usage.calls), String(usage.costReportedCalls), String(usage.window)]) : t("usageDetails")}</p>
    {efficiency ? <p className="provider-test-help">{t("efficiencyReport", [number(efficiency.skipped), number(efficiency.cacheHits), number(efficiency.coalesced), number(efficiency.budgetSkipped)])}</p> : null}
    </details>
  </section>;
}
