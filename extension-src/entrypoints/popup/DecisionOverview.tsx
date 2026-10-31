import { useEffect,useState } from "react";
import { decisionFamilyLabel,decisionServiceLabel } from "../../../src/shared/decision-catalog.ts";
import type { UsagePeriod,UsageProvider } from "../../../src/shared/decision-usage.ts";
import { t } from "../../i18n";
import { sendMessage } from "./api";
import type { DecisionSettings } from "./decision-types";
import UsageTrend from "./UsageTrend";

const service = (route: string) => decisionServiceLabel(route) ?? t("usageUnattributed");
const model = decisionFamilyLabel;
const label = (row: Pick<UsageProvider, "route" | "provider">) => service(row.route) + (model(row.provider) ? " · " + model(row.provider) : "");
export default function DecisionOverview({ onConfigure }: { onConfigure: () => void }) {
  const [status, setStatus] = useState<DecisionSettings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState("current"), [period, setPeriod] = useState<UsagePeriod>("7d");
  useEffect(() => {
    let active = true, sequence = 0;
    async function refresh() {
      const revision = ++sequence;
      try {
        const response = await sendMessage<{ result?: DecisionSettings }>({ type: "GET_DECISION_SETTINGS", usage: { provider: provider === "current" ? undefined : provider, period } });
        if (!response.result) throw new Error("unavailable");
        if (active && revision === sequence) { setStatus(response.result); setError(""); setLoading(false); }
      } catch { if (active && revision === sequence) { setError(t("usageUnavailable")); setLoading(false); } }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [provider, period]);
  const usage = loading || error ? undefined : status?.usage, efficiency = status?.efficiency;
  const number = (value?: number) => value === undefined ? "—" : value.toLocaleString();
  return <section className="decision-overview" aria-labelledby="decision-usage-heading">
    <div className="decision-overview-heading"><h2 id="decision-usage-heading">{t("decisionAssistance")}</h2><button type="button" className="button-mini" onClick={onConfigure}>{t("configure")}</button></div>
    <div className="decision-provider-line"><span className={"status-dot " + (status?.ready ? "is-online" : "is-offline")} /><strong>{status && status.provider !== "off" ? status.textModel ? service(status.route) + " · " + status.textModel : label(status) : t("localSearch")}</strong><span className="help-note">{!status ? t("loading") : status.ready ? t("statusConnected") : status.provider !== "off" && status.shareText ? t("assistanceNeedsConnection") : t("assistanceOff")}</span></div>
    <div className="usage-filters">
      <label>{t("usageProvider")}<select aria-label={t("usageProvider")} value={provider} onChange={event => { setLoading(true); setProvider(event.target.value); }}>
        <option value="current">{t("usageCurrentProvider")}{status ? " · " + label(status) : ""}</option>
        <option value="all">{t("usageAllProviders")}</option>
        {(status?.usage?.providers ?? []).map(row => <option key={row.id} value={row.id}>{label(row)}</option>)}
      </select></label>
      <label>{t("usagePeriod")}<select aria-label={t("usagePeriod")} value={period} onChange={event => { setLoading(true); setPeriod(event.target.value as UsagePeriod); }}>
        <option value="7d">{t("usageLast7")}</option><option value="30d">{t("usageLast30")}</option><option value="last-week">{t("usageLastWeek")}</option><option value="last-year">{t("usageLastYear")}</option><option value="all">{t("usageAllTime")}</option>
      </select></label>
    </div>
    {error && <p role="alert" className="action-error">{error}</p>}
    <dl className="usage-metrics">
      <div><dt>{t("usageInput")}</dt><dd>{number(usage?.inputTokens)}</dd></div><div><dt>{t("usageOutput")}</dt><dd>{number(usage?.outputTokens)}</dd></div>
      <div><dt>{t("calls")}</dt><dd>{number(usage?.calls)}</dd></div><div><dt>{t("reportedCost")}</dt><dd className={usage?.costReportedCalls ? "" : "metric-unreported"}>{usage?.costReportedCalls ? "$" + usage.reportedCost.toFixed(6) : t("notReported")}</dd></div>
    </dl>
    {usage?.daily && <UsageTrend days={usage.daily} />}
    {usage?.providers && <div className="usage-comparison"><h3>{t("usageServices")}</h3><table><thead><tr><th>{t("usageProvider")}</th><th>{t("calls")}</th><th>{t("usageInput")}</th><th>{t("usageOutput")}</th></tr></thead><tbody>
      {usage.providers.map(row => <tr key={row.id} className={usage.selectedProvider === row.id ? "is-selected" : ""}><th scope="row"><button type="button" onClick={() => { setLoading(true); setProvider(row.id); }}>{service(row.route)}{model(row.provider) && <small>{model(row.provider)}</small>}</button></th><td>{number(row.calls)}</td><td>{number(row.inputTokens)}</td><td>{number(row.outputTokens)}</td></tr>)}
    </tbody></table></div>}
    <p className="usage-footnote">{usage ? t("usageLocalHistory", [String(usage.tests), String(usage.usageReportedCalls), String(usage.calls)]) : t("loading")}{usage?.calls ? " · " + Math.round(usage.averageMs) + " ms" : ""}</p>
    {usage && usage.costReportedCalls < usage.calls && <p className="usage-footnote">{t("usageAccountingIncomplete")}</p>}
    {efficiency && <details className="advanced-details"><summary>{t("usageSavingsGlobal")}</summary><p className="help-note">{t("efficiencyReport", [number(efficiency.skipped), number(efficiency.cacheHits), number(efficiency.coalesced), number(efficiency.budgetSkipped)])}</p></details>}
  </section>;
}
