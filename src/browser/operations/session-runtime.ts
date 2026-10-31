import type { Target } from "../../core/registry.ts";
import type { BrowserContext } from "../../core/tool-definition.ts";
import type { CdpMethod,CdpParams,CdpResult } from "../../shared/cdp.ts";
import type { CursorAction } from "../../shared/cursor-actions.ts";
import { pageException } from "../../shared/page-error.ts";
import { SourceMapResolver,mapCallFrames } from "../../shared/source-maps.ts";
import { isRecord,record } from "../../shared/values.ts";
import { browserRequest,resolveBrowserProfile } from "../client.ts";
import { cursorPoint } from "../cursor.ts";
import { extensionResultSchemas,type BrowserEvent,type BrowserEvents,type ExtensionMethod,type ExtensionResult } from "../events.ts";
import { interactionHelpersSource } from './interaction-helpers.ts';
export { keyDispatchEvents,parseKeyPress } from "../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from './inspection-expressions.ts';
export { pageSearchUnitsExpression } from './snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

export function createOperationSessionRuntime() {
function domNodeHoverTargetExpression(nodeId: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return hoverTarget(nodeByIdStrict(${JSON.stringify(nodeId)}));
  })()`;
}

function selectorHoverTargetExpression(selector: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return hoverTarget(querySelectorStrict(${JSON.stringify(selector)}));
  })()`;
}

const selectedProfilesBySession = new Map<string, string>();
const usedProfilesBySession = new Map<string, Set<string>>();

type CdpDomain = "Runtime" | "Page" | "DOM" | "Network" | "Performance" | "Debugger" | "Log" | "Accessibility";
type InputGestureStep = { method: string; commandParams: object; cursor?: unknown; delayMs?: number };
const MAX_CAPTURE_DIMENSION = 16384;
const MAX_CAPTURE_BASE64_CHARS = 4_000_000;

function screenshotMime(format: string) {
  return format === "png" ? "image/png" : format === "jpeg" ? "image/jpeg" : "image/webp";
}

function contextValue(context: BrowserContext, keys: readonly (keyof BrowserContext)[]) {
  for (const key of keys) {
    if (context?.[key] !== undefined && context?.[key] !== null) return String(context[key]);
  }
  return null;
}

function sessionKey(context: BrowserContext) {
  return contextValue(context, ["sessionID", "sessionId", "session_id"]) ?? "opencode";
}

function sessionParams(context: BrowserContext, params: Record<string, unknown> = {}) {
  const sessionId = sessionKey(context);
  const turnId = contextValue(context, ["messageID", "messageId", "turnID", "turnId", "requestID", "requestId"])
    ?? sessionId;
  return {
    session_id: sessionId,
    turn_id: turnId,
    ...(context.frameId ? { frameId: context.frameId } : {}),
    ...(context.deadlineAt ? { deadlineAt: context.deadlineAt } : {}),
    ...(context?.urlPolicy ? { url_policy: { allowedOrigins: context.urlPolicy.allowedOrigins, blockedOrigins: context.urlPolicy.blockedOrigins } } : {}),
    ...params,
  };
}

function explicitProfileId(params: Record<string, unknown> = {}) {
  const id = params.profileId ?? params.profile_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function markProfileUsed(context: BrowserContext, profileId: string) {
  const key = sessionKey(context);
  let used = usedProfilesBySession.get(key);
  if (!used) {
    used = new Set<string>();
    usedProfilesBySession.set(key, used);
  }
  used.add(profileId);
}

async function resolveSessionProfileId(context: BrowserContext, requestedProfileId: string | null = null) {
  const key = sessionKey(context);
  const selected = selectedProfilesBySession.get(key) ?? null;
  const used = usedProfilesBySession.get(key);
  const stickyProfileId = !requestedProfileId && !selected && used?.size === 1 ? [...used][0] : null;
  const profile = await resolveBrowserProfile(requestedProfileId ?? selected ?? stickyProfileId);
  return profile.profileId;
}

async function profileSessionParams(context: BrowserContext, params: Record<string, unknown> = {}) {
  const requestedProfileId = explicitProfileId(params);
  const profileId = await resolveSessionProfileId(context, requestedProfileId);
  const cleanParams = { ...params };
  delete cleanParams.profileId;
  delete cleanParams.profile_id;
  return { profileId, params: sessionParams(context, { ...cleanParams, profile_id: profileId }) };
}

async function targetProfileIdsForSession(context: BrowserContext) {
  const key = sessionKey(context);
  const used = [...(usedProfilesBySession.get(key) ?? [])];
  if (used.length > 0) return used;

  const selected = selectedProfilesBySession.get(key);
  if (selected) return [selected];

  return [await resolveSessionProfileId(context)];
}

function parseExtensionResult<K extends string>(method: K, value: unknown): ExtensionResult<K> {
  const schema = extensionResultSchemas[method as ExtensionMethod];
  return (schema ? schema.parse(value) : record(value)) as ExtensionResult<K>;
}
async function extensionProfileRequest<K extends string>(context: BrowserContext, method: K, params: Record<string, unknown> = {}) {
  const request = await profileSessionParams(context, params);
  markProfileUsed(context, request.profileId);
  return {
    profileId: request.profileId,
    result: parseExtensionResult(method, await browserRequest(method, request.params, { profileId: request.profileId, timeoutMs: Math.max(20000, (context.deadlineAt ? context.deadlineAt - Date.now() : 10000) + 10000) })),
  };
}

async function extensionRequest<K extends string>(context: BrowserContext, method: K, params: Record<string, unknown> = {}) {
  return (await extensionProfileRequest(context, method, params)).result;
}

function addProfileToTabResult(result: unknown, profileId: string) {
  if (!isRecord(result)) return result;
  if (Array.isArray(result.tabs)) {
    return { ...result, profileId, tabs: result.tabs.map((tab) => ({ ...record(tab), profileId })) };
  }
  return { ...result, profileId };
}

const attachedTabKeys = new Set<string>();
const enabledDomainsByTabKey = new Map<string, Set<string>>();

function tabCacheKey(context: BrowserContext, profileId: string, tabId: number) {
  return `${sessionKey(context)}:${profileId}:${tabId}`;
}

function clearTabCache(context: BrowserContext, tabId: number, profileId: string | null = null) {
  if (profileId) {
    const key = tabCacheKey(context, profileId, tabId);
    attachedTabKeys.delete(key);
    enabledDomainsByTabKey.delete(key);
    return;
  }

  const prefix = `${sessionKey(context)}:`;
  const suffix = `:${tabId}`;
  for (const key of [...attachedTabKeys]) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) attachedTabKeys.delete(key);
  }
  for (const key of [...enabledDomainsByTabKey.keys()]) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) enabledDomainsByTabKey.delete(key);
  }
}

function clearSessionCache(context: BrowserContext, profileId: string | null = null) {
  const prefix = `${sessionKey(context)}:${profileId ? `${profileId}:` : ""}`;
  for (const key of [...attachedTabKeys]) {
    if (key.startsWith(prefix)) attachedTabKeys.delete(key);
  }
  for (const key of [...enabledDomainsByTabKey.keys()]) {
    if (key.startsWith(prefix)) enabledDomainsByTabKey.delete(key);
  }
}

function cdpRequestOptions(timeoutMs: unknown) {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.ceil(timeoutMs + 10000) } : {};
}

async function ensureAttached(context: BrowserContext, tabId: number, profileId: string) {
  const key = tabCacheKey(context, profileId, tabId);
  if (attachedTabKeys.has(key)) return;
  await extensionRequest(context, "attach", { tabId, profile_id: profileId });
  attachedTabKeys.add(key);
}

function isDebuggerDetachedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /debugger unattached|not attached/i.test(message);
}

async function executeCdpRequest(context: BrowserContext, tabId: number, method: string, commandParams: object = {}, timeoutMs: number | undefined = undefined, profileId: string | null = null) {
  const parameters = record(commandParams);
  const resolvedProfileId = profileId ?? await resolveSessionProfileId(context);
  markProfileUsed(context, resolvedProfileId);
  if ((method === "DOM.setFileInputFiles" && (Array.isArray(parameters.files) && parameters.files.length)) || (method === "Input.dispatchDragEvent" && (Array.isArray(record(parameters.data).files) && (record(parameters.data).files as unknown[]).length))) {
    const policy = await extensionRequest(context, "uploadPolicy", { profile_id: resolvedProfileId }).catch(() => null);
    if (policy?.version !== 1) throw new Error("Reload the updated browser extension to enable upload confirmation; no files were uploaded");
  }
  return browserRequest(
    "executeCdp",
    sessionParams(context, {
      profile_id: resolvedProfileId,
      target: { tabId },
      method,
      commandParams,
      timeoutMs, deadlineAt: context.deadlineAt ?? Date.now() + (timeoutMs ?? 10000),
    }),
    { ...cdpRequestOptions(context.deadlineAt ? Math.max(1, context.deadlineAt - Date.now()) : timeoutMs), profileId: resolvedProfileId },
  );
}

async function cdp<K extends CdpMethod>(context: BrowserContext, tabId: number, method: K, commandParams: CdpParams<K>, timeoutMs: number | undefined = undefined, options: { profileId?: string | null } = {}) {
  const profileId = options.profileId ?? await resolveSessionProfileId(context);
  if (method === "Target.getTargets") return await executeCdpRequest(context, tabId, method, commandParams, timeoutMs, profileId) as CdpResult<K>;

  await ensureAttached(context, tabId, profileId);
  if (method === "Performance.getMetrics") await enableCdpDomains(context, tabId, ["Performance"], { profileId });

  try {
    return await executeCdpRequest(context, tabId, method, commandParams, timeoutMs, profileId) as CdpResult<K>;
  } catch (error) {
    if (!isDebuggerDetachedError(error) || record(error).executionState !== "not_started" || record(error).uncertain === true) throw error;
    clearTabCache(context, tabId, profileId);
    await ensureAttached(context, tabId, profileId);
    return await executeCdpRequest(context, tabId, method, commandParams, timeoutMs, profileId) as CdpResult<K>;
  }
}

async function enableCdpDomains(context: BrowserContext, tabId: number, domains: CdpDomain[], options: { profileId?: string | null; optional?: boolean } = {}) {
  const profileId = options.profileId ?? await resolveSessionProfileId(context);
  const key = tabCacheKey(context, profileId, tabId);
  const enabled = enabledDomainsByTabKey.get(key) ?? new Set();

for (const domain of domains) {
    if (enabled.has(domain)) continue;
    try {
      await cdp(context, tabId, `${domain}.enable`, {}, undefined, { profileId });
      enabled.add(domain);
      if (domain === "Network" && context?.urlPolicy?.blockedOrigins?.length) {
        const urls = context.urlPolicy?.subresourcePatterns() ?? [];
        if (urls.length > 0) {
          await cdp(context, tabId, "Network.setBlockedURLs", { urls }, undefined, { profileId }).catch(() => {});
        }
      }
    } catch (error) {
      if (!options.optional) throw error;
    }
  }

  enabledDomainsByTabKey.set(key, enabled);
}

async function activate(context: BrowserContext, tabId: number) {
  await extensionRequest(context, "activateTab", { tabId, foreground: false, active: false }).catch(() => null);
}

async function moveCursor(context: BrowserContext, tabId: number, x: number, y: number, options: { action?: CursorAction; waitForArrival?: boolean } = {}) {
  return extensionRequest(context, "moveMouse", { tabId, x, y, ...options }).catch(() => null);
}

// Landing the cursor is cosmetic, so it never blocks the action that follows:
// one short message to the extension starts the glide, and the caller does not
// wait for the animation to finish.
async function pointCursor(context: BrowserContext, tabId: number, point: { x?: unknown; y?: unknown } | null | undefined, action: CursorAction | null) {
  const target = cursorPoint(point);
  if (!target || !action) return null;
  return moveCursor(context, tabId, target.x, target.y, { action, waitForArrival: false });
}

// Resolves a selector or node to a viewport point without clicking, so the
// cursor can land on the element the action is about to use.
async function resolveCursorPoint(context: BrowserContext, tabId: number, target: Partial<Target>) {
  if (target?.nodeId) return runtimeEvaluate(context, tabId, domNodeHoverTargetExpression(target.nodeId)).catch(() => null);
  if (target?.selector) return runtimeEvaluate(context, tabId, selectorHoverTargetExpression(target.selector)).catch(() => null);
  return cursorPoint(target);
}

async function inputGesture(context: BrowserContext, tabId: number, steps: InputGestureStep[], timeoutMs: number) {
  const { profileId, params } = await profileSessionParams(context, { tabId, steps, timeoutMs });
  markProfileUsed(context, profileId);
  return browserRequest(
    "inputGesture",
    params,
    { profileId, timeoutMs: Math.max((timeoutMs ?? 10000) + 10000, 30000) },
  );
}

async function enableInspection(context: BrowserContext, tabId: number) {
  await enableCdpDomains(context, tabId, ["Page", "Runtime", "Log", "Network", "Performance", "DOM", "Accessibility"], { optional: true });
}

function mouseButtons(button: string) {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 1;
}

function stringify(value: unknown) {
  return JSON.stringify(value);
}

function compactConsoleValue(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1000);
}

function consoleEventText(event: BrowserEvent) {
  const params = event.params ?? {};
  if (event.method === "Runtime.consoleAPICalled") {
    return (params.args ?? [])
      .map((arg) => compactConsoleValue(arg.value ?? arg.description ?? arg.preview?.description ?? arg.type))
      .filter(Boolean)
      .join(" ");
  }
  return compactConsoleValue(params.entry?.text ?? params.text ?? "");
}

function consoleEventLevel(event: BrowserEvent) {
  const params = event.params ?? {};
  return params.entry?.level ?? params.type ?? "log";
}

function consoleEventUrl(event: BrowserEvent) {
  const params = event.params ?? {};
  const frame = params.stackTrace?.callFrames?.[0] ?? params.entry?.stackTrace?.callFrames?.[0];
  return params.entry?.url ?? frame?.url ?? null;
}

function compactDialogEvents(response: BrowserEvents) {
  const events = Array.isArray(response?.events) ? response.events : [];
  const dialogs = [];
  let open = null;
  for (const event of events) {
    const params = event.params ?? {};
    if (event.method === "Page.javascriptDialogOpening") {
      open = {
        type: params.type ?? null,
        message: compactConsoleValue(params.message) || null,
        url: params.url ?? null,
        hasBrowserHandler: params.hasBrowserHandler === true,
        defaultPrompt: params.defaultPrompt ?? null,
      };
      dialogs.push({ event: "opened", ...open });
    } else if (event.method === "Page.javascriptDialogClosed") {
      open = null;
      dialogs.push({
        event: "closed",
        result: params.result ?? null,
        userInput: compactConsoleValue(params.userInput) || null,
      });
    }
  }
  const current = record(response.dialogs).open;
  return { totalEvents: events.length, returned: dialogs.length, open: Array.isArray(current) ? current[0] ?? null : open, health: response.health, events: dialogs };
}

function compactConsoleEvents(response: BrowserEvents, options: { raw?: boolean; includeStack?: boolean; sourceMapped?: boolean; resolver?: SourceMapResolver | null } = {}) {
  if (options.raw) return response;
  const events = Array.isArray(response?.events) ? response.events : [];
  const grouped = new Map();
  for (const event of events) {
    const text = consoleEventText(event);
    const level = consoleEventLevel(event);
    const url = consoleEventUrl(event);
    const key = [event.method, level, text, url].join("\u0000");
    const existing = grouped.get(key);
    const params = event.params ?? {};
    const callFrames = params.stackTrace?.callFrames ?? params.entry?.stackTrace?.callFrames ?? [];
    const frame = callFrames[0] ?? null;
    if (existing) {
      existing.count += 1;
      existing.lastTime = event.time;
      continue;
    }
    grouped.set(key, {
      time: event.time,
      lastTime: event.time,
      tabId: event.tabId,
      method: event.method,
      level,
      source: params.entry?.source ?? null,
      text,
      url,
      blockedByClient: /ERR_BLOCKED_BY_CLIENT/i.test(text),
      count: 1,
      ...(frame ? { topFrame: { functionName: frame.functionName || null, url: frame.url || null, lineNumber: frame.lineNumber !== undefined && Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null, columnNumber: frame.columnNumber !== undefined && Number.isInteger(frame.columnNumber) ? frame.columnNumber + 1 : null } } : {}),
      ...(options.includeStack ? { stackTrace: params.stackTrace ?? params.entry?.stackTrace ?? null } : {}),
      ...(options.sourceMapped === true && callFrames.length > 0 ? { stack: mapCallFrames(callFrames, options.resolver ?? null) } : {}),
    });
  }
  const compacted = [...grouped.values()].sort((first, second) => String(first.time).localeCompare(String(second.time)));
  return {
    totalEvents: events.length,
    returned: compacted.length,
    grouped: true,
    events: compacted,
  };
}

async function runtimeEvaluate(context: BrowserContext, tabId: number, expression: string, options: { userGesture?: boolean; timeoutMs?: number; runtimeTimeoutMs?: number; awaitPromise?: boolean; returnByValue?: boolean } = {}) {
  await enableCdpDomains(context, tabId, ["Runtime"], { optional: true });
  const result = await cdp(context, tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture !== false,
    timeout: options.runtimeTimeoutMs,
  }, options.timeoutMs);
  if (result.exceptionDetails) {
    throw pageException(result.exceptionDetails);
  }
  return result.result?.value;
}

  return { selectedProfilesBySession, usedProfilesBySession, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_BASE64_CHARS, screenshotMime, contextValue, sessionKey, sessionParams, explicitProfileId, markProfileUsed, resolveSessionProfileId, profileSessionParams, targetProfileIdsForSession, parseExtensionResult, extensionProfileRequest, extensionRequest, addProfileToTabResult, attachedTabKeys, enabledDomainsByTabKey, tabCacheKey, clearTabCache, clearSessionCache, cdpRequestOptions, ensureAttached, isDebuggerDetachedError, executeCdpRequest, cdp, enableCdpDomains, activate, moveCursor, pointCursor, resolveCursorPoint, inputGesture, enableInspection, mouseButtons, stringify, compactConsoleValue, consoleEventText, consoleEventLevel, consoleEventUrl, compactDialogEvents, compactConsoleEvents, runtimeEvaluate };
}
