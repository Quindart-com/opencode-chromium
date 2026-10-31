import { Buffer } from "node:buffer";
import { z } from "zod";
import { NETWORK_INSPECT_ARGS } from "../../core/network-capability.ts";
import { candidateSchema } from "../../core/operation-results.ts";
import type { Environment } from "../../core/registry.ts";
import type { BrowserContext } from "../../core/tool-definition.ts";
import type { CdpParams } from "../../shared/cdp.ts";
import { SourceMapResolver } from "../../shared/source-maps.ts";
import { record,requiredRecord } from "../../shared/values.ts";
import { createDiscoveryOperations } from "../discovery.ts";
import { createEnvironmentController } from "../environment.ts";
import { type BrowserEvent } from "../events.ts";
import { inspectNetworkEvents } from "../network.ts";
import { defineBrowserOperation } from "../operation-definition.ts";
import { createPageBackend } from "../page-backend.ts";
export { keyDispatchEvents,parseKeyPress } from "../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from './inspection-expressions.ts';
export { pageSearchUnitsExpression } from './snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.
import { createInteractionRuntime } from "./interaction-runtime.ts";
import { createConfigurationOperations } from "./operation-groups/configuration.ts";
import { createEventOperations } from "./operation-groups/events.ts";
import { createInputOperations } from "./operation-groups/input.ts";
import { createInspectionOperations } from "./operation-groups/inspection.ts";
import { createSessionOperations } from "./operation-groups/session.ts";
import { createOperationSessionRuntime } from "./session-runtime.ts";
const tool = Object.assign(defineBrowserOperation, { schema: z });
type SearchResult = z.infer<typeof candidateSchema>;

const operationSession = createOperationSessionRuntime();
const { selectedProfilesBySession, usedProfilesBySession, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_BASE64_CHARS, screenshotMime, contextValue, sessionKey, sessionParams, explicitProfileId, markProfileUsed, resolveSessionProfileId, profileSessionParams, targetProfileIdsForSession, parseExtensionResult, extensionProfileRequest, extensionRequest, addProfileToTabResult, attachedTabKeys, enabledDomainsByTabKey, tabCacheKey, clearTabCache, clearSessionCache, cdpRequestOptions, ensureAttached, isDebuggerDetachedError, executeCdpRequest, cdp, enableCdpDomains, activate, moveCursor, pointCursor, resolveCursorPoint, inputGesture, enableInspection, mouseButtons, stringify, compactConsoleValue, consoleEventText, consoleEventLevel, consoleEventUrl, compactDialogEvents, runtimeEvaluate } = operationSession;
export const compactConsoleEvents = operationSession.compactConsoleEvents;
function pageSearchLabel(result: SearchResult) {
  return compactConsoleValue(result.name || result.text || result.selector || result.kind).slice(0, 220) || null;
}
function leanPageSearchResult(result: SearchResult) {
  const shaped: { node_id: string | number | null; kind: string | null; label: string | null; role: string | null; interactive: boolean; selector?: string | null; frameId?: string } = {
    node_id: result.node_id ?? null,
    ...(typeof result.frameId === "string" ? { frameId: result.frameId } : {}),
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
    scope: ranking.scope ?? null, observation: ranking.observation,
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

const interactionRuntime = createInteractionRuntime({ cdp, runtimeEvaluate, pointCursor, moveCursor, inputGesture, stringify, activate, extensionRequest, finiteNumber, pageBackend });
const { domNodeClickTargetExpression, backgroundClickExpression, domNodeClickExpression, domNodeHoverTargetExpression, domNodeEditableExpression, selectorClickTargetExpression, selectorClickExpression, clickAtPointExpression, hoverAtPointExpression, selectorHoverTargetExpression, selectorEditableExpression, selectorTextExpression, focusedEditableSnapshotExpression, focusedEditableTargetExpression, verifyFocusedEditableExpression, setFocusedSelectValueExpression, clickPoint, hoverPoint, insertTextAndVerify, fillFocusedEditable, pressKey, sleep, scrollPoint, scrollSnapshotExpression, scrollFallbackExpression, didScroll, scrollTab } = interactionRuntime;
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
  const dependencies = { selectedProfilesBySession, usedProfilesBySession, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_BASE64_CHARS, screenshotMime, contextValue, sessionKey, sessionParams, explicitProfileId, markProfileUsed, resolveSessionProfileId, profileSessionParams, targetProfileIdsForSession, parseExtensionResult, extensionProfileRequest, extensionRequest, addProfileToTabResult, attachedTabKeys, enabledDomainsByTabKey, tabCacheKey, clearTabCache, clearSessionCache, cdpRequestOptions, ensureAttached, isDebuggerDetachedError, executeCdpRequest, cdp, enableCdpDomains, activate, moveCursor, pointCursor, resolveCursorPoint, inputGesture, enableInspection, mouseButtons, stringify, compactConsoleValue, consoleEventText, consoleEventLevel, consoleEventUrl, compactDialogEvents, compactConsoleEvents, pageSearchLabel, leanPageSearchResult, compactPageSearchResult, compactModelUse, shapePageSearchRanking, parseJsonObject, cdpParamsFromArgs, escapeHtml, decodeDataUrl, documentForDataUrl, navigateDataUrl, mouseStep, interpolatePath, runtimeEvaluate, finiteNumber, pageBackend, environmentController, navigateHistory, grantClipboardPermission, validClip, visualMapCaptureClip, shouldRunVisualModel, captureVisualMapScreenshot, visualElementForDetail, mergeVisualMapModelResult, domNodeClickTargetExpression, backgroundClickExpression, domNodeClickExpression, domNodeHoverTargetExpression, domNodeEditableExpression, selectorClickTargetExpression, selectorClickExpression, clickAtPointExpression, hoverAtPointExpression, selectorHoverTargetExpression, selectorEditableExpression, selectorTextExpression, focusedEditableSnapshotExpression, focusedEditableTargetExpression, verifyFocusedEditableExpression, setFocusedSelectValueExpression, clickPoint, hoverPoint, insertTextAndVerify, fillFocusedEditable, pressKey, sleep, scrollPoint, scrollSnapshotExpression, scrollFallbackExpression, didScroll, scrollTab, waitForPageReady, applyEnvironment, resetEnvironment, fetchSourceMapFromPageExpression, fetchConsoleSourceMaps, networkInspectOperation };
  const tools = {
    ...createSessionOperations(dependencies),
    ...createInputOperations(dependencies),
    ...createInspectionOperations(dependencies),
    ...createEventOperations(dependencies),
    ...createConfigurationOperations(dependencies),
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
