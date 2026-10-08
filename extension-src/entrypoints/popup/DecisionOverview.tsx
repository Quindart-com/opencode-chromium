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
      } catch { if (active) setError("Usage unavailable. Connect the native host."); }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const usage = status?.usage;
  const efficiency = status?.efficiency;
  const number = (value?: number) => value === undefined ? "—" : value.toLocaleString();
  const avoided = efficiency ? efficiency.skipped + efficiency.cacheHits + efficiency.coalesced + efficiency.budgetSkipped : undefined;
  return <section className="decision-overview" aria-labelledby="jev-usage-heading">
    <div className="decision-overview-heading"><h2 id="jev-usage-heading">Decision assistance</h2><button type="button" className="button-mini" onClick={onConfigure}>Configure</button></div>
    <p className="decision-model">{!status ? error ? "Not connected" : "Loading…" : status.ready ? status.provider === "openai-decisions" ? "OpenAI Luna" : "Jev" : "Local search"}</p>
    <p className="help-note">{error || (!status ? "Checking your configuration…" : status.ready ? `Connected through ${status.route === "openrouter" ? "OpenRouter" : "TypeSafe"}` : "Cloud assistance is off. Search and replay remain available.")}</p>
    <details className="usage-details"><summary>Usage and performance</summary>
    <dl className="decision-usage">
      <div><dt>Call attempts</dt><dd>{number(usage?.calls)}</dd></div>
      <div><dt>Selected / abstained</dt><dd>{usage ? `${number(usage.selected)} / ${number(usage.abstained)}` : "—"}</dd></div>
      <div><dt>Input / output tokens</dt><dd>{usage ? `${number(usage.inputTokens)} / ${number(usage.outputTokens)}` : "—"}</dd></div>
      <div><dt>Provider-reported cost</dt><dd>{usage?.costReportedCalls ? `$${usage.reportedCost.toFixed(6)}` : "Not reported"}</dd></div>
      <div><dt>Average / last response</dt><dd>{usage?.calls ? `${Math.round(usage.averageMs)} / ${Math.round(usage.lastMs)} ms` : "—"}</dd></div>
      <div><dt>Calls avoided</dt><dd>{number(avoided)}</dd></div>
    </dl>
    <p className="provider-test-help">{usage ? `Includes ${usage.tests} connection tests. Usage reported for ${usage.usageReportedCalls}/${usage.calls} calls; cost for ${usage.costReportedCalls}/${usage.calls}. ${usage.window}.` : "Only provider-reported tokens and cost are counted. Harness usage is separate."}</p>
    {efficiency ? <p className="provider-test-help">{`Avoided since the host started: ${number(efficiency.skipped)} unambiguous rankings, ${number(efficiency.cacheHits)} repeated searches, ${number(efficiency.coalesced)} duplicate requests in flight${efficiency.budgetSkipped ? `, ${number(efficiency.budgetSkipped)} over the burst limit` : ""}. Paid decisions only resolve ambiguous rankings.`}</p> : null}
    </details>
  </section>;
}
