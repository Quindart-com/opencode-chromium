import { traceEventsFromChunks, traceEventsFromJson } from "./trace-capture.js";
import { analyzePerformanceTrace, performanceInsightById } from "./performance-insights.js";

export function handleDiagnosticsHostMethod(method, params = {}) {
  if (method === "diagnostics.traceAnalyze") {
    let events;
    if (typeof params.trace === "string") events = traceEventsFromJson(params.trace);
    else if (Array.isArray(params.trace)) events = params.trace;
    else if (Array.isArray(params.chunks)) events = traceEventsFromChunks(params.chunks);
    else return { ok: false, error: "diagnostics.traceAnalyze requires trace JSON or chunks" };
    const result = analyzePerformanceTrace(events, params.url ?? null);
    return performanceInsightById(result, params.insight ?? null);
  }
  return undefined;
}

export { analyzePerformanceTrace, performanceInsightById } from "./performance-insights.js";
export { parseTrace } from "./trace-parser.js";
export { traceChunksToJson, traceEventsFromChunks, traceEventsFromJson } from "./trace-capture.js";