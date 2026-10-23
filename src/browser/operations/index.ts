type ScrollSnapshot = { window: { scrollLeft: number; scrollTop: number }; target: { scrollLeft: number; scrollTop: number } | null };
import { Buffer } from "node:buffer";
import { z } from "zod";
import { SourceMapResolver,mapCallFrames } from "../../../native-host/src/source-maps.ts";
import { NETWORK_INSPECT_ARGS } from "../../core/network-capability.ts";
import { candidateSchema } from "../../core/operation-results.ts";
import type { Environment,Target } from "../../core/registry.ts";
import type { BrowserContext } from "../../core/tool-definition.ts";
import type { CdpMethod,CdpParams,CdpResult } from "../../shared/cdp.ts";
import type { CursorAction } from "../../shared/cursor-actions.ts";
import { isRecord,record,requiredRecord } from "../../shared/values.ts";
import { browserRequest,listBrowserProfiles,resolveBrowserProfile } from "../client.ts";
import { cursorActionForTool,cursorPoint } from "../cursor.ts";
import { createDiscoveryOperations } from "../discovery.ts";
import { createEnvironmentController } from "../environment.ts";
import { extensionResultSchemas,type BrowserEvent,type BrowserEvents,type ExtensionMethod,type ExtensionResult } from "../events.ts";
import { keyDispatchEvents,parseKeyPress } from "../keyboard.ts";
import { inspectNetworkEvents } from "../network.ts";
import { defineBrowserOperation } from "../operation-definition.ts";
import { createPageBackend } from "../page-backend.ts";
import { createFileInputOperation } from "../uploads.ts";
import { assertNavigationAllowed } from "../url-policy.ts";
import { pageInspectExpression,visualMapExpression } from './inspection-expressions.ts';
import { interactionHelpersSource } from './interaction-helpers.ts';
import { domSnapshotExpression,pageSearchUnitsExpression } from './snapshot-expressions.ts';
export { keyDispatchEvents,parseKeyPress } from "../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from './inspection-expressions.ts';
export { pageSearchUnitsExpression } from './snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.
const tool = Object.assign(defineBrowserOperation, { schema: z });

const selectedProfilesBySession = new Map<string, string>();
const usedProfilesBySession = new Map<string, Set<string>>();

type SearchResult = z.infer<typeof candidateSchema>;
type CdpDomain = "Runtime" | "Page" | "DOM" | "Network" | "Performance" | "Debugger" | "Log" | "Accessibility";
type InputGestureStep = { method: string; commandParams: object; cursor?: unknown; delayMs?: number };
type EditableOptions = { selectAll?: boolean; cursorAtEnd?: boolean; includeSelect?: boolean };
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
    result: parseExtensionResult(method, await browserRequest(method, request.params, { profileId: request.profileId })),
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
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.ceil(timeoutMs + 5000) } : {};
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
      timeoutMs,
    }),
    { ...cdpRequestOptions(timeoutMs), profileId: resolvedProfileId },
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
    if (!isDebuggerDetachedError(error)) throw error;
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
    { profileId, timeoutMs: Math.max(timeoutMs ?? 0, 30000) },
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
  return { totalEvents: events.length, returned: dialogs.length, open, events: dialogs };
}

export function compactConsoleEvents(response: BrowserEvents, options: { raw?: boolean; includeStack?: boolean; sourceMapped?: boolean; resolver?: SourceMapResolver | null } = {}) {
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

function pageSearchLabel(result: SearchResult) {
  return compactConsoleValue(result.name || result.text || result.selector || result.kind).slice(0, 220) || null;
}

function leanPageSearchResult(result: SearchResult) {
  const shaped: { node_id: string | number | null; kind: string | null; label: string | null; role: string | null; interactive: boolean; selector?: string | null } = {
    node_id: result.node_id ?? null,
    kind: result.kind ?? null,
    label: pageSearchLabel(result),
    role: result.role ?? null,
    interactive: result.interactive === true,
  };
  if (shaped.node_id === null || shaped.node_id === undefined) shaped.selector = result.selector ?? null;
  return shaped;
}

function compactPageSearchResult(result: SearchResult) {
  return {
    ...leanPageSearchResult(result),
    selector: result.selector ?? null,
    text: compactConsoleValue(result.text).slice(0, 220) || null,
    score: typeof result.score === "number" && Number.isFinite(result.score) ? Number(result.score.toFixed(4)) : null,
  };
}

function compactModelUse(input: unknown) {
  const ranking = record(input);
  const model = record(ranking.model);
  if (!model || typeof model !== "object") return null;
  return {
    enabled: ranking.enabled === true,
    used: model.used === true,
    error: model.error ?? record(model.embedding).error ?? record(model.reranker).error ?? null,
  };
}

export function shapePageSearchRanking(input: unknown, detail: string = "lean") {
  const ranking = record(input);
  if (detail === "full" || detail === "debug" || !Array.isArray(ranking?.results)) return ranking;
  const base = {
    url: ranking.url,
    title: ranking.title,
    query: ranking.query,
    scope: ranking.scope ?? null,
    totalCandidates: ranking.totalCandidates,
    truncated: ranking.truncated,
    mode: ranking.mode,
    totalUnits: ranking.totalUnits,
    returned: ranking.returned,
  };
  if (detail === "compact") {
    return {
      ...base,
      model: compactModelUse(ranking),
      results: ranking.results.map(value => compactPageSearchResult(candidateSchema.parse(value))),
    };
  }
  return {
    ...base,
    results: ranking.results.map(value => leanPageSearchResult(candidateSchema.parse(value))),
  };
}

function parseJsonObject(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return {};
  let parsed;
  try {
    if (typeof value !== "string") throw new Error("Expected JSON string");
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return requiredRecord(parsed);
}

function cdpParamsFromArgs(args: { params?: Record<string, unknown>; paramsJson?: string }) {
  return {
    ...(args.params && typeof args.params === "object" ? args.params : {}),
    ...parseJsonObject(args.paramsJson, "paramsJson"),
  };
}

function escapeHtml(value: string) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeDataUrl(url: string) {
  const match = /^data:([^,]*),(.*)$/is.exec(url);
  if (!match) throw new Error("Invalid data URL");
  const metadata = match[1] ?? "";
  const payload = match[2] ?? "";
  const parts = metadata.split(";").filter(Boolean);
  const mimeType = (parts[0]?.includes("/") ? parts[0] : "text/plain").toLowerCase();
  const base64 = parts.some((part) => part.toLowerCase() === "base64");
  if (base64) return { mimeType, text: Buffer.from(payload, "base64").toString("utf8") };
  try {
    return { mimeType, text: decodeURIComponent(payload.replace(/\+/g, "%20")) };
  } catch {
    return { mimeType, text: payload };
  }
}

function documentForDataUrl(url: string) {
  const { mimeType, text } = decodeDataUrl(url);
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
    return { mimeType, html: text };
  }
  if (mimeType.startsWith("image/") || mimeType === "application/pdf") {
    const tag = mimeType === "application/pdf"
      ? `<embed src="${escapeHtml(url)}" type="application/pdf" width="100%" height="100%">`
      : `<img src="${escapeHtml(url)}" alt="" style="max-width:100%;height:auto;display:block">`;
    return {
      mimeType,
      html: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;background:white}</style></head><body>${tag}</body></html>`,
    };
  }
  return {
    mimeType,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>data URL</title></head><body><pre>${escapeHtml(text)}</pre></body></html>`,
  };
}

async function navigateDataUrl(context: BrowserContext, tabId: number, url: string) {
  const document = documentForDataUrl(url);
  await cdp(context, tabId, "Page.enable", {}).catch(() => {});
  const navigation = await cdp(context, tabId, "Page.navigate", { url: "about:blank" });
  const frameId = navigation.frameId
    ?? (await cdp(context, tabId, "Page.getFrameTree", {})).frameTree?.frame?.id;
  if (!frameId) throw new Error("Could not find main frame for data URL navigation");
  await cdp(context, tabId, "Page.setDocumentContent", { frameId, html: document.html });
  return { tabId, url, loadedAs: "documentContent", mimeType: document.mimeType };
}

function mouseStep(commandParams: CdpParams<"Input.dispatchMouseEvent">, cursor: unknown, delayMs: number = 0) {
  // Native mouse input is intentionally reserved for drag gestures. Chromium
  // focuses the renderer when it receives these injected pointer events.
  return {
    method: "Input.dispatchMouseEvent",
    commandParams,
    cursor,
    delayMs,
  };
}

function interpolatePath(points: { x: number; y: number }[], maxStep: number = 16) {
  const output = [];
  for (const point of points) {
    if (!output.length) {
      output.push(point);
      continue;
    }
    const previous = output.at(-1);
    if (!previous) throw new Error("Missing drag path origin");
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const steps = Math.max(1, Math.ceil(distance / maxStep));
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      output.push({
        x: previous.x + (point.x - previous.x) * progress,
        y: previous.y + (point.y - previous.y) * progress,
      });
    }
  }
  return output;
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
    const details = result.exceptionDetails;
    const callFrame = details.stackTrace?.callFrames?.[0];
    const location = callFrame ? ` (${callFrame.url || "evaluated script"}:${callFrame.lineNumber + 1}:${callFrame.columnNumber + 1})` : "";
    const message = `${details.exception?.description ?? details.text ?? "Runtime.evaluate failed"}${location}`;
    throw new Error(message);
  }
  return result.result?.value;
}

function finiteNumber(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

const pageBackend = createPageBackend({ request: extensionRequest, evaluate: runtimeEvaluate, command: cdp, ready: waitForPageReady });
const environmentController = createEnvironmentController({
  command: cdp,
  backend: pageBackend,
  enableNetwork: (context, tabId) => enableCdpDomains(context, tabId, ["Network"]),
  keyFor: async (context: BrowserContext, tabId) => tabCacheKey(context, await resolveSessionProfileId(context), tabId),
});
async function navigateHistory(context: BrowserContext, tabId: number, delta: number) {
  const alternate = await pageBackend.history(context, tabId, delta);
  if (alternate) return alternate;
  await enableCdpDomains(context, tabId, ["Page"], { optional: true });
  const history = await cdp(context, tabId, "Page.getNavigationHistory", {});
  const targetIndex = history.currentIndex + delta;
  const entry = history.entries?.[targetIndex];
  if (!entry) throw new Error(delta < 0 ? "No previous history entry" : "No next history entry");
  await cdp(context, tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
  const readiness = await waitForPageReady(context, tabId, "domcontentloaded", 15000);
  return { ...entry, readiness };
}

async function grantClipboardPermission(context: BrowserContext, tabId: number) {
  const tab = await extensionRequest(context, "getTab", { tabId }).catch(() => null);
  let origin;
  try {
    origin = tab?.url ? new URL(tab.url).origin : null;
  } catch {
    origin = null;
  }
  if (!origin || origin === "null") return;
  await cdp(context, tabId, "Browser.grantPermissions", {
    origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch(() => {});
}

function validClip(input: unknown) {
  const clip = record(input);
  if (!clip || typeof clip !== "object") return null;
  const x = Number(clip.x);
  const y = Number(clip.y);
  const width = Number(clip.width);
  const height = Number(clip.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), scale: typeof clip.scale === "number" && Number.isFinite(clip.scale) ? clip.scale : 1 };
}

function visualMapCaptureClip(args: { clip?: unknown }, map: unknown) {
  const explicit = validClip(args.clip);
  if (explicit) return explicit;
  const scope = record(record(map).scope);
  const scopeBox = validClip(scope.boundingBox);
  if (scopeBox && scope.mode && scope.mode !== "page" && scope.mode !== "viewport") {
    return {
      x: Math.max(0, scopeBox.x - 8),
      y: Math.max(0, scopeBox.y - 8),
      width: scopeBox.width + 16,
      height: scopeBox.height + 16,
      scale: 1,
    };
  }
  return null;
}

function shouldRunVisualModel(args: { vision?: string }, map: unknown) {
  if (args.vision === "off") return false;
  if (args.vision === "force") return true;
  return !Array.isArray(record(map).elements) || (record(map).elements as unknown[]).length === 0;
}

async function captureVisualMapScreenshot(context: BrowserContext, tabId: number, args: { timeoutMs?: number; clip?: unknown }, map: unknown) {
  await enableCdpDomains(context, tabId, ["Page"], { optional: true });
  const clip = visualMapCaptureClip(args, map);
  const params: CdpParams<"Page.captureScreenshot"> = { format: "png", optimizeForSpeed: true };
  if (clip) params.clip = clip;
  const result = await cdp(context, tabId, "Page.captureScreenshot", params, args.timeoutMs ?? 30000);
  return { base64: result.data, origin: { x: clip?.x ?? 0, y: clip?.y ?? 0 } };
}

function visualElementForDetail(input: unknown, origin: { x: number; y: number }, detail: string) {
  const element = record(input);
  const sourceBox = record(element.box);
  const box = element.box && typeof element.box === "object"
    ? {
        x: Math.round(Number(sourceBox.x ?? 0) + origin.x),
        y: Math.round(Number(sourceBox.y ?? 0) + origin.y),
        width: Math.max(1, Math.round(Number(sourceBox.width ?? 1))),
        height: Math.max(1, Math.round(Number(sourceBox.height ?? 1))),
      }
    : null;
  const lean = {
    node_id: null,
    kind: compactConsoleValue(element?.kind || element?.label || "visual").slice(0, 80) || "visual",
    label: compactConsoleValue(element?.label || element?.kind || "visual").slice(0, 160) || "visual",
    box,
    source: "visual",
  };
  if (detail !== "debug") return lean;
  return { ...lean, score: Number.isFinite(element?.score) ? element.score : null };
}

function mergeVisualMapModelResult(mapInput: unknown, visualInput: unknown, origin: { x: number; y: number }, detail: string) {
  const map = record(mapInput), visual = record(visualInput);
  const elements = Array.isArray(visual.elements) ? visual.elements : [];
  if (!elements.length) return map;
  return {
    ...map,
    elements: [
      ...(Array.isArray(map.elements) ? map.elements : []),
      ...elements.map((element) => visualElementForDetail(element, origin, detail)).filter((element) => element.box),
    ],
    returned: Number(map.returned ?? 0) + elements.length,
    sources: [...new Set([...(Array.isArray(map.sources) ? map.sources : ["dom"]), "visual"])],
    ...(detail === "debug" ? { visualModel: { used: visual.used === true, model: visual.model ?? null } } : {}),
  };
}

export function domNodeClickTargetExpression(nodeId: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(nodeByIdStrict(${JSON.stringify(nodeId)}));
  })()`;
}

function backgroundClickExpression(targetExpression: string, options: { button?: string; clickCount?: number; trusted?: boolean } = {}) {
  const clickOptions = {
    button: options.button ?? "left",
    clickCount: options.clickCount ?? 1,
  };
  return `(() => {
    ${interactionHelpersSource()}
    const element = ${targetExpression};
    const target = clickTarget(element);
    ${options.trusted ? "" : `backgroundClick(element, target, ${JSON.stringify(clickOptions)});`}
    return target;
  })()`;
}

export function domNodeClickExpression(nodeId: string, options: { trusted?: boolean } = {}) {
  return backgroundClickExpression(`nodeByIdStrict(${JSON.stringify(nodeId)})`, options);
}

export function domNodeHoverTargetExpression(nodeId: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return hoverTarget(nodeByIdStrict(${JSON.stringify(nodeId)}));
  })()`;
}

export function domNodeEditableExpression(nodeId: string, options: EditableOptions = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    return prepareEditable(nodeByIdStrict(${JSON.stringify(nodeId)}), ${JSON.stringify(options)});
  })()`;
}

export function selectorClickTargetExpression(selector: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(querySelectorStrict(${JSON.stringify(selector)}));
  })()`;
}

export function selectorClickExpression(selector: string, options: { trusted?: boolean } = {}) {
  return backgroundClickExpression(`querySelectorStrict(${JSON.stringify(selector)})`, options);
}

export function clickAtPointExpression(x: number, y: number, options: { button?: string; trusted?: boolean; clickCount?: number } = {}) {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  const clickOptions = {
    button: options.button ?? "left",
    clickCount: options.clickCount ?? 1,
  };
  return `(() => {
    ${interactionHelpersSource()}
    const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
    const element = document.elementFromPoint(point.x, point.y);
    if (!element) throw new Error('No element at viewport point: ' + point.x + ', ' + point.y);
    assertPointerInteractable(element);
    visibleRect(element);
    ${options.trusted ? "" : `backgroundClick(element, point, ${JSON.stringify(clickOptions)});`}
    return {
      x: point.x,
      y: point.y,
      tagName: element.localName,
      text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    };
  })()`;
}

export function hoverAtPointExpression(x: number, y: number) {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  return `(() => {
    ${interactionHelpersSource()}
    const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
    const element = document.elementFromPoint(point.x, point.y);
    if (!element) throw new Error('No element at viewport point: ' + point.x + ', ' + point.y);
    assertPointerInteractable(element);
    visibleRect(element);
    backgroundHover(element, point);
    return {
      x: point.x,
      y: point.y,
      tagName: element.localName,
      text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
    };
  })()`;
}

export function selectorHoverTargetExpression(selector: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return hoverTarget(querySelectorStrict(${JSON.stringify(selector)}));
  })()`;
}

export function selectorEditableExpression(selector: string, options: EditableOptions = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    return prepareEditable(querySelectorStrict(${JSON.stringify(selector)}), ${JSON.stringify(options)});
  })()`;
}

function selectorTextExpression(selector: string) {
  return `(() => {
    ${interactionHelpersSource()}
    const element = querySelectorStrict(${JSON.stringify(selector)});
    return (element.innerText || element.value || element.textContent || '').trim();
  })()`;
}

function focusedEditableSnapshotExpression(options: { includeSelect?: boolean } = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    const element = focusedEditableElement(${JSON.stringify(Boolean(options.includeSelect))});
    if (!element) throw new Error('No editable element is focused');
    const kind = editableKind(element, ${JSON.stringify(Boolean(options.includeSelect))});
    if (kind === 'select' && !${JSON.stringify(Boolean(options.includeSelect))}) throw new Error('Focused element is not text-editable');
    return editableSnapshot(element, kind);
  })()`;
}

// The cursor lands on the element a typing action will change, so the pointer
// is not left somewhere else while text appears.
export function focusedEditableTargetExpression() {
  return `(() => {
    ${interactionHelpersSource()}
    const element = focusedEditableElement(false);
    return element ? hoverTarget(element) : null;
  })()`;
}

function verifyFocusedEditableExpression(before: unknown, options: { insertedText?: string; expectedValue?: string; includeSelect?: boolean } = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    const before = ${JSON.stringify(before)};
    const expectedValue = ${JSON.stringify(options.expectedValue)};
    const insertedText = ${JSON.stringify(options.insertedText ?? "")};
    const element = focusedEditableElement(${JSON.stringify(Boolean(options.includeSelect))});
    if (!element) throw new Error('No editable element is focused after input');
    const kind = editableKind(element, ${JSON.stringify(Boolean(options.includeSelect))});
    const after = editableSnapshot(element, kind);
    if (expectedValue !== undefined && after.value !== expectedValue) {
      throw new Error('Input verification failed: expected value ' + JSON.stringify(expectedValue) + ' but got ' + JSON.stringify(after.value));
    }
    if (expectedValue === undefined && insertedText.length > 0 && after.value === before.value && after.selectionStart === before.selectionStart && after.selectionEnd === before.selectionEnd && after.selectedText === before.selectedText) {
      throw new Error('Input verification failed: focused element did not change');
    }
    return after;
  })()`;
}

function setFocusedSelectValueExpression(value: string) {
  return `(() => {
    ${interactionHelpersSource()}
    return setFocusedSelectValue(${JSON.stringify(value)});
  })()`;
}

function verifyFocusedSelectAllExpression(before: unknown) {
  return `(() => {
    ${interactionHelpersSource()}
    const before = ${JSON.stringify(before)};
    const element = focusedEditableElement(false);
    if (!element) throw new Error('No editable element is focused after select-all');
    const kind = editableKind(element, false);
    const after = editableSnapshot(element, kind);
    if (kind === 'input' || kind === 'textarea') {
      if (after.selectionStart !== 0 || after.selectionEnd !== after.value.length) {
        throw new Error('Select-all verification failed: selection is ' + after.selectionStart + '-' + after.selectionEnd + ' of ' + after.value.length);
      }
    } else if (kind === 'contenteditable' && after.value.length > 0 && after.selectedText.length < before.value.length) {
      throw new Error('Select-all verification failed: contenteditable text was not fully selected');
    }
    return after;
  })()`;
}

async function clickPoint(context: BrowserContext, tabId: number, x: number, y: number, button: "left" | "middle" | "right" = "left") {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  await activate(context, tabId);
  return pageBackend.click(context, tabId, trusted => clickAtPointExpression(x, y, { button, trusted }), { button });
}

async function hoverPoint(context: BrowserContext, tabId: number, x: number, y: number) {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  await activate(context, tabId);
  return pageBackend.hover(context, tabId, await runtimeEvaluate(context, tabId, hoverAtPointExpression(x, y), { userGesture: false }));
}

async function insertTextAndVerify(context: BrowserContext, tabId: number, before: unknown, text: string, options: { expectedValue?: string; includeSelect?: boolean } = {}) {
  const chunkSize = 16384;
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    await cdp(context, tabId, "Input.insertText", { text: text.slice(offset, offset + chunkSize) });
  }
  return runtimeEvaluate(context, tabId, verifyFocusedEditableExpression(before, {
    insertedText: text,
    expectedValue: options.expectedValue,
    includeSelect: options.includeSelect,
  }));
}

async function fillFocusedEditable(context: BrowserContext, tabId: number, before: { kind: string; value: string }, value: string) {
  if (before.kind === "select") {
    const after = await runtimeEvaluate(context, tabId, setFocusedSelectValueExpression(value));
    return { filled: true, tabId, kind: after.kind, value: after.value, valueLength: after.value.length, valueHash: after.valueHash };
  }

  if (value.length === 0 && before.value.length > 0) {
    const parsed = parseKeyPress("Backspace");
    for (const event of keyDispatchEvents(parsed)) await cdp(context, tabId, "Input.dispatchKeyEvent", event);
    const after = await runtimeEvaluate(context, tabId, verifyFocusedEditableExpression(before, { expectedValue: "" }));
    return { filled: true, tabId, kind: after.kind, valueLength: after.value.length, valueHash: after.valueHash };
  }

  const after = await insertTextAndVerify(context, tabId, before, value, { expectedValue: value });
  return { filled: true, tabId, kind: after.kind, valueLength: after.value.length, valueHash: after.valueHash };
}

async function pressKey(context: BrowserContext, tabId: number, key: string) {
  const parsed = parseKeyPress(key);
  await activate(context, tabId);
  const before = parsed.selectAll
    ? await runtimeEvaluate(context, tabId, focusedEditableSnapshotExpression())
    : null;

  for (const event of keyDispatchEvents(parsed)) {
    await cdp(context, tabId, "Input.dispatchKeyEvent", event);
  }

  const after = parsed.selectAll
    ? await runtimeEvaluate(context, tabId, verifyFocusedSelectAllExpression(before))
    : null;

  return { pressed: key, tabId, parsed: { key: parsed.primary.key, code: parsed.primary.code, modifiers: parsed.modifiers }, verification: after };
}

function sleep(ms: number|undefined) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrollPoint(context: BrowserContext, tabId: number, x: number | undefined, y: number | undefined) {
  if (x !== undefined) finiteNumber(x, "x");
  if (y !== undefined) finiteNumber(y, "y");

  if (x !== undefined && y !== undefined) return { x, y };

  const viewport = await runtimeEvaluate(
    context,
    tabId,
    "({ width: window.innerWidth || 800, height: window.innerHeight || 600 })",
    { timeoutMs: 3000, runtimeTimeoutMs: 1000 },
  ).catch(() => ({ width: 800, height: 600 }));
  return {
    x: x ?? Math.max(1, Math.floor((viewport.width ?? 800) / 2)),
    y: y ?? Math.max(1, Math.floor((viewport.height ?? 600) / 2)),
  };
}

function scrollSnapshotExpression(x: number, y: number) {
  return `(() => {
    const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
    const root = document.scrollingElement || document.documentElement;
    const metrics = (element) => ({
      tag: element === root ? "window" : element.tagName,
      id: element === root ? null : (element.id || null),
      className: element === root ? null : (typeof element.className === "string" ? element.className.slice(0, 120) : null),
      scrollLeft: element === root ? window.scrollX : element.scrollLeft,
      scrollTop: element === root ? window.scrollY : element.scrollTop,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientWidth: element === root ? window.innerWidth : element.clientWidth,
      clientHeight: element === root ? window.innerHeight : element.clientHeight,
    });
    const isScrollable = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const canY = /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
      const canX = /(auto|scroll|overlay)/.test(overflowX) && element.scrollWidth > element.clientWidth + 1;
      return canY || canX;
    };
    let target = document.elementFromPoint(point.x, point.y);
    for (let element = target; element; element = element.parentElement) {
      if (isScrollable(element)) {
        target = element;
        break;
      }
    }
    if (!target || !isScrollable(target)) target = root;
    return { point, window: metrics(root), target: metrics(target) };
  })()`;
}

function scrollFallbackExpression(x: number, y: number, scrollX: number, scrollY: number) {
  return `(() => {
    const snapshot = ${scrollSnapshotExpression(x, y)};
    const root = document.scrollingElement || document.documentElement;
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const isScrollable = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const canY = /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
      const canX = /(auto|scroll|overlay)/.test(overflowX) && element.scrollWidth > element.clientWidth + 1;
      return canY || canX;
    };
    let scrollTarget = target;
    for (let element = target; element; element = element.parentElement) {
      if (isScrollable(element)) {
        scrollTarget = element;
        break;
      }
    }
    if (!scrollTarget || !isScrollable(scrollTarget)) scrollTarget = root;
    if (scrollTarget === root) window.scrollBy({ left: ${JSON.stringify(scrollX)}, top: ${JSON.stringify(scrollY)}, behavior: "auto" });
    else scrollTarget.scrollBy({ left: ${JSON.stringify(scrollX)}, top: ${JSON.stringify(scrollY)}, behavior: "auto" });
    return { before: snapshot, after: ${scrollSnapshotExpression(x, y)} };
  })()`;
}

function didScroll(before: ScrollSnapshot, after: ScrollSnapshot) {
  return before?.window?.scrollLeft !== after?.window?.scrollLeft
    || before?.window?.scrollTop !== after?.window?.scrollTop
    || before?.target?.scrollLeft !== after?.target?.scrollLeft
    || before?.target?.scrollTop !== after?.target?.scrollTop;
}

async function scrollTab(context: BrowserContext, tabId: number, args: { scrollX: number; scrollY: number; x?: number; y?: number }) {
  finiteNumber(args.scrollX, "scrollX");
  finiteNumber(args.scrollY, "scrollY");
  await activate(context, tabId);
  const point = await scrollPoint(context, tabId, args.x, args.y);
  await pointCursor(context, tabId, point, "scroll");
  const before = await runtimeEvaluate(context, tabId, scrollSnapshotExpression(point.x, point.y), { timeoutMs: 3000, runtimeTimeoutMs: 1000 });
  if (args.scrollX === 0 && args.scrollY === 0) {
    return { scrolled: false, fallbackUsed: false, tabId, ...point, scrollX: args.scrollX, scrollY: args.scrollY, before, after: before };
  }

  const result = await runtimeEvaluate(context, tabId, scrollFallbackExpression(point.x, point.y, args.scrollX, args.scrollY), {
    timeoutMs: 3000,
    runtimeTimeoutMs: 1000,
    userGesture: false,
  });
  return { scrolled: didScroll(result.before, result.after), fallbackUsed: true, tabId, ...point, scrollX: args.scrollX, scrollY: args.scrollY, before, after: result.after };
}

async function waitForPageReady(context: BrowserContext, tabId: number, waitUntil: string = "domcontentloaded", timeoutMs: number = 15000) {
  if (waitUntil === "none") return { waitUntil, readyState: null };
  const expected = waitUntil === "load" ? ["complete"] : ["interactive", "complete"];
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      lastState = await runtimeEvaluate(context, tabId, "document.readyState", { timeoutMs: Math.min(2000, timeoutMs), runtimeTimeoutMs: 1000 });
      if (expected.includes(lastState)) return { waitUntil, readyState: lastState };
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }

  const suffix = lastError ? ` Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}` : "";
  throw new Error(`Timed out waiting for page ${waitUntil}; last readyState was ${lastState ?? "unknown"}.${suffix}`);
}

async function applyEnvironment(context: BrowserContext, tabId: number, env: Environment) {
  await environmentController.apply(context, tabId, env);
}

async function resetEnvironment(context: BrowserContext, tabId: number) {
  await environmentController.reset(context, tabId);
}

function fetchSourceMapFromPageExpression(scriptUrl: unknown) {
  return `(async () => {
    const url = ${JSON.stringify(scriptUrl)};
    try {
      const script = await fetch(url, { credentials: "include" });
      if (!script.ok) return null;
      const text = await script.text();
      const match = /\\/\\/#\\s*sourceMappingURL=([^\\s]+)/.exec(text);
      if (!match) return null;
      const mapUrl = new URL(match[1], url).href;
      const map = await fetch(mapUrl, { credentials: "include" });
      if (!map.ok) return null;
      return await map.json();
    } catch {
      return null;
    }
  })()`;
}

async function fetchConsoleSourceMaps(context: BrowserContext, tabId: number, events: BrowserEvent[], resolver: SourceMapResolver) {
  const urls = new Set();
  for (const event of events) {
    const params = event.params ?? {};
    const frames = params.stackTrace?.callFrames ?? params.entry?.stackTrace?.callFrames ?? [];
    for (const frame of frames) {
      if (typeof frame.url === "string" && frame.url.length > 0) urls.add(frame.url);
    }
  }
  for (const url of urls) {
    if (resolver.has(url)) continue;
    const map = await runtimeEvaluate(context, tabId, fetchSourceMapFromPageExpression(url), {
      timeoutMs: 10000,
    }).catch(() => null);
    if (map) resolver.set(url, map);
  }
  return resolver;
}

const networkInspectOperation = Object.assign(tool({
  description: "Inspect one controlled tab's request/response lifecycle with bounded, redacted detail.",
  args: NETWORK_INSPECT_ARGS,
  async execute(args, context) {
    const profileId = await resolveSessionProfileId(context);
    await enableCdpDomains(context, args.tabId, ["Network"]);
    const response = await extensionRequest(context, "getCdpEvents", {
      tabId: args.tabId,
      limit: 500,
      methodPrefix: "Network.",
    });
    const inspection = await inspectNetworkEvents(response?.events ?? [], args, {
      async getRequestBody(requestId: string) {
        return cdp(context, args.tabId, "Network.getRequestPostData", { requestId }, 10000, { profileId });
      },
      async getResponseBody(requestId: string) {
        return cdp(context, args.tabId, "Network.getResponseBody", { requestId }, 10000, { profileId });
      },
    });
    return stringify({ tabId: args.tabId, ...inspection });
  },
}), { capabilityOnly: true });

export const createBrowserOperations = async () => {
  const tools = {
      browser_status: tool({
        description: "Check the agent-browser native host connection status.",
        args: {},
        async execute(_args, context) {
          const host = await browserRequest("host.status");
          let extension;
          try {
            const profileId = await resolveSessionProfileId(context);
            extension = {
              selectedProfileId: profileId,
              ping: await browserRequest("ping", { profile_id: profileId }, { profileId }),
              info: await browserRequest("getInfo", { profile_id: profileId }, { profileId }),
            };
          } catch (error) {
            extension = { error: error instanceof Error ? error.message : String(error) };
          }
          return stringify({ host, selectedProfileId: selectedProfilesBySession.get(sessionKey(context)) ?? null, extension });
        },
      }),
      browser_list_profiles: tool({
        description: "List currently connected browser profiles available to OpenCode. Closed profiles are not launched or returned.",
        args: {},
        async execute() {
          return stringify({ profiles: await listBrowserProfiles() });
        },
      }),
      browser_selected_profile: tool({
        description: "Return the browser profile selected for this OpenCode session, if any.",
        args: {},
        async execute(_args, context) {
          const selectedProfileId = selectedProfilesBySession.get(sessionKey(context)) ?? null;
          const profiles = await listBrowserProfiles();
          const selectedProfile = selectedProfileId ? profiles.find((profile) => profile.profileId === selectedProfileId) ?? null : null;
          return stringify({ selectedProfileId, selectedProfile, profiles });
        },
      }),
      browser_select_profile: tool({
        description: "Select which connected browser profile subsequent browser tools should use.",
        args: {
          profileId: tool.schema.string().describe("Profile ID from browser_list_profiles"),
        },
        async execute(args, context) {
          const profile = await resolveBrowserProfile(args.profileId);
          selectedProfilesBySession.set(sessionKey(context), profile.profileId);
          markProfileUsed(context, profile.profileId);
          clearSessionCache(context);
          return stringify({ selected: true, profileId: profile.profileId, profileLabel: profile.profileLabel ?? null, browserName: profile.browserName ?? null });
        },
      }),
      browser_name_profile: tool({
        description: "Set a local label for a connected browser profile, such as work or personal.",
        args: {
          profileId: tool.schema.string().optional().describe("Profile ID from browser_list_profiles. Defaults to the selected profile."),
          label: tool.schema.string().describe("Short local label for this browser profile."),
        },
        async execute(args, context) {
          const profileId = await resolveSessionProfileId(context, args.profileId ?? null);
          const result = await browserRequest("setProfileLabel", { profile_id: profileId, label: args.label }, { profileId });
          return stringify(result);
        },
      }),
      browser_capabilities: tool({
        description: "List capabilities advertised by the agent-browser extension.",
        args: {},
        async execute(_args, context) {
          return stringify(await extensionRequest(context, "getInfo"));
        },
      }),
      browser_list_tabs: tool({
        description: "List Chromium tabs available to OpenCode or all user tabs.",
        args: {
          scope: tool.schema.enum(["session", "user"]).default("user"),
        },
        async execute(args, context) {
          const method = args.scope === "session" ? "getTabs" : "getUserTabs";
          const { profileId, result } = await extensionProfileRequest(context, method);
          return stringify(addProfileToTabResult(result, profileId));
        },
      }),
      browser_selected_tab: tool({
        description: "Return the current logical tab selected for this browser session.",
        args: {},
        async execute(_args, context) {
          const { profileId, result } = await extensionProfileRequest(context, "getSelectedTab");
          return stringify(result ? addProfileToTabResult(result, profileId) : null);
        },
      }),
      browser_get_tab: tool({
        description: "Get metadata for a controlled Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          const { profileId, result } = await extensionProfileRequest(context, "getTab", { tabId: args.tabId });
          return stringify(addProfileToTabResult(result, profileId));
        },
      }),
      browser_new_tab: tool({
        description: "Create a new Chromium tab controlled by OpenCode.",
        args: {},
        async execute(_args, context) {
          const { profileId, result } = await extensionProfileRequest(context, "createTab");
          return stringify(addProfileToTabResult(result, profileId));
        },
      }),
      browser_claim_tab: tool({
        description: "Claim an existing Chromium tab by tab ID so OpenCode can control it.",
        args: {
          tabId: tool.schema.number().int().positive().describe("Chrome tab ID to claim"),
        },
        async execute(args, context) {
          const { profileId, result } = await extensionProfileRequest(context, "claimUserTab", { tabId: args.tabId });
          return stringify(addProfileToTabResult(result, profileId));
        },
      }),
      browser_name_session: tool({
        description: "Name the current browser automation session and tab group.",
        args: {
          name: tool.schema.string(),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "nameSession", { name: args.name }));
        },
      }),
      browser_navigate: tool({
        description: "Navigate a controlled Chromium tab to a URL. Creates a tab when tabId is omitted.",
        args: {
          url: tool.schema.string().url().describe("Destination URL"),
          tabId: tool.schema.number().int().positive().optional().describe("Existing controlled tab ID"),
          waitUntil: tool.schema.enum(["none", "domcontentloaded", "load"]).default("domcontentloaded"),
          timeoutMs: tool.schema.number().int().positive().default(15000),
        },
async execute(args, context) {
          assertNavigationAllowed(args.url, context?.urlPolicy);

          const tab = args.tabId
            ? { id: args.tabId }
            : (await extensionProfileRequest(context, "createTab")).result;
          const profileId = await resolveSessionProfileId(context);
          await activate(context, tab.id);
          if (args.url.toLowerCase().startsWith("data:")) {
            const result = await navigateDataUrl(context, tab.id, args.url);
            const readiness = await waitForPageReady(context, tab.id, args.waitUntil, args.timeoutMs);
            return stringify({ ...result, profileId, readiness });
          }
          await enableCdpDomains(context, tab.id, ["Page"], { optional: true });
          await cdp(context, tab.id, "Page.navigate", { url: args.url }, args.timeoutMs);
          const readiness = await waitForPageReady(context, tab.id, args.waitUntil, args.timeoutMs);
          return stringify({ profileId, tabId: tab.id, url: args.url, readiness });
        },
      }),
      browser_reload: tool({
        description: "Reload a controlled Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          bypassCache: tool.schema.boolean().default(false),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "reloadTab", { tabId: args.tabId, bypassCache: args.bypassCache }));
        },
      }),
      browser_back: tool({
        description: "Navigate a controlled Chromium tab back in its history.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          return stringify(await navigateHistory(context, args.tabId, -1));
        },
      }),
      browser_forward: tool({
        description: "Navigate a controlled Chromium tab forward in its history.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          return stringify(await navigateHistory(context, args.tabId, 1));
        },
      }),
      browser_close_tab: tool({
        description: "Close a controlled Chromium tab and remove it from the session.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          const result = await extensionRequest(context, "closeTab", { tabId: args.tabId });
          clearTabCache(context, args.tabId);
          return stringify(result);
        },
      }),
      browser_history: tool({
        description: "Search recent browser history through the extension history API.",
        args: {
          query: tool.schema.string().default(""),
          limit: tool.schema.number().int().positive().default(25),
          from: tool.schema.string().optional(),
          to: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "getUserHistory", args));
        },
      }),
      browser_screenshot: tool({
        description: "Capture a screenshot from a Chromium tab via CDP. fullPage:false captures the visible viewport; fullPage:true captures the entire scrollable page. The payload is sized for direct visual inspection.",
        args: {
          tabId: tool.schema.number().int().positive(),
          fullPage: tool.schema.boolean().default(false).describe("false (default) captures the visible viewport; true captures the full scrollable page height."),
          format: tool.schema.enum(["png", "jpeg", "webp"]).default("png").describe("Capture format. jpeg and webp are significantly smaller than png."),
          quality: tool.schema.number().int().min(0).max(100).optional().describe("Compression quality for jpeg and webp. Ignored for png."),
          allowFormatFallback: tool.schema.boolean().default(true),
          clip: tool.schema.object({
            x: tool.schema.number(),
            y: tool.schema.number(),
            width: tool.schema.number(),
            height: tool.schema.number(),
            scale: tool.schema.number().optional(),
          }).optional(),
          timeoutMs: tool.schema.number().int().positive().default(30000),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await enableCdpDomains(context, args.tabId, ["Page"], { optional: true });
          const params: CdpParams<"Page.captureScreenshot"> = { format: args.format, optimizeForSpeed: true };
          if (args.format !== "png" && args.quality !== undefined) params.quality = args.quality;
          if (args.clip) params.clip = { ...args.clip, scale: args.clip.scale ?? 1 };
          let capture: { fullPage: boolean; width?: number; height?: number; scale?: number; formatApplied?: string } = { fullPage: args.fullPage };
          if (args.fullPage) {
            const metrics = await cdp(context, args.tabId, "Page.getLayoutMetrics", {}, args.timeoutMs);
            const size = metrics?.contentSize ?? metrics?.cssContentSize;
            if (!size || !(size.width > 0) || !(size.height > 0)) {
              throw new Error("The page did not report layout metrics, so the full-page height is unknown. Retry with fullPage:false to capture the visible viewport.");
            }
            const width = Math.ceil(size.width);
            const height = Math.ceil(size.height);
            const scale = Math.min(1, MAX_CAPTURE_DIMENSION / Math.max(width, height));
            capture = { fullPage: true, width, height, scale };
            params.captureBeyondViewport = true;
            params.clip = { x: 0, y: 0, width, height, scale };
          }
          let result = await cdp(context, args.tabId, "Page.captureScreenshot", params, args.timeoutMs);
          let mimeType = screenshotMime(args.format);
          if (result.data.length > MAX_CAPTURE_BASE64_CHARS && args.format !== "jpeg" && args.allowFormatFallback) {
            const reduced: CdpParams<"Page.captureScreenshot"> = { ...params, format: "jpeg", quality: Math.min(params.quality ?? 100, 75) };
            result = await cdp(context, args.tabId, "Page.captureScreenshot", reduced, args.timeoutMs);
            mimeType = "image/jpeg";
            capture.formatApplied = "jpeg";
          }
          return stringify({
            mimeType,
            base64: result.data,
            ...capture,
            bytes: Math.floor(result.data.length * 0.75),
          });
        },
      }),
      browser_move: tool({
        description: "Move the visible OpenCode cursor overlay in a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          x: tool.schema.number(),
          y: tool.schema.number(),
          waitForArrival: tool.schema.boolean().default(false),
        },
        async execute(args, context) {
          finiteNumber(args.x, "x");
          finiteNumber(args.y, "y");
          const result = await moveCursor(context, args.tabId, args.x, args.y, { waitForArrival: args.waitForArrival, action: cursorActionForTool("browser_move") ?? undefined });
          return stringify({ moved: true, visibleCursor: result !== null, tabId: args.tabId, x: args.x, y: args.y, result });
        },
      }),
      browser_click: tool({
        description: "Click Chromium tab viewport coordinates.",
        args: {
          tabId: tool.schema.number().int().positive(),
          x: tool.schema.number(),
          y: tool.schema.number(),
          button: tool.schema.enum(["left", "middle", "right"]).default("left"),
        },
        async execute(args, context) {
          await pointCursor(context, args.tabId, args, "click");
          await clickPoint(context, args.tabId, args.x, args.y, args.button);
          return stringify({ clicked: true, tabId: args.tabId, x: args.x, y: args.y });
        },
      }),
      browser_double_click: tool({
        description: "Double-click Chromium tab viewport coordinates.",
        args: {
          tabId: tool.schema.number().int().positive(),
          x: tool.schema.number(),
          y: tool.schema.number(),
          button: tool.schema.enum(["left", "middle", "right"]).default("left"),
        },
        async execute(args, context) {
          finiteNumber(args.x, "x");
          finiteNumber(args.y, "y");
          const point = await resolveCursorPoint(context, args.tabId, args);
          if (point) await pointCursor(context, args.tabId, point, "click");
          await activate(context, args.tabId);
          await pageBackend.click(context, args.tabId, trusted => clickAtPointExpression(args.x, args.y, { button: args.button, clickCount: 2, trusted }), { button: args.button, clickCount: 2 });
          return stringify({ doubleClicked: true, tabId: args.tabId, x: args.x, y: args.y });
        },
      }),
      browser_hover: tool({
        description: "Hover the pointer over a DOM node, CSS selector, or viewport coordinates in a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          nodeId: tool.schema.string().optional().describe("DOM node ID from browser_page_search or browser_dom_snapshot."),
          selector: tool.schema.string().optional().describe("CSS selector to hover."),
          x: tool.schema.number().optional().describe("Viewport x coordinate when not using a nodeId or selector."),
          y: tool.schema.number().optional().describe("Viewport y coordinate when not using a nodeId or selector."),
        },
        async execute(args, context) {
          let point;
          if (args.nodeId) {
            point = await runtimeEvaluate(context, args.tabId, domNodeHoverTargetExpression(args.nodeId));
          } else if (args.selector) {
            point = await runtimeEvaluate(context, args.tabId, selectorHoverTargetExpression(args.selector));
          } else {
            point = { x: args.x, y: args.y };
            finiteNumber(point.x, "x");
            finiteNumber(point.y, "y");
          }
          await pointCursor(context, args.tabId, point, "observe");
          await hoverPoint(context, args.tabId, point.x, point.y);
          return stringify({ hovered: true, tabId: args.tabId, x: point.x, y: point.y, target: point });
        },
      }),
      browser_handle_dialog: tool({
        description: "Accept or dismiss the currently showing JavaScript dialog on a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          value: tool.schema.enum(["accept", "dismiss"]).default("accept"),
          promptText: tool.schema.string().max(2000).optional().describe("Text to provide when accepting a prompt dialog."),
        },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["Page"], { optional: true });
          const result = await cdp(context, args.tabId, "Page.handleJavaScriptDialog", {
            accept: args.value === "accept",
            ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
          }, 5000);
          return stringify({
            handled: true,
            tabId: args.tabId,
            value: args.value,
            ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
            result,
          });
        },
      }),
      browser_scroll: tool({
        description: "Scroll a Chromium tab from a viewport coordinate.",
        args: {
          tabId: tool.schema.number().int().positive(),
          x: tool.schema.number().optional().describe("Viewport x coordinate. Defaults to the viewport center."),
          y: tool.schema.number().optional().describe("Viewport y coordinate. Defaults to the viewport center."),
          scrollX: tool.schema.number().default(0),
          scrollY: tool.schema.number().default(0),
        },
        async execute(args, context) {
          return stringify(await scrollTab(context, args.tabId, args));
        },
      }),
      browser_drag: tool({
        description: "Drag in a Chromium tab along a path of viewport coordinates.",
        args: {
          tabId: tool.schema.number().int().positive(),
          path: tool.schema.array(tool.schema.object({ x: tool.schema.number(), y: tool.schema.number() })),
          button: tool.schema.enum(["left", "middle", "right"]).default("left"),
        },
        async execute(args, context) {
          if (args.path.length < 2) throw new Error("browser_drag requires at least two path points");
          for (const [index, point] of args.path.entries()) {
            finiteNumber(point.x, `path[${index}].x`);
            finiteNumber(point.y, `path[${index}].y`);
          }
          await pointCursor(context, args.tabId, args.path[0], "drag");
          await activate(context, args.tabId);
          const points = interpolatePath(args.path);
          const [start, ...rest] = points;
          if (!start) throw new Error("Drag path is empty");
          const steps = [
            mouseStep({ type: "mouseMoved", x: start.x, y: start.y, button: args.button, buttons: 0, pointerType: "mouse" }, start),
            mouseStep({ type: "mousePressed", x: start.x, y: start.y, button: args.button, buttons: mouseButtons(args.button), clickCount: 1, pointerType: "mouse" }, start, 24),
          ];
          for (const point of rest) {
            steps.push(mouseStep({ type: "mouseMoved", x: point.x, y: point.y, button: args.button, buttons: mouseButtons(args.button), pointerType: "mouse" }, point, 8));
          }
          const end = points.at(-1);
          if (!end) throw new Error("Drag path is empty");
          steps.push(mouseStep({ type: "mouseReleased", x: end.x, y: end.y, button: args.button, buttons: 0, clickCount: 1, pointerType: "mouse" }, end, 16));
          const timeoutMs = Math.min(180000, Math.max(30000, steps.length * 500 + 15000));
          await inputGesture(context, args.tabId, steps, timeoutMs);
          return stringify({ dragged: true, tabId: args.tabId, points: args.path.length, dispatchedPoints: points.length });
        },
      }),
      browser_type: tool({
        description: "Type text into the currently focused element in a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          text: tool.schema.string(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await pointCursor(context, args.tabId, await runtimeEvaluate(context, args.tabId, focusedEditableTargetExpression()).catch(() => null), "text");
          const before = await runtimeEvaluate(context, args.tabId, focusedEditableSnapshotExpression());
          const after = await insertTextAndVerify(context, args.tabId, before, args.text);
          return stringify({ typed: true, tabId: args.tabId, length: args.text.length, kind: after.kind, valueLength: after.value.length });
        },
      }),
      browser_keypress: tool({
        description: "Dispatch a key press or common key chord in a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          key: tool.schema.string().describe("Key value or chord, such as Enter, Tab, Escape, Control+A, Shift+Tab, or a single character"),
        },
        async execute(args, context) {
          return stringify(await pressKey(context, args.tabId, args.key));
        },
      }),
      browser_snapshot: tool({
        description: "Get a Chromium accessibility tree snapshot for a tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["Accessibility"], { optional: true });
          const result = await cdp(context, args.tabId, "Accessibility.getFullAXTree", {});
          return stringify(result);
        },
      }),
      browser_dom_snapshot: tool({
        description: "Return visible interactable DOM nodes with stable node IDs for DOM CUA actions.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          return stringify(await runtimeEvaluate(context, args.tabId, domSnapshotExpression()));
        },
      }),
      browser_page_search: tool({
        description: "Search the current page with local semantic retrieval (auto by default) and return only relevant actionable page units.",
        args: {
          tabId: tool.schema.number().int().positive(),
          query: tool.schema.string().describe("What to find on the page, such as 'checkout button' or 'repository danger zone'."),
          maxResults: tool.schema.number().int().positive().default(5),
          maxUnits: tool.schema.number().int().positive().default(700).describe("Maximum page units to extract before ranking."),
          embeddingCandidates: tool.schema.number().int().positive().default(120).describe("Maximum extracted units to embed before reranking."),
          rerankCandidates: tool.schema.number().int().positive().default(8).describe("Top embedding candidates to rerank with the local reranker."),
          detail: tool.schema.enum(["lean", "compact", "full", "debug"]).default("lean"),
          scope: tool.schema.enum(["auto", "page", "viewport", "focused"]).default("auto").describe("Search the whole page, viewport, or focused surface such as a dialog. Auto prefers focused surfaces."),
          selector: tool.schema.string().optional().describe("Restrict search to a CSS selector root."),
          containerNodeId: tool.schema.string().optional().describe("Restrict search to a node ID from browser_page_search, browser_visual_map, or browser_dom_snapshot."),
          clip: tool.schema.object({
            x: tool.schema.number(),
            y: tool.schema.number(),
            width: tool.schema.number(),
            height: tool.schema.number(),
          }).optional().describe("Restrict candidates to a viewport clip rectangle."),
          mode: tool.schema.enum(["auto", "semantic", "lexical", "deep", "snowflake", "hybrid"]).default("auto").describe("Retrieval strategy. Auto = lexical first, escalating to the active semantic model. Semantic = always the active adaptive embedding model (snowflake is a deprecated alias). Deep = Qwen embedding + reranker."),
          timeoutMs: tool.schema.number().int().positive().default(120000),
        },
        async execute(args, context) {
          const profileId = await resolveSessionProfileId(context);
          markProfileUsed(context, profileId);
          const strategy = args.mode === "hybrid" ? "deep" : args.mode === "snowflake" ? "semantic" : args.mode;
          const timeoutMs = Math.max(250, Math.min(args.timeoutMs, ["deep", "semantic"].includes(strategy) ? 120000 : 10000));
          const maxResults = Math.max(1, Math.min(args.maxResults, 100));
          const maxUnits = Math.max(1, Math.min(args.maxUnits, 1000));
          const embeddingCandidates = Math.max(1, Math.min(args.embeddingCandidates, strategy === "deep" ? 120 : 48));
          const page = await runtimeEvaluate(context, args.tabId, pageSearchUnitsExpression({
            maxUnits,
            scope: args.scope,
            selector: args.selector,
            containerNodeId: args.containerNodeId,
            clip: args.clip,
          }), {
            timeoutMs: Math.min(timeoutMs, 30000),
            runtimeTimeoutMs: 5000,
          });
          const ranking = await browserRequest("semantic.rankPageUnits", sessionParams(context, {
            profile_id: profileId,
            tabId: args.tabId,
            pageUrl: page.url,
            decisionState: page.decisionState,
            query: args.query,
            units: page.units,
            maxResults,
            mode: strategy,
            embeddingCandidates,
            rerankCandidates: args.rerankCandidates,
            pageFingerprint: `${page.decisionState}|${page.title}|${page.units.length}`,
          }), { profileId, timeoutMs });
          return stringify(shapePageSearchRanking({
            url: page.url,
            title: page.title,
            query: args.query,
            scope: page.scope,
            totalCandidates: page.totalCandidates,
            truncated: page.truncated,
            ...record(ranking),
          }, args.detail));
        },
      }),
      browser_visual_map: tool({
        description: "Return lean visual UI boxes for visible controls and containers without screenshot payloads.",
        args: {
          tabId: tool.schema.number().int().positive(),
          query: tool.schema.string().optional().describe("Optional target such as 'save button' or 'settings dialog'. Matching only affects ordering."),
          scope: tool.schema.enum(["auto", "page", "viewport", "focused"]).default("auto").describe("Map the whole page, viewport, or focused surface such as a dialog. Auto prefers focused surfaces."),
          selector: tool.schema.string().optional().describe("Restrict mapping to a CSS selector root."),
          nodeId: tool.schema.string().optional().describe("Restrict mapping to a node ID from a previous browser_page_search, browser_visual_map, or browser_dom_snapshot call."),
          clip: tool.schema.object({
            x: tool.schema.number(),
            y: tool.schema.number(),
            width: tool.schema.number(),
            height: tool.schema.number(),
          }).optional().describe("Restrict mapping to a viewport clip rectangle."),
          maxResults: tool.schema.number().int().positive().default(80),
          detail: tool.schema.enum(["lean", "debug"]).default("lean"),
          vision: tool.schema.enum(["auto", "off", "force"]).default("auto").describe("Optional local screenshot detector. Auto only runs when DOM mapping finds no elements."),
          labels: tool.schema.array(tool.schema.string()).optional().describe("Candidate labels for the optional screenshot detector."),
          timeoutMs: tool.schema.number().int().positive().default(120000),
        },
        async execute(args, context) {
          const profileId = await resolveSessionProfileId(context);
          markProfileUsed(context, profileId);
          let map = await runtimeEvaluate(context, args.tabId, visualMapExpression(args), {
            timeoutMs: 30000,
            runtimeTimeoutMs: 5000,
          });
          if (shouldRunVisualModel(args, map)) {
            try {
              const screenshot = await captureVisualMapScreenshot(context, args.tabId, args, map);
              const visual = await browserRequest("visual.mapScreenshot", sessionParams(context, {
                profile_id: profileId,
                imageBase64: screenshot.base64,
                mimeType: "image/png",
                query: args.query ?? null,
                labels: args.labels,
                maxResults: args.maxResults,
                force: args.vision === "force",
              }), { profileId, timeoutMs: args.timeoutMs });
              map = mergeVisualMapModelResult(map, visual, screenshot.origin, args.detail);
            } catch (error) {
              if (args.detail === "debug") {
                map = {
                  ...map,
                  visualModel: {
                    used: false,
                    error: error instanceof Error ? error.message : String(error),
                  },
                };
              }
            }
          }
          return stringify(map);
        },
      }),
      browser_page_inspect: tool({
        description: "Return focused zoom-in DOM context for a page-search node ID or CSS selector.",
        args: {
          tabId: tool.schema.number().int().positive(),
          nodeId: tool.schema.string().optional().describe("Node ID from browser_page_search or browser_dom_snapshot."),
selector: tool.schema.string().optional().describe("CSS selector to inspect when nodeId is not available."),
          depth: tool.schema.number().int().min(0).default(2),
          maxChildren: tool.schema.number().int().positive().default(30),
          maxText: tool.schema.number().int().positive().default(400),
          detail: tool.schema.enum(["lean", "compact", "full", "debug"]).default("lean").describe("Includes verbose target html and styles only with debug."),
        },
        async execute(args, context) {
          const profileId = await resolveSessionProfileId(context);
          markProfileUsed(context, profileId);
          const inspectArgs = { ...args, selector: args.selector ?? (!args.nodeId ? 'dialog[open], [role="dialog"], body' : undefined) };
          return stringify(await runtimeEvaluate(context, args.tabId, pageInspectExpression(inspectArgs), {
            timeoutMs: 30000,
            runtimeTimeoutMs: 5000,
          }));
        },
      }),
      browser_dom_click: tool({
        description: "Click a DOM node ID returned by browser_dom_snapshot.",
        args: {
          tabId: tool.schema.number().int().positive(),
          nodeId: tool.schema.string(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await pointCursor(context, args.tabId, await resolveCursorPoint(context, args.tabId, { nodeId: args.nodeId }), "click");
          const target = await pageBackend.click(context, args.tabId, trusted => domNodeClickExpression(args.nodeId, { trusted }));
          return stringify({ clicked: true, tabId: args.tabId, nodeId: args.nodeId, target });
        },
      }),
      browser_dom_type: tool({
        description: "Focus, append to, or replace text in a DOM node returned by browser_dom_snapshot.",
        args: {
          tabId: tool.schema.number().int().positive(),
          nodeId: tool.schema.string(),
          text: tool.schema.string(),
          mode: tool.schema.enum(["append", "replace", "focus"]).default("append"),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await pointCursor(context, args.tabId, await resolveCursorPoint(context, args.tabId, { nodeId: args.nodeId }), "text");
          const before = await runtimeEvaluate(context, args.tabId, domNodeEditableExpression(args.nodeId, {
            selectAll: args.mode === "replace",
            cursorAtEnd: args.mode === "append",
            includeSelect: args.mode === "replace",
          }));
          if (args.mode === "focus") return stringify({ focused: true, tabId: args.tabId, nodeId: args.nodeId, kind: before.kind, valueLength: before.value.length, valueHash: before.valueHash });
          if (args.mode === "replace") return stringify(await fillFocusedEditable(context, args.tabId, before, args.text));
          const after = await insertTextAndVerify(context, args.tabId, before, args.text);
          return stringify({ typed: true, tabId: args.tabId, nodeId: args.nodeId, length: args.text.length, kind: after.kind, valueLength: after.value.length, valueHash: after.valueHash });
        },
      }),
      browser_locator_count: tool({
        description: "Count elements matching a CSS selector in a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string(),
        },
        async execute(args, context) {
          const count = await runtimeEvaluate(context, args.tabId, `(() => { const selector = ${JSON.stringify(args.selector)}; try { return document.querySelectorAll(selector).length; } catch (error) { throw new Error('Invalid selector: ' + selector + ': ' + error.message); } })()`);
          return stringify({ count });
        },
      }),
      browser_locator_click: tool({
        description: "Click the first element matching a CSS selector in a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await pointCursor(context, args.tabId, await resolveCursorPoint(context, args.tabId, { selector: args.selector }), "click");
          const target = await pageBackend.click(context, args.tabId, trusted => selectorClickExpression(args.selector, { trusted }));
          return stringify({ clicked: true, tabId: args.tabId, selector: args.selector, target });
        },
      }),
      browser_locator_fill: tool({
        description: "Focus, append to, or replace the first editable element matching a CSS selector.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string(),
          value: tool.schema.string(),
          mode: tool.schema.enum(["append", "replace", "focus"]).default("replace"),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await pointCursor(context, args.tabId, await resolveCursorPoint(context, args.tabId, { selector: args.selector }), "text");
          const before = await runtimeEvaluate(context, args.tabId, selectorEditableExpression(args.selector, {
            selectAll: args.mode === "replace",
            cursorAtEnd: args.mode === "append",
            includeSelect: args.mode === "replace",
          }));
          if (args.mode === "focus") return stringify({ focused: true, tabId: args.tabId, selector: args.selector, kind: before.kind, valueLength: before.value.length, valueHash: before.valueHash });
          if (args.mode === "replace") return stringify(await fillFocusedEditable(context, args.tabId, before, args.value));
          const after = await insertTextAndVerify(context, args.tabId, before, args.value);
          return stringify({ typed: true, tabId: args.tabId, selector: args.selector, length: args.value.length, kind: after.kind, valueLength: after.value.length, valueHash: after.valueHash });
        },
      }),
      browser_locator_text: tool({
        description: "Read text from the first element matching a CSS selector in a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string(),
        },
        async execute(args, context) {
          return stringify({ text: await runtimeEvaluate(context, args.tabId, selectorTextExpression(args.selector)) });
        },
      }),
      browser_set_file_input: createFileInputOperation({ tool, cdp, enableCdpDomains, stringify }),
      browser_clipboard_read_text: tool({
        description: "Read plain text from the browser clipboard in a controlled tab context.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await grantClipboardPermission(context, args.tabId);
          const text = await runtimeEvaluate(context, args.tabId, "navigator.clipboard.readText()", { timeoutMs: 5000 });
          return stringify({ text });
        },
      }),
      browser_clipboard_write_text: tool({
        description: "Write plain text to the browser clipboard in a controlled tab context.",
        args: {
          tabId: tool.schema.number().int().positive(),
          text: tool.schema.string(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await grantClipboardPermission(context, args.tabId);
          await runtimeEvaluate(context, args.tabId, `navigator.clipboard.writeText(${JSON.stringify(args.text)})`, { timeoutMs: 5000 });
          return stringify({ written: true, length: args.text.length });
        },
      }),
      browser_enable_inspection: tool({
        description: "Enable CDP Runtime, Log, Network, Page, DOM, and Accessibility inspection domains for a tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await enableInspection(context, args.tabId);
          return stringify({ enabled: true, tabId: args.tabId });
        },
      }),

browser_console_logs: tool({
        description: "Read compact captured console and log events from a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          limit: tool.schema.number().int().positive().default(50),
          raw: tool.schema.boolean().default(false).describe("Return raw CDP payloads instead of compact grouped diagnostics."),
          includeStack: tool.schema.boolean().default(false).describe("Include full stack traces in compact output."),
          sourceMap: tool.schema.boolean().default(false).describe("Resolve source-mapped stack frames by fetching maps through the page context."),
        },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["Runtime", "Log"], { optional: true });
          const response = await extensionRequest(context, "getCdpEvents", {
            tabId: args.tabId,
            limit: args.limit,
            methods: ["Runtime.consoleAPICalled", "Log.entryAdded"],
          });
          if (!args.sourceMap) return stringify(compactConsoleEvents(response, { raw: args.raw, includeStack: args.includeStack }));
          const resolver = new SourceMapResolver();
          await fetchConsoleSourceMaps(context, args.tabId, response?.events ?? [], resolver);
          return stringify(compactConsoleEvents(response, { raw: args.raw, includeStack: args.includeStack, sourceMapped: true, resolver }));
        },
      }),
      browser_dialog_events: tool({
        description: "Read captured JavaScript dialog lifecycle events from a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          limit: tool.schema.number().int().positive().default(50),
        },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["Page"], { optional: true });
          const response = await extensionRequest(context, "getCdpEvents", {
            tabId: args.tabId,
            limit: args.limit,
            methods: ["Page.javascriptDialogOpening", "Page.javascriptDialogClosed"],
          });
          return stringify(compactDialogEvents(response));
        },
      }),
      browser_network_events: tool({
        description: "Read captured Network.* CDP events from a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          limit: tool.schema.number().int().positive().default(100),
        },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["Network"], { optional: true });
          return stringify(await extensionRequest(context, "getCdpEvents", {
            tabId: args.tabId,
            limit: args.limit,
            methodPrefix: "Network.",
          }));
        },
      }),
      browser_clear_events: tool({
        description: "Clear captured CDP events for a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "clearCdpEvents", { tabId: args.tabId }));
        },
      }),
      browser_download_events: tool({
        description: "Read download lifecycle events attributed to this browser session, optionally limited to one controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive().optional(),
          limit: tool.schema.number().int().positive().default(100),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "getDownloadEvents", { tabId: args.tabId, limit: args.limit }));
        },
      }),
      browser_clear_download_events: tool({
        description: "Clear only this browser session's attributed download events, optionally limited to one controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive().optional(),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "clearDownloadEvents", { tabId: args.tabId }));
        },
      }),
      browser_cdp: tool({
        description: "Run a raw Chrome DevTools Protocol command against a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          method: tool.schema.string().describe("CDP method, for example Runtime.evaluate"),
          params: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional().describe("CDP command parameters as an object."),
          paramsJson: tool.schema.string().optional().describe("CDP command parameters as a JSON object string. Use this if arbitrary object params are not exposed by the client."),
          timeoutMs: tool.schema.number().int().positive().optional(),
        },
        async execute(args, context) {
          if ((await extensionRequest(context, "getInfo")).engine === "gecko") throw new Error("unsupported_capability: raw CDP is Chromium-only");
          await ensureAttached(context, args.tabId, await resolveSessionProfileId(context));
          return stringify(await executeCdpRequest(context, args.tabId, args.method, cdpParamsFromArgs(args), args.timeoutMs));
        },
      }),
      browser_turn_end: tool({
        description: "End the current browser turn by detaching debuggers and hiding cursors without closing tabs.",
        args: {},
        async execute(_args, context) {
          const results: Record<string, unknown> = {};
          for (const profileId of await targetProfileIdsForSession(context)) {
            results[profileId] = await browserRequest("turnEnded", sessionParams(context, { profile_id: profileId }), { profileId });
            clearSessionCache(context, profileId);
          }
          return stringify({ profiles: results });
        },
      }),
      browser_trace_record: tool({
        description: "Record a CDP performance trace for a controlled tab and return computed insights.",
        args: {
          tabId: tool.schema.number().int().positive(),
          reload: tool.schema.boolean().default(true).describe("Reload the tab so the trace covers a cold navigation."),
          waitUntil: tool.schema.enum(["none", "domcontentloaded", "load"]).default("load"),
          durationMs: tool.schema.number().int().positive().max(30000).optional().describe("Capture duration in milliseconds when reload is false."),
          timeoutMs: tool.schema.number().int().positive().default(60000),
        },
        async execute(args, context) {
          const profileId = await resolveSessionProfileId(context);
          markProfileUsed(context, profileId);
          const tabId = args.tabId;
          await extensionRequest(context, "trace.begin", { tabId });
          try {
            await cdp(context, tabId, "Tracing.start", {
              traceConfig: {
                recordMode: "recordContinuously",

                includedCategories: ["devtools.timeline", "loading", "navigation", "blink.user_timing", "performance", "blink.console"],
              },
            }, args.timeoutMs);
            if (args.reload) {
              await extensionRequest(context, "reloadTab", { tabId, bypassCache: false });
              await waitForPageReady(context, tabId, args.waitUntil, args.timeoutMs);
            } else {
              await sleep(Math.min(args.durationMs ?? 3000, 30000));
            }
            await cdp(context, tabId, "Tracing.end", {}, args.timeoutMs);
            let collected = null;
            const deadline = Date.now() + args.timeoutMs;
            while (Date.now() < deadline) {
              collected = await extensionRequest(context, "trace.collect", { tabId, clear: false });
              if (collected.complete) break;
              await sleep(150);
            }
            if (!collected?.complete) {
              const error = Object.assign(new Error("Performance trace did not complete in time"), { code: "TRACE_TIMEOUT", retryable: true });
              throw error;
            }
            const traceJson = `[${collected.chunks.join(",")}]`;
            const analysis = await browserRequest(
              "diagnostics.traceAnalyze",
              { trace: traceJson },
              { profileId, timeoutMs: Math.max(args.timeoutMs, 30000) },
            );
            return stringify({
              recorded: true,
              tabId,
              trace: traceJson,
              traceEventCount: collected.eventCount,
              chunkCount: collected.chunkCount,
              overflowed: collected.overflowed === true,
              ...record(analysis),
            });
          } finally {
            await extensionRequest(context, "trace.clear", { tabId }).catch(() => {});
          }
        },
      }),
      browser_trace_analyze: tool({
        description: "Analyze an existing performance trace JSON document into summary and insights.",
        args: {
          trace: tool.schema.string().describe("Concatenated Chrome tracing event JSON array."),
          url: tool.schema.string().optional(),
          insight: tool.schema.string().max(120).optional().describe("Filter results to a single insight id."),
          timeoutMs: tool.schema.number().int().positive().default(30000),
        },
        async execute(args, context) {
          const profileId = await resolveSessionProfileId(context);
          markProfileUsed(context, profileId);
          const analysis = await browserRequest(
            "diagnostics.traceAnalyze",
            { trace: args.trace, url: args.url, insight: args.insight },
            { profileId, timeoutMs: args.timeoutMs },
          );
          return stringify(analysis);
        },
      }),
      browser_configure: tool({
        description: "Apply persistent emulation, network, and initialization overrides to a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          environment: tool.schema.object({
            reset: tool.schema.boolean().optional().describe("Clear all applied overrides instead of applying new ones."),
            viewport: tool.schema.object({
              width: tool.schema.number().int().positive(),
              height: tool.schema.number().int().positive(),
              deviceScaleFactor: tool.schema.number().min(0).optional(),
              mobile: tool.schema.boolean().optional(),
              touch: tool.schema.boolean().optional(),
            }).optional(),
            network: tool.schema.union([
              tool.schema.enum(["offline", "slow-2g", "slow-3g", "fast-3g", "slow-4g", "online"]),
              tool.schema.object({
                offline: tool.schema.boolean().optional(),
                latency: tool.schema.number().min(0).optional(),
                downloadThroughput: tool.schema.number().optional(),
                uploadThroughput: tool.schema.number().optional(),
              }),
            ]).optional(),
            cpuThrottling: tool.schema.number().min(1).optional(),
            colorScheme: tool.schema.enum(["light", "dark", "no-preference"]).optional(),
            geolocation: tool.schema.object({
              latitude: tool.schema.number(),
              longitude: tool.schema.number(),
              accuracy: tool.schema.number().min(0).optional(),
            }).optional(),
            userAgent: tool.schema.string().max(500).optional(),
            headers: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
            initScripts: tool.schema.array(tool.schema.string().max(20000)).max(50).optional(),
          }),
        },
        async execute(args, context) {
          const environment = args.environment ?? {};
          await extensionRequest(context, "getTab", { tabId: args.tabId });
          if (environment.reset === true) await resetEnvironment(context, args.tabId);
          else await applyEnvironment(context, args.tabId, environment);
          return stringify({ configured: true, tabId: args.tabId, reset: environment.reset === true });
        },
      }),

browser_finalize: tool({
        description: "End the session: keep tabs as \"deliverable\" (user-facing output, moved to the blue OpenCode Deliverables group) or \"handoff\" (work continues later, stays in the session's green group); default is handoff. Close agent-created tabs unless kept; release unkept user-claimed tabs without closing them.",
        args: {
          keep: tool.schema.array(
            tool.schema.union([
              tool.schema.number().int().positive(),
              tool.schema.object({
                tabId: tool.schema.number().int().positive(),
                status: tool.schema.enum(["handoff", "deliverable"]).default("handoff"),
                profileId: tool.schema.string().optional(),
              }),
            ]),
          ).default([]),
        },
        async execute(args, context) {
          const profileIds = await targetProfileIdsForSession(context);
          const keep: { tabId: number; status: "handoff" | "deliverable"; profileId?: string }[] = args.keep.map((item) => (typeof item === "number" ? { tabId: item, status: "handoff" as const } : item));
          if (profileIds.length > 1 && keep.some((item) => !item.profileId)) {
            throw new Error("browser_finalize keep items must include profileId when multiple browser profiles were used");
          }

          const results: Record<string, unknown> = {};
          for (const profileId of profileIds) {
            const profileKeep = keep
              .filter((item) => !item.profileId || item.profileId === profileId)
              .map(({ tabId, status }) => ({ tabId, status }));
            results[profileId] = await browserRequest("finalizeTabs", sessionParams(context, { profile_id: profileId, keep: profileKeep }), { profileId });
            clearSessionCache(context, profileId);
          }
          environmentController.forgetSession(`${sessionKey(context)}:`);
          usedProfilesBySession.delete(sessionKey(context));
          return stringify({ profiles: results });
        },
      }),
  };
  Object.defineProperty(tools, "browser_network_inspect", {
    value: networkInspectOperation,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  for (const [name, definition] of Object.entries(createDiscoveryOperations({ command: cdp, evaluate: runtimeEvaluate, getTab: (context: BrowserContext, tabId) => extensionRequest(context, "getTab", { tabId }) }))) {
    Object.defineProperty(tools, name, { value: definition });
  }
  return { tool: tools };
};

export const createBrowserToolAdapter = createBrowserOperations;

export const GRANULAR_OPERATION_NAMES = Object.freeze([
  "browser_status", "browser_list_profiles", "browser_selected_profile", "browser_select_profile",
  "browser_name_profile", "browser_capabilities", "browser_list_tabs", "browser_selected_tab",
  "browser_get_tab", "browser_new_tab", "browser_claim_tab", "browser_name_session",
  "browser_navigate", "browser_reload", "browser_back", "browser_forward", "browser_close_tab",
"browser_history", "browser_screenshot", "browser_move", "browser_click", "browser_double_click",
  "browser_hover", "browser_handle_dialog", "browser_scroll", "browser_drag", "browser_type", "browser_keypress", "browser_snapshot",
  "browser_dom_snapshot", "browser_page_search", "browser_visual_map", "browser_page_inspect",
  "browser_dom_click", "browser_dom_type", "browser_locator_count", "browser_locator_click",
  "browser_locator_fill", "browser_locator_text", "browser_set_file_input", "browser_clipboard_read_text",
"browser_clipboard_write_text", "browser_enable_inspection", "browser_console_logs",
  "browser_dialog_events", "browser_network_events", "browser_clear_events", "browser_download_events",
"browser_clear_download_events", "browser_cdp", "browser_turn_end", "browser_trace_record", "browser_trace_analyze", "browser_configure", "browser_finalize",
]);

export const GRANULAR_OPERATION_COUNT = GRANULAR_OPERATION_NAMES.length;
