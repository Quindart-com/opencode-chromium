import { z } from "zod";

export const telemetryToolSchema = z.enum(["browser_run", "browser_observe", "browser_session", "browser_finalize", "memory_status", "memory_query", "memory_search", "runtime"]);
const operationSchema = z.enum(["run", "observe", "session", "finalize", "status", "query", "search", "read", "inspect", "visual", "extract", "events", "downloads", "screenshot", "raw-snapshot", "capabilities", "artifact", "diagnostic", "open", "new-tab", "claim-tab", "release-tab", "name", "configure", "unclean_exit", "unknown"]);
const errorSchema = z.enum(["NONE", "OTHER", "TIMEOUT", "SETTLE_TIMEOUT", "TAB_UNHEALTHY", "STALE_OBSERVATION", "INVALID_REQUEST", "BROWSER_OPERATION_FAILED", "NO_BROWSER_PROFILE", "PROFILE_SELECTION_REQUIRED", "PROFILE_NOT_FOUND", "PROFILE_DISCONNECTED", "TARGET_NOT_FOUND", "TARGET_OBSTRUCTED", "AMBIGUOUS_TARGET", "STALE_TARGET", "ELEMENT_NOT_INTERACTABLE", "NODE_NOT_FOUND", "TAB_NOT_FOUND", "TAB_NOT_CONTROLLED", "TAB_ALREADY_OWNED", "BROWSER_HOST_UNRESPONSIVE", "BROWSER_HOST_ACCESS_DENIED", "NATIVE_HOST_DISCONNECTED", "CONNECTION_CLOSED", "VERSION_MISMATCH", "URL_POLICY_DENIED", "FILE_POLICY_DENIED", "UPLOAD_CONFIRMATION_REQUIRED", "UPLOAD_USER_DECLINED", "AUTHORIZATION_REQUIRED", "APPROVAL_REQUIRED", "APPROVAL_TOKEN_INVALID", "CAPABILITY_NOT_FOUND", "GUARDED_TAB", "NOT_SUPPORTED", "RESULT_TOO_LARGE", "RUNTIME_ADMISSION_FAILED"]);
export const telemetryStageSchema = z.enum(["profile", "action", "settle", "observe", "cleanup", "adapter"]);
export type TelemetryStage = z.output<typeof telemetryStageSchema>;
export const dispatchStateSchema = z.enum(["not_started", "acknowledged", "unknown"]);
export const approvalStateSchema = z.enum(["requested", "granted", "declined", "invalid_or_expired"]);
export type DispatchState = z.output<typeof dispatchStateSchema>;
export type ApprovalState = z.output<typeof approvalStateSchema>;
export const telemetryOutcomeSchema = z.enum(["success", "partial", "failure", "timeout", "approval_required", "authorization_required", "unclean_exit"]);
export const telemetrySampleSchema = z.strictObject({
  tool: telemetryToolSchema,
  operation: operationSchema,
  outcome: telemetryOutcomeSchema,
  error_code: errorSchema,
  duration_bucket: z.enum(["lt_100ms", "lt_500ms", "lt_2s", "lt_10s", "lt_30s", "gte_30s"]),
  adapter: z.enum(["mcp", "opencode", "sdk", "cli", "unknown"]),
  release: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/),
  recovery: z.enum(["none", "attempted", "recovered", "failed"]),
  replay: z.enum(["none", "used", "fallback"]),
  retry_count: z.number().int().min(0).max(20),
  failure_stage: telemetryStageSchema.optional(),
});
export type TelemetrySample = z.output<typeof telemetrySampleSchema>;
export const telemetryDimensionsSchema = telemetrySampleSchema.extend({
  browser_family: z.enum(["chromium", "firefox", "edge", "opera", "unknown"]),
  browser_major: z.number().int().min(0).max(9999),
  os_family: z.enum(["windows", "macos", "linux", "other"]),
});
export const telemetryBatchSchema = z.strictObject({
  schema_version: z.literal(1),
  events: z.array(z.strictObject({ dimensions: telemetryDimensionsSchema, count: z.number().int().min(1).max(1000000) })).min(1).max(25),
});
export type TelemetryDimensions = z.output<typeof telemetryDimensionsSchema>;
export function telemetryEnvironment(environment?: { browserName?: string | null; browserVersion?: string | null } | null) {
  const name = environment?.browserName ?? "";
  const browser_family: TelemetryDimensions["browser_family"] =
    /firefox|librewolf|waterfox/i.test(name) ? "firefox" : /edge/i.test(name) ? "edge" : /opera/i.test(name) ? "opera" : /chrom|brave|vivaldi/i.test(name) ? "chromium" : "unknown";
  const browser_major = Number(environment?.browserVersion?.match(/^(\d{1,4})(?:\.|$)/)?.[1] ?? 0);
  return { browser_family, browser_major };
}
export function telemetryOperation(value: unknown): TelemetrySample["operation"] { return operationSchema.safeParse(value).data ?? "unknown"; }
export function telemetryError(value: unknown): TelemetrySample["error_code"] { return errorSchema.safeParse(value).data ?? "OTHER"; }
