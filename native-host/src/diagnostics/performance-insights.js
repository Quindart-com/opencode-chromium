import { parseTrace } from "./trace-parser.js";

function round(value, digits = 0) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function severity(ok) {
  return ok ? "ok" : "warning";
}

// Turns parsed trace metrics into a compact summary plus around eight
// actionable insights. Thresholds are pragmatic lab values; the trace is
// never sent anywhere and field data (CrUX) is deliberately not consulted.
export function insightsFromMetrics(metrics) {
  const summary = {
    FCP: round(metrics.FCP),
    LCP: round(metrics.LCP),
    CLS: round(metrics.CLS ?? 0, 4),
    TBT: round(metrics.TBT),
    longTaskCount: metrics.longTaskCount ?? 0,
    worstLongTaskMs: round(metrics.worstLongTaskMs),
    navigationStartMs: round(metrics.navigationStart),
    documentDurationMs: round(metrics.documentDurationMs),
    mainThreadMs: round(metrics.mainThreadMs),
    jsMs: round(metrics.jsMs),
    resources: metrics.resources ?? 0,
    transferBytes: metrics.transferBytes ?? 0,
    imageCount: metrics.imageCount ?? 0,
    imageLoadMs: round(metrics.imageLoadMs),
    renderBlockingCount: metrics.renderBlockingCount ?? 0,
    layoutShiftCount: metrics.layoutShiftCount ?? 0,
  };

  const insights = [];
  const push = (id, title, ok, detail) => insights.push({ id, title, severity: severity(ok), detail });

  push("lcp", "LCP breakdown", (metrics.LCP ?? 0) <= 2500, `Largest Contentful Paint at ${round(metrics.LCP)}ms; target is under 2500ms.`);
  push("render-blocking-resources", "Render-blocking resources", (metrics.renderBlockingCount ?? 0) === 0, `${metrics.renderBlockingCount ?? 0} script or stylesheet resources were requested before First Contentful Paint.`);
  push("long-tasks", "Long tasks", (metrics.TBT ?? 0) <= 200, `${metrics.longTaskCount ?? 0} long tasks (worst ${round(metrics.worstLongTaskMs)}ms) contributing ${round(metrics.TBT)}ms of blocking time.`);
  push("layout-shifts", "Layout shifts", (metrics.CLS ?? 0) <= 0.1, `Layout shift score of ${round(metrics.CLS, 4)} across ${metrics.layoutShiftCount ?? 0} shifts; target is under 0.1.`);
  push("large-javascript", "Large JavaScript execution", (metrics.jsMs ?? 0) <= 500, `${round(metrics.jsMs)}ms of EvaluateScript execution time on the main thread.`);
  push("slow-document-request", "Slow document request", (metrics.documentDurationMs ?? 0) <= 2000, `Main document request completed in ${round(metrics.documentDurationMs)}ms.`);
  push("image-loading", "Image loading", (metrics.imageCount ?? 0) < 20, `${metrics.imageCount ?? 0} images loaded at ${round(metrics.imageLoadMs)}ms total.`);
  const topThirdParty = Object.entries(metrics.thirdParty ?? {})[0];
  push("third-party-cost", "Third-party cost", !topThirdParty || topThirdParty[1].transferBytes <= 500 * 1024, topThirdParty
    ? `Top third-party origin ${topThirdParty[0]} transferred ${round(topThirdParty[1].transferBytes / 1024)}KB across ${topThirdParty[1].requests} requests.`
    : "No third-party origins detected.");

  return { summary, insights };
}

export function analyzePerformanceTrace(events, url = null) {
  const metrics = parseTrace(events);
  if (url) metrics.documentUrl = url;
  const { summary, insights } = insightsFromMetrics(metrics);
  return {
    ok: true,
    mode: "performance",
    traceEventCount: metrics.eventCount,
    summary,
    insights,
  };
}

export function performanceInsightById(result, insightId) {
  if (!insightId) return result;
  return {
    ...result,
    insights: (result.insights ?? []).filter((insight) => insight.id === insightId),
  };
}