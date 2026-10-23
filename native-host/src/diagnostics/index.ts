import { record } from "../../../src/shared/values.ts";
import { analyzePerformanceTrace,performanceInsightById } from "./performance-insights.ts";
import { traceEventsFromChunks,traceEventsFromJson } from "./trace-capture.ts";

export function handleDiagnosticsHostMethod(method: string, input: unknown = {}) {
  const params = record(input);
  if (method === "diagnostics.traceAnalyze") {
    let events;
    if (typeof params.trace === "string") events = traceEventsFromJson(params.trace);
    else if (Array.isArray(params.trace)) events = params.trace;
    else if (Array.isArray(params.chunks)) events = traceEventsFromChunks(params.chunks);
    else return { ok: false, error: "diagnostics.traceAnalyze requires trace JSON or chunks" };
    const result = analyzePerformanceTrace(events, typeof params.url === "string" ? params.url : null);
    return performanceInsightById(result, typeof params.insight === "string" ? params.insight : null);
  }
  return undefined;
}

export { analyzePerformanceTrace,performanceInsightById } from "./performance-insights.ts";
export { traceChunksToJson,traceEventsFromChunks,traceEventsFromJson } from "./trace-capture.ts";
export { parseTrace } from "./trace-parser.ts";
