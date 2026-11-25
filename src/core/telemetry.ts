import { AsyncLocalStorage } from "node:async_hooks";
import { record } from "../shared/values.ts";
import { telemetryError,telemetryOperation,type ApprovalState,type DispatchState,type TelemetrySample,type TelemetryStage } from "../shared/telemetry-schema.ts";
import { PLUGIN_VERSION } from "./versions.ts";

export interface CallMeasurement {
  at: number;
  elapsedMs: number;
  stagesMs: Partial<Record<TelemetryStage, number>>;
  dispatch?: DispatchState;
  approval?: ApprovalState;
}
interface MeasurementScope extends CallMeasurement { retries: number; failedAt?: TelemetryStage; failureCode?: TelemetrySample["error_code"] }
const attempts = new AsyncLocalStorage<MeasurementScope>();
export function noteTelemetryRetry() { const scope = attempts.getStore(); if (scope) scope.retries = Math.min(20, scope.retries + 1); }
export function noteTelemetryDispatch(state: NonNullable<CallMeasurement["dispatch"]>) {
  const scope = attempts.getStore();
  if (scope && state !== "not_started" && scope.dispatch !== "unknown") scope.dispatch = state;
}
export function noteTelemetryApproval(state: NonNullable<CallMeasurement["approval"]>) {
  const scope = attempts.getStore();
  if (scope) scope.approval = state;
}
export async function measureTelemetryStage<T>(stage: TelemetryStage, execute: () => Promise<T>) {
  const scope = attempts.getStore();
  if (!scope) return execute();
  const start = performance.now();
  try { return await execute(); }
  catch (error) { scope.failedAt = stage; scope.failureCode = telemetryError(record(error).code); throw error; }
  finally { scope.stagesMs[stage] = (scope.stagesMs[stage] ?? 0) + performance.now() - start; }
}
export interface TelemetryReporter {
  telemetryProfile?(input: unknown, context: unknown): string | null;
  telemetry?(sample: TelemetrySample, result: unknown, input: unknown, context: unknown, profileId?: string | null, measurement?: CallMeasurement): void;
}
function sample(tool: TelemetrySample["tool"], input: unknown, context: unknown, result: unknown, measurement: MeasurementScope): TelemetrySample {
  const value = record(result), error = record(value.error);
  const failures = Array.isArray(value.results) ? value.results.filter(item => record(item).ok === false) : [];
  const detail = Object.keys(error).length ? error : record(record(failures[0]).error);
  const observationError = record(record(value.observation).error);
  const status = value.status;
  const rawCode = detail.code ?? observationError.code ?? (value.ok === false ? measurement.failureCode : undefined);
  const code = telemetryError(rawCode ?? (status === "approval_required" ? "APPROVAL_REQUIRED" : status === "authorization_required" ? "AUTHORIZATION_REQUIRED" : value.ok === false ? "OTHER" : "NONE"));
  const outcome = status === "approval_required" || code === "APPROVAL_TOKEN_INVALID" ? "approval_required" : status === "authorization_required" || status === "approval_declined" || code === "UPLOAD_USER_DECLINED" ? "authorization_required" :
    code === "TIMEOUT" || code === "SETTLE_TIMEOUT" ? "timeout" : value.ok === false ? status === "partial" ? "partial" : "failure" : "success";
  const failed = outcome === "partial" || outcome === "failure" || outcome === "timeout";
  const stage = code === "SETTLE_TIMEOUT" ? "settle" :
    !Object.keys(detail).length && observationError.code ? "observe" : measurement.failedAt;
  const agent = record(context).agent;
  const adapter = agent === "mcp" ? "mcp" : agent === "opencode" || agent === "opencode-v2" ? "opencode" : agent === "cli" ? "cli" : agent === undefined || agent === "sdk" ? "sdk" : "unknown";
  const recovery = record(detail.recovery ?? record(value.recovery));
  const memory = record(value.memory);
  const elapsed = measurement.elapsedMs;
  if (status === "approval_declined" || code === "UPLOAD_USER_DECLINED") measurement.approval = "declined";
  return {
    tool, operation: telemetryOperation(record(input).mode ?? record(input).action ?? tool.replace(/^(browser_|memory_)/, "")),
    outcome, error_code: code, adapter, release: /^\d+\.\d+\.\d+$/.test(PLUGIN_VERSION) ? PLUGIN_VERSION : "0.0.0",
    duration_bucket: elapsed < 100 ? "lt_100ms" : elapsed < 500 ? "lt_500ms" : elapsed < 2000 ? "lt_2s" : elapsed < 10000 ? "lt_10s" : elapsed < 30000 ? "lt_30s" : "gte_30s",
    recovery: recovery.ok === true ? "recovered" : recovery.ok === false ? "failed" : Object.keys(recovery).length ? "attempted" : "none",
    replay: memory.used === true ? "used" : memory.fallback === true ? "fallback" : "none",
    retry_count: measurement.retries,
    ...(failed && stage ? { failure_stage: stage } : {}),
  };
}

/** Pass only a bounded summary to the host; diagnostics must never affect tool behavior. */
export async function measureTool<T>(runtime: TelemetryReporter, tool: TelemetrySample["tool"], input: unknown, context: unknown, execute: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  const scope: MeasurementScope = { at: Date.now(), elapsedMs: 0, retries: 0, stagesMs: {}, ...(tool === "browser_run" ? { dispatch: "not_started" } : {}) };
  let profileId: string | null | undefined;
  try { profileId = runtime.telemetryProfile?.(input, context); } catch { /* Never affect execution. */ }
  let result: unknown;
  try { result = await attempts.run(scope, execute); return result as T; }
  catch (error) { result = { ok: false, error: { code: record(error).code } }; throw error; }
  finally {
    scope.elapsedMs = performance.now() - started;
    try { runtime.telemetry?.(sample(tool, input, context, result, scope), result, input, context, profileId, scope); } catch { /* Best effort only. */ }
  }
}
