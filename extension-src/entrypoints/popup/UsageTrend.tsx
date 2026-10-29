import type { UsageDay } from "../../../src/shared/decision-usage.ts";
import { t } from "../../i18n";

export default function UsageTrend({ days }: { days: UsageDay[] }) {
  const span = Math.max(1, Math.ceil(days.length / 30));
  const bars = [];
  for (let index = 0; index < days.length; index += span) {
    const group = days.slice(index, index + span), first = group[0]!, last = group.at(-1)!;
    bars.push({ date: first.date, end: last.endDate ?? last.date, input: group.reduce((n, day) => n + day.inputTokens, 0), output: group.reduce((n, day) => n + day.outputTokens, 0) });
  }
  const peak = Math.max(1, ...bars.map(bar => bar.input + bar.output)), width = 300, height = 78, step = width / Math.max(1, bars.length);
  return <figure className="usage-trend">
    <figcaption><strong>{t("usageTrend")}</strong><span className="usage-legend"><i className="legend-input" />{t("usageInput")}<i className="legend-output" />{t("usageOutput")}</span></figcaption>
    {bars.some(bar => bar.input || bar.output) ? <>
      <svg viewBox="0 0 300 82" role="img" aria-label={t("usageTrend")}>
        <line x1="0" x2="300" y1="79" y2="79" className="usage-grid" />
        {bars.map((bar, index) => {
          const input = bar.input / peak * height, output = bar.output / peak * height;
          const label = bar.date + (bar.end !== bar.date ? " – " + bar.end : "") + ": " + t("usageInput") + " " + bar.input.toLocaleString() + ", " + t("usageOutput") + " " + bar.output.toLocaleString();
          return <g key={bar.date} tabIndex={0} aria-label={label}><title>{label}</title>
            <rect className="usage-bar-input" x={index * step + 1} y={79 - input} width={Math.max(1, step - 3)} height={input} rx="2" />
            <rect className="usage-bar-output" x={index * step + 1} y={79 - input - output} width={Math.max(1, step - 3)} height={output} rx="2" />
          </g>;
        })}
      </svg>
      <div className="usage-axis"><span>{bars[0]?.date}</span><span>UTC</span><span>{bars.at(-1)?.end}</span></div>
    </> : <p className="usage-empty">{t("usageNoData")}</p>}
  </figure>;
}
