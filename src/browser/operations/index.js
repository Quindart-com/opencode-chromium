import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { browserRequest, listBrowserProfiles, resolveBrowserProfile } from "../client.js";
import { NETWORK_INSPECT_ARGS } from "../../core/network-capability.js";
import { inspectNetworkEvents } from "../network.js";

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.
const tool = Object.assign((definition) => definition, { schema: z });

const selectedProfilesBySession = new Map();
const usedProfilesBySession = new Map();

function contextValue(context, keys) {
  for (const key of keys) {
    if (context?.[key] !== undefined && context?.[key] !== null) return String(context[key]);
  }
  return null;
}

function sessionKey(context) {
  return contextValue(context, ["sessionID", "sessionId", "session_id"]) ?? "opencode";
}

function sessionParams(context, params = {}) {
  const sessionId = sessionKey(context);
  const turnId = contextValue(context, ["messageID", "messageId", "turnID", "turnId", "requestID", "requestId"])
    ?? sessionId;
  return {
    session_id: sessionId,
    turn_id: turnId,
    ...params,
  };
}

function explicitProfileId(params = {}) {
  const id = params.profileId ?? params.profile_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function markProfileUsed(context, profileId) {
  const key = sessionKey(context);
  let used = usedProfilesBySession.get(key);
  if (!used) {
    used = new Set();
    usedProfilesBySession.set(key, used);
  }
  used.add(profileId);
}

async function resolveSessionProfileId(context, requestedProfileId = null) {
  const key = sessionKey(context);
  const selected = selectedProfilesBySession.get(key) ?? null;
  const used = usedProfilesBySession.get(key);
  const stickyProfileId = !requestedProfileId && !selected && used?.size === 1 ? [...used][0] : null;
  const profile = await resolveBrowserProfile(requestedProfileId ?? selected ?? stickyProfileId);
  return profile.profileId;
}

async function profileSessionParams(context, params = {}) {
  const requestedProfileId = explicitProfileId(params);
  const profileId = await resolveSessionProfileId(context, requestedProfileId);
  const cleanParams = { ...params };
  delete cleanParams.profileId;
  delete cleanParams.profile_id;
  return { profileId, params: sessionParams(context, { ...cleanParams, profile_id: profileId }) };
}

async function targetProfileIdsForSession(context) {
  const key = sessionKey(context);
  const used = [...(usedProfilesBySession.get(key) ?? [])];
  if (used.length > 0) return used;

  const selected = selectedProfilesBySession.get(key);
  if (selected) return [selected];

  return [await resolveSessionProfileId(context)];
}

async function extensionProfileRequest(context, method, params = {}) {
  const request = await profileSessionParams(context, params);
  markProfileUsed(context, request.profileId);
  return {
    profileId: request.profileId,
    result: await browserRequest(method, request.params, { profileId: request.profileId }),
  };
}

async function extensionRequest(context, method, params = {}) {
  return (await extensionProfileRequest(context, method, params)).result;
}

function addProfileToTabResult(result, profileId) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result.tabs)) {
    return { ...result, profileId, tabs: result.tabs.map((tab) => ({ ...tab, profileId })) };
  }
  return { ...result, profileId };
}

const attachedTabKeys = new Set();
const enabledDomainsByTabKey = new Map();

function tabCacheKey(context, profileId, tabId) {
  return `${sessionKey(context)}:${profileId}:${tabId}`;
}

function clearTabCache(context, tabId, profileId = null) {
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

function clearSessionCache(context, profileId = null) {
  const prefix = `${sessionKey(context)}:${profileId ? `${profileId}:` : ""}`;
  for (const key of [...attachedTabKeys]) {
    if (key.startsWith(prefix)) attachedTabKeys.delete(key);
  }
  for (const key of [...enabledDomainsByTabKey.keys()]) {
    if (key.startsWith(prefix)) enabledDomainsByTabKey.delete(key);
  }
}

function cdpRequestOptions(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs: Math.ceil(timeoutMs + 5000) } : {};
}

async function ensureAttached(context, tabId, profileId) {
  const key = tabCacheKey(context, profileId, tabId);
  if (attachedTabKeys.has(key)) return;
  await extensionRequest(context, "attach", { tabId, profile_id: profileId });
  attachedTabKeys.add(key);
}

function isDebuggerDetachedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /debugger unattached|not attached/i.test(message);
}

async function executeCdpRequest(context, tabId, method, commandParams = {}, timeoutMs, profileId = null) {
  const resolvedProfileId = profileId ?? await resolveSessionProfileId(context);
  markProfileUsed(context, resolvedProfileId);
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

async function cdp(context, tabId, method, commandParams = {}, timeoutMs, options = {}) {
  const profileId = options.profileId ?? await resolveSessionProfileId(context);
  if (method === "Target.getTargets") return executeCdpRequest(context, tabId, method, commandParams, timeoutMs, profileId);

  await ensureAttached(context, tabId, profileId);
  if (method === "Performance.getMetrics") await enableCdpDomains(context, tabId, ["Performance"], { profileId });

  try {
    return await executeCdpRequest(context, tabId, method, commandParams, timeoutMs, profileId);
  } catch (error) {
    if (!isDebuggerDetachedError(error)) throw error;
    clearTabCache(context, tabId, profileId);
    await ensureAttached(context, tabId, profileId);
    return executeCdpRequest(context, tabId, method, commandParams, timeoutMs, profileId);
  }
}

async function enableCdpDomains(context, tabId, domains, options = {}) {
  const profileId = options.profileId ?? await resolveSessionProfileId(context);
  const key = tabCacheKey(context, profileId, tabId);
  const enabled = enabledDomainsByTabKey.get(key) ?? new Set();

  for (const domain of domains) {
    if (enabled.has(domain)) continue;
    try {
      await cdp(context, tabId, `${domain}.enable`, {}, undefined, { profileId });
      enabled.add(domain);
    } catch (error) {
      if (!options.optional) throw error;
    }
  }

  enabledDomainsByTabKey.set(key, enabled);
}

async function activate(context, tabId) {
  await extensionRequest(context, "activateTab", { tabId, foreground: false }).catch(() => null);
}

async function moveCursor(context, tabId, x, y, options = {}) {
  return extensionRequest(context, "moveMouse", { tabId, x, y, ...options }).catch(() => null);
}

async function inputGesture(context, tabId, steps, timeoutMs) {
  const { profileId, params } = await profileSessionParams(context, { tabId, steps, timeoutMs });
  markProfileUsed(context, profileId);
  return browserRequest(
    "inputGesture",
    params,
    { profileId, timeoutMs: Math.max(timeoutMs ?? 0, 30000) },
  );
}

async function enableInspection(context, tabId) {
  await enableCdpDomains(context, tabId, ["Page", "Runtime", "Log", "Network", "Performance", "DOM", "Accessibility"], { optional: true });
}

function mouseButtons(button) {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 1;
}

const MODIFIER_DEFINITIONS = {
  Alt: { bit: 1, key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, location: 1 },
  Control: { bit: 2, key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, location: 1 },
  Meta: { bit: 4, key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, location: 1 },
  Shift: { bit: 8, key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, location: 1 },
};

const KEY_NAME_ALIASES = {
  Ctrl: "Control",
  Cmd: "Meta",
  Command: "Meta",
  Esc: "Escape",
  Return: "Enter",
  Space: " ",
  Spacebar: " ",
};

const SPECIAL_KEY_DEFINITIONS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Insert: { key: "Insert", code: "Insert", windowsVirtualKeyCode: 45 },
  " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

const PRINTABLE_CODE_BY_KEY = {
  "0": "Digit0",
  "1": "Digit1",
  "2": "Digit2",
  "3": "Digit3",
  "4": "Digit4",
  "5": "Digit5",
  "6": "Digit6",
  "7": "Digit7",
  "8": "Digit8",
  "9": "Digit9",
  "-": "Minus",
  "=": "Equal",
  "[": "BracketLeft",
  "]": "BracketRight",
  "\\": "Backslash",
  ";": "Semicolon",
  "'": "Quote",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "`": "Backquote",
};

const KEY_NAME_CANONICAL = new Map([
  ...Object.entries(KEY_NAME_ALIASES),
  ...Object.keys(MODIFIER_DEFINITIONS).map((key) => [key, key]),
  ...Object.keys(SPECIAL_KEY_DEFINITIONS).map((key) => [key, key]),
].map(([key, value]) => [key.toLocaleLowerCase(), value]));

function normalizeKeyName(key) {
  const raw = String(key);
  const canonical = KEY_NAME_CANONICAL.get(raw.toLocaleLowerCase());
  if (canonical !== undefined) return canonical;
  if (/^f([1-9]|1[0-2])$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

function keyDefinition(key, modifiers = new Set(), rawPrimary = key) {
  const normalized = normalizeKeyName(key);
  if (SPECIAL_KEY_DEFINITIONS[normalized]) return { ...SPECIAL_KEY_DEFINITIONS[normalized] };

  if (/^F([1-9]|1[0-2])$/.test(normalized)) {
    const number = Number(normalized.slice(1));
    return { key: normalized, code: normalized, windowsVirtualKeyCode: 111 + number };
  }

  if (normalized.length === 1 && /^[a-z]$/i.test(normalized)) {
    const upper = normalized.toUpperCase();
    const text = modifiers.size ? undefined : rawPrimary;
    const key = modifiers.has("Control") || modifiers.has("Meta") || modifiers.has("Alt")
      ? upper.toLowerCase()
      : rawPrimary;
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text };
  }

  if (normalized.length === 1) {
    const code = PRINTABLE_CODE_BY_KEY[normalized];
    if (!code) throw new Error(`Unsupported key: ${rawPrimary}`);
    return { key: normalized, code, windowsVirtualKeyCode: normalized.toUpperCase().charCodeAt(0), text: modifiers.size ? undefined : normalized };
  }

  throw new Error(`Unsupported key: ${rawPrimary}`);
}

export function parseKeyPress(key) {
  if (typeof key !== "string" || key.length === 0) throw new Error("Key must be a non-empty string");

  const parts = key.includes("+") ? key.split("+").filter(Boolean) : [key];
  const modifiers = [];
  let primary = null;

  for (const part of parts) {
    const normalized = normalizeKeyName(part.trim());
    if (MODIFIER_DEFINITIONS[normalized]) {
      if (!modifiers.includes(normalized)) modifiers.push(normalized);
      continue;
    }
    if (primary !== null) throw new Error(`Key chord must contain only one non-modifier key: ${key}`);
    primary = part.trim();
  }

  if (!primary) throw new Error(`Key chord is missing a key: ${key}`);

  const modifierSet = new Set(modifiers);
  const primaryDefinition = keyDefinition(primary, modifierSet, primary);
  const modifierBits = modifiers.reduce((bits, modifier) => bits | MODIFIER_DEFINITIONS[modifier].bit, 0);
  const selectAll = primaryDefinition.code === "KeyA" && (modifierSet.has("Control") || modifierSet.has("Meta")) && !modifierSet.has("Alt");

  return {
    original: key,
    modifiers,
    modifierBits,
    primary: primaryDefinition,
    text: primaryDefinition.text,
    selectAll,
  };
}

export function keyDispatchEvents(parsed) {
  const events = [];
  let activeModifierBits = 0;

  for (const modifier of parsed.modifiers) {
    const { bit, ...definition } = MODIFIER_DEFINITIONS[modifier];
    activeModifierBits |= MODIFIER_DEFINITIONS[modifier].bit;
    events.push({ type: "rawKeyDown", modifiers: activeModifierBits, ...definition });
  }

  const primaryDownType = parsed.modifierBits || !parsed.text ? "rawKeyDown" : "keyDown";
  events.push({
    type: primaryDownType,
    modifiers: parsed.modifierBits,
    ...parsed.primary,
    text: parsed.modifierBits ? undefined : parsed.text,
    unmodifiedText: parsed.modifierBits ? undefined : parsed.text,
    commands: parsed.selectAll ? ["selectAll"] : undefined,
  });
  events.push({ type: "keyUp", modifiers: parsed.modifierBits, ...parsed.primary, text: undefined, unmodifiedText: undefined, commands: undefined });

  for (const modifier of [...parsed.modifiers].reverse()) {
    const { bit, ...definition } = MODIFIER_DEFINITIONS[modifier];
    activeModifierBits &= ~MODIFIER_DEFINITIONS[modifier].bit;
    events.push({ type: "keyUp", modifiers: activeModifierBits, ...definition, text: undefined, unmodifiedText: undefined });
  }

  return events;
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function compactConsoleValue(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, 1000);
}

function consoleEventText(event) {
  const params = event.params ?? {};
  if (event.method === "Runtime.consoleAPICalled") {
    return (params.args ?? [])
      .map((arg) => compactConsoleValue(arg.value ?? arg.description ?? arg.preview?.description ?? arg.type))
      .filter(Boolean)
      .join(" ");
  }
  return compactConsoleValue(params.entry?.text ?? params.text ?? "");
}

function consoleEventLevel(event) {
  const params = event.params ?? {};
  return params.entry?.level ?? params.type ?? "log";
}

function consoleEventUrl(event) {
  const params = event.params ?? {};
  const frame = params.stackTrace?.callFrames?.[0] ?? params.entry?.stackTrace?.callFrames?.[0];
  return params.entry?.url ?? frame?.url ?? null;
}

function compactConsoleEvents(response, options = {}) {
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
    const frame = params.stackTrace?.callFrames?.[0] ?? params.entry?.stackTrace?.callFrames?.[0] ?? null;
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
      ...(frame ? { topFrame: { functionName: frame.functionName || null, url: frame.url || null, lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null, columnNumber: Number.isInteger(frame.columnNumber) ? frame.columnNumber + 1 : null } } : {}),
      ...(options.includeStack ? { stackTrace: params.stackTrace ?? params.entry?.stackTrace ?? null } : {}),
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

function pageSearchLabel(result) {
  return compactConsoleValue(result.name || result.text || result.selector || result.kind).slice(0, 220) || null;
}

function leanPageSearchResult(result) {
  return {
    node_id: result.node_id,
    kind: result.kind,
    label: pageSearchLabel(result),
    interactive: result.interactive === true,
  };
}

function compactPageSearchResult(result) {
  return {
    ...leanPageSearchResult(result),
    text: compactConsoleValue(result.text).slice(0, 220) || null,
  };
}

function compactModelUse(ranking) {
  const model = ranking?.model;
  if (!model || typeof model !== "object") return null;
  return {
    enabled: ranking.enabled === true,
    used: model.used === true,
    error: model.error ?? model.embedding?.error ?? model.reranker?.error ?? null,
  };
}

export function shapePageSearchRanking(ranking, detail = "lean") {
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
      results: ranking.results.map(compactPageSearchResult),
    };
  }
  return {
    ...base,
    results: ranking.results.map(leanPageSearchResult),
  };
}

function parseJsonObject(value, label) {
  if (value === undefined || value === null || value === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function cdpParamsFromArgs(args) {
  return {
    ...(args.params && typeof args.params === "object" ? args.params : {}),
    ...parseJsonObject(args.paramsJson, "paramsJson"),
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeDataUrl(url) {
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

function documentForDataUrl(url) {
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

async function navigateDataUrl(context, tabId, url) {
  const document = documentForDataUrl(url);
  await cdp(context, tabId, "Page.enable", {}).catch(() => {});
  const navigation = await cdp(context, tabId, "Page.navigate", { url: "about:blank" });
  const frameId = navigation.frameId
    ?? (await cdp(context, tabId, "Page.getFrameTree", {})).frameTree?.frame?.id;
  if (!frameId) throw new Error("Could not find main frame for data URL navigation");
  await cdp(context, tabId, "Page.setDocumentContent", { frameId, html: document.html });
  return { tabId, url, loadedAs: "documentContent", mimeType: document.mimeType };
}

function validateUploadFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("browser_set_file_input requires at least one file");
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0) throw new Error("File paths must be non-empty strings");
    if (!path.isAbsolute(file)) throw new Error(`File path must be absolute: ${file}`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error(`File does not exist: ${file}`);
    }
    if (!stat.isFile()) throw new Error(`Path is not a file: ${file}`);
  }
}

function attributesMap(attributes = []) {
  const map = new Map();
  for (let index = 0; index < attributes.length; index += 2) {
    map.set(String(attributes[index]).toLowerCase(), attributes[index + 1] ?? "");
  }
  return map;
}

function fileUploadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Not allowed" || /not allowed/i.test(message)) {
    return new Error('File upload was blocked by Chrome. In chrome://extensions, open Details for the agent-browser extension and enable "Allow access to file URLs."');
  }
  return error;
}

function mouseStep(commandParams, cursor, delayMs = 0) {
  return {
    method: "Input.dispatchMouseEvent",
    commandParams,
    cursor,
    delayMs,
  };
}

function interpolatePath(points, maxStep = 16) {
  const output = [];
  for (const point of points) {
    if (!output.length) {
      output.push(point);
      continue;
    }
    const previous = output.at(-1);
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

async function dispatchMouse(context, tabId, params) {
  return cdp(context, tabId, "Input.dispatchMouseEvent", params);
}

async function runtimeEvaluate(context, tabId, expression, options = {}) {
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

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function interactionHelpersSource() {
  return `
    const describeElement = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return 'none';
      const id = element.id ? '#' + element.id : '';
      const classes = element.classList?.length ? '.' + [...element.classList].slice(0, 3).join('.') : '';
      const text = (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      return '<' + element.localName + id + classes + '>' + (text ? ' "' + text + '"' : '');
    };

    const composedContains = (root, candidate) => {
      for (let node = candidate; node; node = node.parentElement || node.getRootNode?.().host || null) {
        if (node === root) return true;
      }
      return false;
    };

    const querySelectorStrict = (selector) => {
      let element;
      try {
        element = document.querySelector(selector);
      } catch (error) {
        throw new Error('Invalid selector: ' + selector + ': ' + (error && error.message ? error.message : String(error)));
      }
      if (!element) throw new Error('No element matches selector: ' + selector);
      return element;
    };

    const nodeByIdStrict = (nodeId) => {
      const node = window.__agentBrowserDomNodeMap && window.__agentBrowserDomNodeMap.get(nodeId);
      if (!node) throw new Error('Unknown DOM node id. Take a fresh browser_dom_snapshot first.');
      if (!node.isConnected) throw new Error('DOM node is detached. Take a fresh browser_dom_snapshot first.');
      return node;
    };

    const disabledReason = (element) => {
      if (element.disabled === true) return 'element is disabled';
      if (element.getAttribute('aria-disabled') === 'true') return 'element has aria-disabled=true';
      if (element.closest?.('fieldset[disabled]')) return 'element is inside a disabled fieldset';
      return null;
    };

    const editableKind = (element, includeSelect = false) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
      const localName = element.localName;
      if (localName === 'textarea') return element.readOnly || disabledReason(element) ? null : 'textarea';
      if (localName === 'input') {
        const type = String(element.type || 'text').toLowerCase();
        const blocked = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
        if (blocked.has(type) || element.readOnly || disabledReason(element)) return null;
        return 'input';
      }
      if (includeSelect && localName === 'select') return disabledReason(element) ? null : 'select';
      if (element.isContentEditable) return disabledReason(element) ? null : 'contenteditable';
      return null;
    };

    const editableValue = (element, kind) => {
      if (kind === 'input' || kind === 'textarea' || kind === 'select') return String(element.value ?? '');
      return String(element.innerText || element.textContent || '');
    };

    const textHash = (value) => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    };

    const editableSnapshot = (element, kind) => {
      const value = editableValue(element, kind);
      const selection = window.getSelection();
      return {
        kind,
        tagName: element.localName,
        type: element.getAttribute('type'),
        value,
        valueHash: textHash(value),
        selectionStart: Number.isFinite(element.selectionStart) ? element.selectionStart : null,
        selectionEnd: Number.isFinite(element.selectionEnd) ? element.selectionEnd : null,
        selectedText: selection && selection.rangeCount ? String(selection.toString()) : '',
      };
    };

    const visibleRect = (element) => {
      if (!element.isConnected) throw new Error('Element is detached: ' + describeElement(element));
      const style = getComputedStyle(element);
      if (style.display === 'none') throw new Error('Element is not visible: display is none: ' + describeElement(element));
      if (style.visibility === 'hidden' || style.visibility === 'collapse') throw new Error('Element is not visible: visibility is ' + style.visibility + ': ' + describeElement(element));
      const virtualEditorInput = element.matches?.('textarea.inputarea, textarea[aria-label*="editor" i]') || Boolean(element.closest?.('.monaco-editor, [data-editor]'));
      if (Number(style.opacity) === 0 && !virtualEditorInput) throw new Error('Element is not visible: opacity is 0: ' + describeElement(element));

      let best = null;
      for (const rect of element.getClientRects()) {
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(innerWidth, rect.right);
        const bottom = Math.min(innerHeight, rect.bottom);
        const width = right - left;
        const height = bottom - top;
        if (width <= 0 || height <= 0) continue;
        const area = width * height;
        if (!best || area > best.area) best = { left, top, right, bottom, width, height, area };
      }
      if (!best) throw new Error('Element has no visible viewport area: ' + describeElement(element));
      return best;
    };

    const assertPointerInteractable = (element) => {
      const reason = disabledReason(element);
      if (reason) throw new Error('Element is not interactable: ' + reason + ': ' + describeElement(element));
      const style = getComputedStyle(element);
      if (style.pointerEvents === 'none') throw new Error('Element is not clickable: pointer-events is none: ' + describeElement(element));
    };

    const clickTarget = (element) => {
      assertPointerInteractable(element);
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = visibleRect(element);
      const fractions = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.2], [0.5, 0.8]];
      let coveredBy = null;
      for (const [fx, fy] of fractions) {
        const x = Math.floor(rect.left + Math.max(1, rect.width - 1) * fx);
        const y = Math.floor(rect.top + Math.max(1, rect.height - 1) * fy);
        const hit = document.elementFromPoint(x, y);
        if (hit && composedContains(element, hit)) {
          return { x, y, tagName: element.localName, text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
        }
        coveredBy = hit;
      }
      throw new Error('Element is not clickable: safe click points are covered by ' + describeElement(coveredBy) + ': ' + describeElement(element));
    };

    const focusedEditableElement = (includeSelect = false) => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (editableKind(active, includeSelect)) return active;
      const selection = window.getSelection();
      let node = selection?.anchorNode;
      if (node && node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
      const editable = node?.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
      return editableKind(editable, includeSelect) ? editable : null;
    };

    const selectEditableText = (element, kind) => {
      element.focus({ preventScroll: true });
      if (kind === 'input' || kind === 'textarea') {
        element.select();
        return;
      }
      if (kind === 'contenteditable') {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };

    const placeCursorAtEnd = (element, kind) => {
      element.focus({ preventScroll: true });
      if (kind === 'input' || kind === 'textarea') {
        const length = String(element.value ?? '').length;
        element.setSelectionRange(length, length);
        return;
      }
      if (kind === 'contenteditable') {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
    };

    const prepareEditable = (element, options = {}) => {
      const kind = editableKind(element, Boolean(options.includeSelect));
      if (!kind) throw new Error('Element is not editable: ' + describeElement(element));
      element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      visibleRect(element);
      element.focus({ preventScroll: true });
      if (document.activeElement !== element && !composedContains(element, document.activeElement)) {
        throw new Error('Element could not be focused: ' + describeElement(element));
      }
      if (options.selectAll && kind !== 'select') selectEditableText(element, kind);
      if (options.cursorAtEnd && kind !== 'select') placeCursorAtEnd(element, kind);
      return editableSnapshot(element, kind);
    };

    const setFocusedSelectValue = (value) => {
      const element = focusedEditableElement(true);
      const kind = editableKind(element, true);
      if (kind !== 'select') throw new Error('Focused element is not a select element');
      const option = [...element.options].find((item) => item.value === value || item.text.trim() === value);
      if (!option) throw new Error('No select option matches value or text: ' + value);
      element.value = option.value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return editableSnapshot(element, kind);
    };
  `;
}

async function navigateHistory(context, tabId, delta) {
  await enableCdpDomains(context, tabId, ["Page"], { optional: true });
  const history = await cdp(context, tabId, "Page.getNavigationHistory", {});
  const targetIndex = history.currentIndex + delta;
  const entry = history.entries?.[targetIndex];
  if (!entry) throw new Error(delta < 0 ? "No previous history entry" : "No next history entry");
  await cdp(context, tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
  const readiness = await waitForPageReady(context, tabId, "domcontentloaded", 15000);
  entry.readiness = readiness;
  return entry;
}

async function grantClipboardPermission(context, tabId) {
  const tab = await extensionRequest(context, "getTab", { tabId }).catch(() => null);
  let origin = null;
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

function validClip(clip) {
  if (!clip || typeof clip !== "object") return null;
  const x = Number(clip.x);
  const y = Number(clip.y);
  const width = Number(clip.width);
  const height = Number(clip.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), scale: Number.isFinite(clip.scale) ? clip.scale : 1 };
}

function visualMapCaptureClip(args, map) {
  const explicit = validClip(args.clip);
  if (explicit) return explicit;
  const scopeBox = validClip(map?.scope?.boundingBox);
  if (scopeBox && map?.scope?.mode && map.scope.mode !== "page" && map.scope.mode !== "viewport") {
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

function shouldRunVisualModel(args, map) {
  if (args.vision === "off") return false;
  if (args.vision === "force") return true;
  return (map?.elements?.length ?? 0) === 0;
}

async function captureVisualMapScreenshot(context, tabId, args, map) {
  await enableCdpDomains(context, tabId, ["Page"], { optional: true });
  const clip = visualMapCaptureClip(args, map);
  const params = { format: "png", optimizeForSpeed: true };
  if (clip) params.clip = clip;
  const result = await cdp(context, tabId, "Page.captureScreenshot", params, args.timeoutMs ?? 30000);
  return { base64: result.data, origin: { x: clip?.x ?? 0, y: clip?.y ?? 0 } };
}

function visualElementForDetail(element, origin, detail) {
  const box = element?.box && typeof element.box === "object"
    ? {
        x: Math.round(Number(element.box.x ?? 0) + origin.x),
        y: Math.round(Number(element.box.y ?? 0) + origin.y),
        width: Math.max(1, Math.round(Number(element.box.width ?? 1))),
        height: Math.max(1, Math.round(Number(element.box.height ?? 1))),
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

function mergeVisualMapModelResult(map, visual, origin, detail) {
  const elements = Array.isArray(visual?.elements) ? visual.elements : [];
  if (!elements.length) return map;
  return {
    ...map,
    elements: [
      ...(Array.isArray(map.elements) ? map.elements : []),
      ...elements.map((element) => visualElementForDetail(element, origin, detail)).filter((element) => element.box),
    ],
    returned: (map.returned ?? 0) + elements.length,
    sources: [...new Set([...(map.sources ?? ["dom"]), "visual"])],
    ...(detail === "debug" ? { visualModel: { used: visual.used === true, model: visual.model ?? null } } : {}),
  };
}

function domSnapshotExpression() {
  return `(() => {
    if (!(window.__agentBrowserDomNodeMap instanceof Map) || window.__agentBrowserDomNodeMap.size > 2000) window.__agentBrowserDomNodeMap = new Map();
    for (const [id, element] of window.__agentBrowserDomNodeMap) {
      if (!element?.isConnected) window.__agentBrowserDomNodeMap.delete(id);
    }
    if (!Number.isFinite(window.__agentBrowserDomNextNodeId)) window.__agentBrowserDomNextNodeId = 1;
    const previousNodeMap = window.__agentBrowserDomNodeMap;
    const selectorFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
        let part = node.localName;
        if (!part) break;
        if (node.classList.length) part += '.' + [...node.classList].slice(0, 3).map((name) => CSS.escape(name)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        if (parts.length >= 5) break;
      }
      return parts.join(' > ');
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const nameFor = (element) => element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.labels?.[0]?.innerText || '';
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex],summary,label,[contenteditable],details,option')]
      .filter(visible)
      .slice(0, 500)
      .map((element) => {
        const id = 'node-' + window.__agentBrowserDomNextNodeId++;
        window.__agentBrowserDomNodeMap.set(id, element);
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240);
        return {
          node_id: id,
          tagName: element.localName,
          role: element.getAttribute('role'),
          ariaName: nameFor(element) || null,
          text,
          type: element.getAttribute('type'),
          selector: selectorFor(element),
          boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        };
      });
    return { url: location.href, title: document.title, nodes };
  })()`;
}

export function pageSearchUnitsExpression(options = {}) {
  const maxUnits = Number.isInteger(options.maxUnits) && options.maxUnits > 0 ? Math.min(options.maxUnits, 1500) : 700;
  const scope = ["auto", "page", "viewport", "focused"].includes(options.scope) ? options.scope : "auto";
  const rootSelector = typeof options.selector === "string" && options.selector.length > 0 ? options.selector : null;
  const containerNodeId = typeof options.containerNodeId === "string" && options.containerNodeId.length > 0 ? options.containerNodeId : null;
  const clip = options.clip && Number.isFinite(options.clip.x) && Number.isFinite(options.clip.y) && Number.isFinite(options.clip.width) && Number.isFinite(options.clip.height)
    ? {
        x: Math.round(options.clip.x),
        y: Math.round(options.clip.y),
        width: Math.max(1, Math.round(options.clip.width)),
        height: Math.max(1, Math.round(options.clip.height)),
      }
    : null;
  return `(() => {
    if (!(window.__agentBrowserDomNodeMap instanceof Map) || window.__agentBrowserDomNodeMap.size > 2000) window.__agentBrowserDomNodeMap = new Map();
    for (const [id, element] of window.__agentBrowserDomNodeMap) {
      if (!element?.isConnected) window.__agentBrowserDomNodeMap.delete(id);
    }
    if (!Number.isFinite(window.__agentBrowserDomNextNodeId)) window.__agentBrowserDomNextNodeId = 1;
    const previousNodeMap = window.__agentBrowserDomNodeMap;
    const maxUnits = ${JSON.stringify(maxUnits)};
    const requestedScope = ${JSON.stringify(scope)};
    const requestedSelector = ${JSON.stringify(rootSelector)};
    const requestedContainerNodeId = ${JSON.stringify(containerNodeId)};
    const requestedClip = ${JSON.stringify(clip)};
    const compact = (value, max = 500) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const textOf = (element, max = 500) => compact(element.innerText || element.value || element.textContent || '', max);
    const textById = (id) => id ? compact((document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ''), 180) : '';
    const visible = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      for (const rect of element.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) return true;
      }
      return false;
    };
    const boxFor = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const inViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const intersectsClip = (element) => {
      if (!requestedClip) return true;
      const rect = element.getBoundingClientRect();
      const left = Math.max(rect.left, requestedClip.x);
      const top = Math.max(rect.top, requestedClip.y);
      const right = Math.min(rect.right, requestedClip.x + requestedClip.width);
      const bottom = Math.min(rect.bottom, requestedClip.y + requestedClip.height);
      return right > left && bottom > top;
    };
    const selectorFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
        let part = node.localName;
        if (!part) break;
        const role = node.getAttribute('role');
        if (role && parts.length === 0) part += '[role="' + CSS.escape(role) + '"]';
        if (node.classList.length) part += '.' + [...node.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        if (parts.length >= 4) break;
      }
      return parts.join(' > ');
    };
    const nameFor = (element) => {
      const labelledBy = compact(String(element.getAttribute('aria-labelledby') || '').split(/\\s+/).map(textById).filter(Boolean).join(' '), 180);
      return compact(element.getAttribute('aria-label') || labelledBy || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.labels?.[0]?.innerText || '', 180);
    };
    const kindFor = (element) => {
      const tag = element.localName;
      const role = element.getAttribute('role');
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'a') return 'link';
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable) return 'field';
      if (tag === 'option') return 'option';
      if (tag === 'form') return 'form';
      if (tag === 'main' || tag === 'section' || tag === 'article' || tag === 'nav' || tag === 'aside' || role === 'region') return 'region';
      if (element.hasAttribute('aria-live') || role === 'status' || role === 'alert') return 'status';
      return role || 'element';
    };
    const interactive = (element) => element.matches('a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="combobox"],[tabindex],summary,label,[contenteditable],option');
    const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
      .filter(visible)
      .map((element) => ({ element, level: Number(element.localName.slice(1)), text: textOf(element, 120) }))
      .filter((heading) => heading.text);
    const headingPathFor = (element) => {
      const stack = [];
      for (const heading of headings) {
        if (!(heading.element.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        stack[heading.level - 1] = heading.text;
        stack.length = heading.level;
      }
      return stack.filter(Boolean).slice(-4);
    };
    const landmarkFor = (element) => {
      const landmark = element.closest('main,nav,aside,header,footer,form,dialog,[role="main"],[role="navigation"],[role="complementary"],[role="banner"],[role="contentinfo"],[role="form"],[role="dialog"]');
      if (!landmark) return null;
      return compact(nameFor(landmark) || landmark.getAttribute('role') || landmark.localName, 120) || null;
    };
    const idFor = (element) => {
      for (const [id, mapped] of window.__agentBrowserDomNodeMap) {
        if (mapped === element) return id;
      }
      const id = 'node-' + window.__agentBrowserDomNextNodeId++;
      window.__agentBrowserDomNodeMap.set(id, element);
      return id;
    };
    const focusedRoot = () => {
      const modalSelector = 'dialog[open],[role="dialog"],[aria-modal="true"],[popover]:popover-open,.modal,.popover,.dialog';
      const candidates = [...document.querySelectorAll(modalSelector)]
        .filter(visible)
        .filter(inViewport)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const zIndex = Number.parseInt(style.zIndex, 10);
          return { element, area: Math.max(0, rect.width * rect.height), zIndex: Number.isFinite(zIndex) ? zIndex : 0 };
        })
        .filter((item) => item.area > 0)
        .sort((first, second) => second.zIndex - first.zIndex || second.area - first.area);
      return candidates[0]?.element ?? null;
    };
    const rootForScope = () => {
      if (requestedContainerNodeId && previousNodeMap?.has(requestedContainerNodeId)) {
        const node = previousNodeMap.get(requestedContainerNodeId);
        if (node?.isConnected) return { root: node, mode: 'node' };
      }
      if (requestedSelector) {
        const node = document.querySelector(requestedSelector);
        if (node) return { root: node, mode: 'selector' };
      }
      if (requestedScope === 'focused' || requestedScope === 'auto') {
        const root = focusedRoot();
        if (root) return { root, mode: 'focused' };
      }
      return { root: document, mode: requestedScope === 'viewport' ? 'viewport' : 'page' };
    };
    const candidateSelector = 'a,button,input,textarea,select,[role],[tabindex],summary,label,[contenteditable],details,option,h1,h2,h3,h4,h5,h6,main,section,article,nav,aside,form,dialog,[aria-live]';
    const priority = (element) => {
      const kind = kindFor(element);
      if (kind === 'form' || kind === 'region') return 4;
      if (kind === 'heading' || kind === 'status') return 3;
      if (interactive(element)) return 2;
      return 1;
    };
    const scopeInfo = rootForScope();
    const queryRoot = scopeInfo.root === document ? document : scopeInfo.root;
    const rawCandidates = queryRoot === document
      ? [...document.querySelectorAll(candidateSelector)]
      : [queryRoot, ...queryRoot.querySelectorAll(candidateSelector)];
    const candidates = [...new Set(rawCandidates)]
      .filter(visible)
      .filter((element) => scopeInfo.mode !== 'viewport' || inViewport(element))
      .filter(intersectsClip)
      .filter((element) => interactive(element) || textOf(element, 240).length > 0)
      .sort((first, second) => {
        const byPriority = priority(second) - priority(first);
        if (byPriority) return byPriority;
        return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    const units = candidates.slice(0, maxUnits).map((element) => {
      const rect = element.getBoundingClientRect();
      const type = element.getAttribute('type');
      return {
        node_id: idFor(element),
        kind: kindFor(element),
        tagName: element.localName,
        role: element.getAttribute('role'),
        name: nameFor(element) || null,
        text: type === 'password' ? '' : textOf(element, interactive(element) ? 240 : 500),
        type,
        placeholder: element.getAttribute('placeholder'),
        selector: selectorFor(element),
        headingPath: headingPathFor(element),
        landmark: landmarkFor(element),
        boundingBox: boxFor(element),
        inViewport: inViewport(element),
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        interactive: interactive(element),
      };
    });
    const scopeBox = scopeInfo.root && scopeInfo.root !== document ? boxFor(scopeInfo.root) : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    return {
      url: location.href,
      title: document.title,
      scope: {
        requested: requestedScope,
        mode: scopeInfo.mode,
        selector: requestedSelector,
        node_id: scopeInfo.root && scopeInfo.root !== document ? idFor(scopeInfo.root) : null,
        boundingBox: scopeBox,
        clip: requestedClip,
      },
      totalCandidates: candidates.length,
      truncated: candidates.length > units.length,
      units,
    };
  })()`;
}

export function visualMapExpression(options = {}) {
  const maxResults = Number.isInteger(options.maxResults) && options.maxResults > 0 ? Math.min(options.maxResults, 250) : 80;
  const scope = ["auto", "page", "viewport", "focused"].includes(options.scope) ? options.scope : "auto";
  const rootSelector = typeof options.selector === "string" && options.selector.length > 0 ? options.selector : null;
  const containerNodeId = typeof options.nodeId === "string" && options.nodeId.length > 0 ? options.nodeId : null;
  const query = typeof options.query === "string" && options.query.length > 0 ? options.query : "";
  const detail = options.detail === "debug" ? "debug" : "lean";
  const clip = options.clip && Number.isFinite(options.clip.x) && Number.isFinite(options.clip.y) && Number.isFinite(options.clip.width) && Number.isFinite(options.clip.height)
    ? {
        x: Math.round(options.clip.x),
        y: Math.round(options.clip.y),
        width: Math.max(1, Math.round(options.clip.width)),
        height: Math.max(1, Math.round(options.clip.height)),
      }
    : null;
  return `(() => {
    const previousNodeMap = window.__agentBrowserDomNodeMap instanceof Map ? window.__agentBrowserDomNodeMap : null;
    window.__agentBrowserDomNodeMap = new Map();
    window.__agentBrowserDomNextNodeId = 1;
    const maxResults = ${JSON.stringify(maxResults)};
    const requestedScope = ${JSON.stringify(scope)};
    const requestedSelector = ${JSON.stringify(rootSelector)};
    const requestedNodeId = ${JSON.stringify(containerNodeId)};
    const requestedQuery = ${JSON.stringify(query)};
    const requestedDetail = ${JSON.stringify(detail)};
    const requestedClip = ${JSON.stringify(clip)};
    const compact = (value, max = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const textOf = (element, max = 240) => compact(element.innerText || element.value || element.textContent || '', max);
    const textById = (id) => id ? compact((document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ''), 180) : '';
    const visible = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      for (const rect of element.getClientRects()) {
        if (rect.width > 1 && rect.height > 1) return true;
      }
      return false;
    };
    const boxFor = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const inViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const intersectsClip = (element) => {
      if (!requestedClip) return true;
      const rect = element.getBoundingClientRect();
      const left = Math.max(rect.left, requestedClip.x);
      const top = Math.max(rect.top, requestedClip.y);
      const right = Math.min(rect.right, requestedClip.x + requestedClip.width);
      const bottom = Math.min(rect.bottom, requestedClip.y + requestedClip.height);
      return right > left && bottom > top;
    };
    const selectorFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
        let part = node.localName;
        if (!part) break;
        const role = node.getAttribute('role');
        if (role && parts.length === 0) part += '[role="' + CSS.escape(role) + '"]';
        if (node.classList.length) part += '.' + [...node.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        if (parts.length >= 4) break;
      }
      return parts.join(' > ');
    };
    const nameFor = (element) => {
      const labelledBy = compact(String(element.getAttribute('aria-labelledby') || '').split(/\\s+/).map(textById).filter(Boolean).join(' '), 180);
      return compact(element.getAttribute('aria-label') || labelledBy || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.labels?.[0]?.innerText || '', 180);
    };
    const kindFor = (element) => {
      const tag = element.localName;
      const role = element.getAttribute('role');
      const type = String(element.getAttribute('type') || '').toLowerCase();
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'a' || role === 'link') return 'link';
      if (tag === 'input' && (type === 'checkbox' || role === 'checkbox')) return 'checkbox';
      if (tag === 'input' && (type === 'radio' || role === 'radio')) return 'radio';
      if (role === 'switch') return 'switch';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || role === 'textbox' || element.isContentEditable) return 'field';
      if (role === 'menuitem') return 'menuitem';
      if (role === 'tab') return 'tab';
      if (tag === 'dialog' || role === 'dialog') return 'dialog';
      if (tag === 'form' || role === 'form') return 'form';
      if (tag === 'label') return 'label';
      if (tag === 'summary') return 'summary';
      if (tag === 'svg') return 'icon';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return role || tag || 'element';
    };
    const interactive = (element) => element.matches('a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="combobox"],[role="tab"],[tabindex],summary,label,[contenteditable],option');
    const idFor = (element) => {
      for (const [id, mapped] of window.__agentBrowserDomNodeMap) {
        if (mapped === element) return id;
      }
      const id = 'node-' + window.__agentBrowserDomNextNodeId++;
      window.__agentBrowserDomNodeMap.set(id, element);
      return id;
    };
    const focusedRoot = () => {
      const modalSelector = 'dialog[open],[role="dialog"],[aria-modal="true"],[popover]:popover-open,.modal,.popover,.dialog';
      const candidates = [...document.querySelectorAll(modalSelector)]
        .filter(visible)
        .filter(inViewport)
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          const zIndex = Number.parseInt(style.zIndex, 10);
          return { element, area: Math.max(0, rect.width * rect.height), zIndex: Number.isFinite(zIndex) ? zIndex : 0 };
        })
        .filter((item) => item.area > 0)
        .sort((first, second) => second.zIndex - first.zIndex || second.area - first.area);
      return candidates[0]?.element ?? null;
    };
    const rootForScope = () => {
      if (requestedNodeId && previousNodeMap?.has(requestedNodeId)) {
        const node = previousNodeMap.get(requestedNodeId);
        if (node?.isConnected) return { root: node, mode: 'node' };
      }
      if (requestedSelector) {
        const node = document.querySelector(requestedSelector);
        if (node) return { root: node, mode: 'selector' };
      }
      if (requestedScope === 'focused' || requestedScope === 'auto') {
        const root = focusedRoot();
        if (root) return { root, mode: 'focused' };
      }
      return { root: document, mode: requestedScope === 'viewport' ? 'viewport' : 'page' };
    };
    const lexicalScore = (value) => {
      const query = compact(requestedQuery, 240).toLowerCase();
      if (!query) return 0;
      const text = compact(value, 500).toLowerCase();
      const tokens = [...new Set(query.match(/[a-z0-9]{2,}/g) || [])];
      if (!tokens.length) return text.includes(query) ? 1 : 0;
      const matches = tokens.filter((token) => text.includes(token)).length;
      return (text.includes(query) ? 0.45 : 0) + matches / tokens.length * 0.55;
    };
    const coveredAtCenter = (element) => {
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, Math.min(innerWidth - 1, Math.floor(rect.left + rect.width / 2)));
      const y = Math.max(0, Math.min(innerHeight - 1, Math.floor(rect.top + rect.height / 2)));
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && hit !== element && !element.contains(hit));
    };
    const candidateSelector = 'a,button,input,textarea,select,[role],[tabindex],summary,label,[contenteditable],details,option,svg,[aria-label],[title],dialog,form,h1,h2,h3,h4,h5,h6';
    const scopeInfo = rootForScope();
    const queryRoot = scopeInfo.root === document ? document : scopeInfo.root;
    const rawCandidates = queryRoot === document
      ? [...document.querySelectorAll(candidateSelector)]
      : [queryRoot, ...queryRoot.querySelectorAll(candidateSelector)];
    const candidates = [...new Set(rawCandidates)]
      .filter(visible)
      .filter((element) => scopeInfo.mode !== 'viewport' || inViewport(element))
      .filter(intersectsClip)
      .filter((element) => interactive(element) || nameFor(element) || textOf(element, 80))
      .map((element) => {
        const label = nameFor(element) || textOf(element, 160) || kindFor(element);
        const searchText = [kindFor(element), element.getAttribute('role'), label, textOf(element, 220), selectorFor(element)].filter(Boolean).join(' ');
        const score = lexicalScore(searchText);
        return { element, label, score, interactive: interactive(element) };
      })
      .sort((first, second) => {
        if (requestedQuery && second.score !== first.score) return second.score - first.score;
        if (second.interactive !== first.interactive) return Number(second.interactive) - Number(first.interactive);
        return first.element.compareDocumentPosition(second.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
    const elements = candidates.slice(0, maxResults).map((item) => {
      const element = item.element;
      const base = {
        node_id: idFor(element),
        kind: kindFor(element),
        label: item.label || null,
        box: boxFor(element),
        source: 'dom',
      };
      if (requestedDetail !== 'debug') return base;
      return {
        ...base,
        tagName: element.localName,
        role: element.getAttribute('role'),
        selector: selectorFor(element),
        text: textOf(element, 240) || null,
        interactive: item.interactive,
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        covered: coveredAtCenter(element),
        score: Number(item.score.toFixed(4)),
      };
    });
    const scopeBox = scopeInfo.root && scopeInfo.root !== document ? boxFor(scopeInfo.root) : { x: 0, y: 0, width: innerWidth, height: innerHeight };
    return {
      url: location.href,
      title: document.title,
      query: requestedQuery || null,
      scope: {
        requested: requestedScope,
        mode: scopeInfo.mode,
        selector: requestedSelector,
        node_id: scopeInfo.root && scopeInfo.root !== document ? idFor(scopeInfo.root) : null,
        boundingBox: scopeBox,
        clip: requestedClip,
      },
      totalCandidates: candidates.length,
      returned: elements.length,
      truncated: candidates.length > elements.length,
      elements,
    };
  })()`;
}

export function pageInspectExpression(options = {}) {
  const nodeId = typeof options.nodeId === "string" && options.nodeId.length > 0 ? options.nodeId : null;
  const selector = typeof options.selector === "string" && options.selector.length > 0 ? options.selector : null;
  const depth = Number.isInteger(options.depth) && options.depth >= 0 ? Math.min(options.depth, 4) : 2;
  const maxChildren = Number.isInteger(options.maxChildren) && options.maxChildren > 0 ? Math.min(options.maxChildren, 80) : 30;
  const maxText = Number.isInteger(options.maxText) && options.maxText > 0 ? Math.min(options.maxText, 2000) : 700;
  return `(() => {
    if (!window.__agentBrowserDomNodeMap) window.__agentBrowserDomNodeMap = new Map();
    if (!window.__agentBrowserDomNextNodeId) window.__agentBrowserDomNextNodeId = 1;
    const requestedNodeId = ${JSON.stringify(nodeId)};
    const requestedSelector = ${JSON.stringify(selector)};
    const maxDepth = ${JSON.stringify(depth)};
    const maxChildren = ${JSON.stringify(maxChildren)};
    const maxText = ${JSON.stringify(maxText)};
    const compact = (value, max = 500) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const textOf = (element, max = maxText) => compact(element.innerText || element.value || element.textContent || '', max);
    const textById = (id) => id ? compact((document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || ''), 180) : '';
    const visible = (element) => {
      if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      for (const rect of element.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) return true;
      }
      return false;
    };
    const selectorFor = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      for (let node = element; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
        let part = node.localName;
        if (!part) break;
        const role = node.getAttribute('role');
        if (role && parts.length === 0) part += '[role="' + CSS.escape(role) + '"]';
        if (node.classList.length) part += '.' + [...node.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((sibling) => sibling.localName === node.localName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        if (parts.length >= 5) break;
      }
      return parts.join(' > ');
    };
    const nameFor = (element) => {
      const labelledBy = compact(String(element.getAttribute('aria-labelledby') || '').split(/\\s+/).map(textById).filter(Boolean).join(' '), 180);
      return compact(element.getAttribute('aria-label') || labelledBy || element.getAttribute('placeholder') || element.getAttribute('alt') || element.getAttribute('title') || element.labels?.[0]?.innerText || '', 180);
    };
    const kindFor = (element) => {
      const tag = element.localName;
      const role = element.getAttribute('role');
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'a') return 'link';
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || element.isContentEditable) return 'field';
      if (tag === 'option') return 'option';
      if (tag === 'form') return 'form';
      if (tag === 'main' || tag === 'section' || tag === 'article' || tag === 'nav' || tag === 'aside' || role === 'region') return 'region';
      if (element.hasAttribute('aria-live') || role === 'status' || role === 'alert') return 'status';
      return role || 'element';
    };
    const interactive = (element) => element.matches('a,button,input,textarea,select,[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="combobox"],[tabindex],summary,label,[contenteditable],option');
    const idFor = (element) => {
      for (const [id, mapped] of window.__agentBrowserDomNodeMap) {
        if (mapped === element) return id;
      }
      const id = 'node-' + window.__agentBrowserDomNextNodeId++;
      window.__agentBrowserDomNodeMap.set(id, element);
      return id;
    };
    const boxFor = (element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const styleFor = (element) => {
      const style = getComputedStyle(element);
      return {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        font: compact([style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].filter(Boolean).join(' '), 160),
        border: compact(style.border, 160),
        borderRadius: style.borderRadius,
        padding: style.padding,
        margin: style.margin,
        cursor: style.cursor,
        opacity: style.opacity,
        zIndex: style.zIndex,
      };
    };
    const summaryFor = (element, textMax = 220) => {
      const type = element.getAttribute('type');
      return {
        node_id: idFor(element),
        kind: kindFor(element),
        tagName: element.localName,
        role: element.getAttribute('role'),
        name: nameFor(element) || null,
        text: type === 'password' ? '' : textOf(element, textMax),
        type,
        placeholder: element.getAttribute('placeholder'),
        selector: selectorFor(element),
        boundingBox: boxFor(element),
        inViewport: (() => { const rect = element.getBoundingClientRect(); return rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth; })(),
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        interactive: interactive(element),
        visible: visible(element),
      };
    };
    const childTree = (element, level = 0) => {
      if (level >= maxDepth) return [];
      return [...element.children]
        .filter(visible)
        .slice(0, maxChildren)
        .map((child) => ({
          ...summaryFor(child, 180),
          children: childTree(child, level + 1),
        }));
    };
    const target = requestedNodeId
      ? window.__agentBrowserDomNodeMap.get(requestedNodeId)
      : requestedSelector
        ? document.querySelector(requestedSelector)
        : null;
    if (!target) throw new Error(requestedNodeId ? 'DOM node ID not found in current page map: ' + requestedNodeId : 'Selector not found: ' + requestedSelector);
    const contextRoot = target.closest('main,section,article,form,dialog,nav,aside,[role="main"],[role="region"],[role="dialog"],[role="form"]') || target.parentElement || target;
    const ancestors = [];
    for (let node = target.parentElement; node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement; node = node.parentElement) {
      ancestors.unshift(summaryFor(node, 120));
      if (ancestors.length >= 5) break;
    }
    const siblings = target.parentElement
      ? [...target.parentElement.children].filter((child) => child !== target && visible(child)).slice(0, 12).map((child) => summaryFor(child, 180))
      : [];
    const nearbyInteractives = [...contextRoot.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[tabindex],summary,label,[contenteditable]')]
      .filter((element) => element !== target && visible(element))
      .slice(0, 20)
      .map((element) => summaryFor(element, 180));
    return {
      url: location.href,
      title: document.title,
      requested: { nodeId: requestedNodeId, selector: requestedSelector },
      target: { ...summaryFor(target, maxText), styles: styleFor(target), html: compact(target.outerHTML, 1600) },
      contextRoot: summaryFor(contextRoot, maxText),
      ancestors,
      siblings,
      nearbyInteractives,
      children: childTree(target),
      screenshotClip: boxFor(target),
    };
  })()`;
}

export function domNodeClickTargetExpression(nodeId) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(nodeByIdStrict(${JSON.stringify(nodeId)}));
  })()`;
}

export function domNodeEditableExpression(nodeId, options = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    return prepareEditable(nodeByIdStrict(${JSON.stringify(nodeId)}), ${JSON.stringify(options)});
  })()`;
}

export function selectorClickTargetExpression(selector) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(querySelectorStrict(${JSON.stringify(selector)}));
  })()`;
}

export function selectorEditableExpression(selector, options = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    return prepareEditable(querySelectorStrict(${JSON.stringify(selector)}), ${JSON.stringify(options)});
  })()`;
}

function selectorTextExpression(selector) {
  return `(() => {
    ${interactionHelpersSource()}
    const element = querySelectorStrict(${JSON.stringify(selector)});
    return (element.innerText || element.value || element.textContent || '').trim();
  })()`;
}

function focusedEditableSnapshotExpression(options = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    const element = focusedEditableElement(${JSON.stringify(Boolean(options.includeSelect))});
    if (!element) throw new Error('No editable element is focused');
    const kind = editableKind(element, ${JSON.stringify(Boolean(options.includeSelect))});
    if (kind === 'select' && !${JSON.stringify(Boolean(options.includeSelect))}) throw new Error('Focused element is not text-editable');
    return editableSnapshot(element, kind);
  })()`;
}

function verifyFocusedEditableExpression(before, options = {}) {
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

function setFocusedSelectValueExpression(value) {
  return `(() => {
    ${interactionHelpersSource()}
    return setFocusedSelectValue(${JSON.stringify(value)});
  })()`;
}

function verifyFocusedSelectAllExpression(before) {
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

async function clickPoint(context, tabId, x, y, button = "left") {
  finiteNumber(x, "x");
  finiteNumber(y, "y");
  await activate(context, tabId);
  const base = { x, y, button, clickCount: 1, pointerType: "mouse" };
  await inputGesture(context, tabId, [
    mouseStep({ ...base, type: "mouseMoved", buttons: 0 }, { x, y }),
    mouseStep({ ...base, type: "mousePressed", buttons: mouseButtons(button) }, { x, y }, 16),
    mouseStep({ ...base, type: "mouseReleased", buttons: 0 }, { x, y }, 16),
  ]);
}

async function insertTextAndVerify(context, tabId, before, text, options = {}) {
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

async function fillFocusedEditable(context, tabId, before, value) {
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

async function pressKey(context, tabId, key) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrollPoint(context, tabId, x, y) {
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

function scrollSnapshotExpression(x, y) {
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

function scrollFallbackExpression(x, y, scrollX, scrollY) {
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

function didScroll(before, after) {
  return before?.window?.scrollLeft !== after?.window?.scrollLeft
    || before?.window?.scrollTop !== after?.window?.scrollTop
    || before?.target?.scrollLeft !== after?.target?.scrollLeft
    || before?.target?.scrollTop !== after?.target?.scrollTop;
}

async function scrollTab(context, tabId, args) {
  finiteNumber(args.scrollX, "scrollX");
  finiteNumber(args.scrollY, "scrollY");
  await activate(context, tabId);
  const point = await scrollPoint(context, tabId, args.x, args.y);
  const before = await runtimeEvaluate(context, tabId, scrollSnapshotExpression(point.x, point.y), { timeoutMs: 3000, runtimeTimeoutMs: 1000 });
  await dispatchMouse(context, tabId, {
    type: "mouseWheel",
    x: point.x,
    y: point.y,
    deltaX: args.scrollX,
    deltaY: args.scrollY,
    pointerType: "mouse",
  });
  await sleep(100);
  const afterWheel = await runtimeEvaluate(context, tabId, scrollSnapshotExpression(point.x, point.y), { timeoutMs: 3000, runtimeTimeoutMs: 1000 });
  if (didScroll(before, afterWheel) || (args.scrollX === 0 && args.scrollY === 0)) {
    return { scrolled: didScroll(before, afterWheel), fallbackUsed: false, tabId, ...point, scrollX: args.scrollX, scrollY: args.scrollY, before, after: afterWheel };
  }

  const fallback = await runtimeEvaluate(context, tabId, scrollFallbackExpression(point.x, point.y, args.scrollX, args.scrollY), { timeoutMs: 3000, runtimeTimeoutMs: 1000 });
  return { scrolled: didScroll(fallback.before, fallback.after), fallbackUsed: true, tabId, ...point, scrollX: args.scrollX, scrollY: args.scrollY, before, after: fallback.after };
}

async function waitForPageReady(context, tabId, waitUntil = "domcontentloaded", timeoutMs = 15000) {
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
      async getRequestBody(requestId) {
        return cdp(context, args.tabId, "Network.getRequestPostData", { requestId }, 10000, { profileId });
      },
      async getResponseBody(requestId) {
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
          let extension = null;
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
          let profileId = null;
          const tab = args.tabId
            ? { id: args.tabId }
            : (await extensionProfileRequest(context, "createTab")).result;
          profileId = await resolveSessionProfileId(context);
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
        description: "Capture a PNG screenshot from a Chromium tab via CDP.",
        args: {
          tabId: tool.schema.number().int().positive(),
          fullPage: tool.schema.boolean().default(false),
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
          const params = { format: "png", optimizeForSpeed: true };
          if (args.clip) params.clip = { ...args.clip, scale: args.clip.scale ?? 1 };
          if (args.fullPage) {
            const metrics = await cdp(context, args.tabId, "Page.getLayoutMetrics", {}, args.timeoutMs);
            const size = metrics.contentSize ?? metrics.cssContentSize;
            if (size) {
              params.captureBeyondViewport = true;
              params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
            }
          }
          const result = await cdp(context, args.tabId, "Page.captureScreenshot", params, args.timeoutMs);
          return stringify({ mimeType: "image/png", base64: result.data });
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
          const result = await moveCursor(context, args.tabId, args.x, args.y, { waitForArrival: args.waitForArrival });
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
          await activate(context, args.tabId);
          const base = { x: args.x, y: args.y, button: args.button, pointerType: "mouse" };
          await inputGesture(context, args.tabId, [
            mouseStep({ ...base, type: "mouseMoved", buttons: 0, clickCount: 1 }, { x: args.x, y: args.y }),
            mouseStep({ ...base, type: "mousePressed", buttons: mouseButtons(args.button), clickCount: 1 }, { x: args.x, y: args.y }, 16),
            mouseStep({ ...base, type: "mouseReleased", buttons: 0, clickCount: 1 }, { x: args.x, y: args.y }, 16),
            mouseStep({ ...base, type: "mousePressed", buttons: mouseButtons(args.button), clickCount: 2 }, { x: args.x, y: args.y }, 48),
            mouseStep({ ...base, type: "mouseReleased", buttons: 0, clickCount: 2 }, { x: args.x, y: args.y }, 16),
          ]);
          return stringify({ doubleClicked: true, tabId: args.tabId, x: args.x, y: args.y });
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
          await activate(context, args.tabId);
          const points = interpolatePath(args.path);
          const [start, ...rest] = points;
          const steps = [
            mouseStep({ type: "mouseMoved", x: start.x, y: start.y, button: args.button, buttons: 0, pointerType: "mouse" }, start),
            mouseStep({ type: "mousePressed", x: start.x, y: start.y, button: args.button, buttons: mouseButtons(args.button), clickCount: 1, pointerType: "mouse" }, start, 24),
          ];
          for (const point of rest) {
            steps.push(mouseStep({ type: "mouseMoved", x: point.x, y: point.y, button: args.button, buttons: mouseButtons(args.button), pointerType: "mouse" }, point, 8));
          }
          const end = points.at(-1);
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
        description: "Search the current page with Snowflake retrieval by default and return only relevant actionable page units.",
        args: {
          tabId: tool.schema.number().int().positive(),
          query: tool.schema.string().describe("What to find on the page, such as 'checkout button' or 'repository danger zone'."),
          maxResults: tool.schema.number().int().positive().default(20),
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
          mode: tool.schema.enum(["snowflake", "auto", "deep", "lexical", "hybrid", "semantic"]).default("snowflake"),
          timeoutMs: tool.schema.number().int().positive().default(120000),
        },
        async execute(args, context) {
          const profileId = await resolveSessionProfileId(context);
          markProfileUsed(context, profileId);
          const strategy = args.mode === "hybrid" || args.mode === "semantic" ? "deep" : args.mode;
          const timeoutMs = Math.max(250, Math.min(args.timeoutMs, ["deep", "snowflake"].includes(strategy) ? 120000 : 10000));
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
            query: args.query,
            units: page.units,
            maxResults,
            mode: strategy,
            embeddingCandidates,
            rerankCandidates: args.rerankCandidates,
            pageFingerprint: `${page.url}|${page.title}|${page.units.length}`,
          }), { profileId, timeoutMs });
          return stringify(shapePageSearchRanking({
            url: page.url,
            title: page.title,
            query: args.query,
            scope: page.scope,
            totalCandidates: page.totalCandidates,
            truncated: page.truncated,
            ...ranking,
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
          maxText: tool.schema.number().int().positive().default(700),
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
          const target = await runtimeEvaluate(context, args.tabId, domNodeClickTargetExpression(args.nodeId));
          await clickPoint(context, args.tabId, target.x, target.y);
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
          const target = await runtimeEvaluate(context, args.tabId, selectorClickTargetExpression(args.selector));
          await clickPoint(context, args.tabId, target.x, target.y);
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

      browser_set_file_input: tool({
        description: "Set files on an input[type=file] matched by a CSS selector using CDP.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string().default("input[type=file]"),
          files: tool.schema.array(tool.schema.string()).describe("Absolute file paths to attach"),
        },
        async execute(args, context) {
          validateUploadFiles(args.files);
          await enableCdpDomains(context, args.tabId, ["DOM"], { optional: true });
          const documentResult = await cdp(context, args.tabId, "DOM.getDocument", { depth: 0, pierce: true });
          const queryResult = await cdp(context, args.tabId, "DOM.querySelector", { nodeId: documentResult.root.nodeId, selector: args.selector });
          if (!queryResult.nodeId) throw new Error(`No file input matches selector: ${args.selector}`);
          const description = await cdp(context, args.tabId, "DOM.describeNode", { nodeId: queryResult.nodeId, depth: 0 });
          const attributes = attributesMap(description.node?.attributes);
          if (description.node?.localName !== "input" || String(attributes.get("type") ?? "").toLowerCase() !== "file") {
            throw new Error(`Selector does not match an input[type=file]: ${args.selector}`);
          }
          if (args.files.length > 1 && !attributes.has("multiple")) {
            throw new Error(`File input does not accept multiple files: ${args.selector}`);
          }
          try {
            await cdp(context, args.tabId, "DOM.setFileInputFiles", { nodeId: queryResult.nodeId, files: args.files });
          } catch (error) {
            throw fileUploadError(error);
          }
          return stringify({ set: true, tabId: args.tabId, files: args.files.length });
        },
      }),

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
        },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["Runtime", "Log"], { optional: true });
          const response = await extensionRequest(context, "getCdpEvents", {
            tabId: args.tabId,
            limit: args.limit,
            methods: ["Runtime.consoleAPICalled", "Log.entryAdded"],
          });
          return stringify(compactConsoleEvents(response, { raw: args.raw, includeStack: args.includeStack }));
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
        description: "Read captured Chromium download lifecycle events.",
        args: {
          limit: tool.schema.number().int().positive().default(100),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "getDownloadEvents", { limit: args.limit }));
        },
      }),

      browser_clear_download_events: tool({
        description: "Clear captured Chromium download lifecycle events.",
        args: {},
        async execute(_args, context) {
          return stringify(await extensionRequest(context, "clearDownloadEvents"));
        },
      }),

      browser_cdp: tool({
        description: "Run a raw Chrome DevTools Protocol command against a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          method: tool.schema.string().describe("CDP method, for example Runtime.evaluate"),
          params: tool.schema.record(tool.schema.string(), tool.schema.any()).optional().describe("CDP command parameters as an object."),
          paramsJson: tool.schema.string().optional().describe("CDP command parameters as a JSON object string. Use this if arbitrary object params are not exposed by the client."),
          timeoutMs: tool.schema.number().int().positive().optional(),
        },
        async execute(args, context) {
          return stringify(await cdp(context, args.tabId, args.method, cdpParamsFromArgs(args), args.timeoutMs));
        },
      }),

      browser_turn_end: tool({
        description: "End the current browser turn by detaching debuggers and hiding cursors without closing tabs.",
        args: {},
        async execute(_args, context) {
          const results = {};
          for (const profileId of await targetProfileIdsForSession(context)) {
            results[profileId] = await browserRequest("turnEnded", sessionParams(context, { profile_id: profileId }), { profileId });
            clearSessionCache(context, profileId);
          }
          return stringify({ profiles: results });
        },
      }),

      browser_finalize: tool({
        description: "Close agent-created tabs unless kept; release unkept user-claimed tabs without closing them.",
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
          const keep = args.keep.map((item) => (typeof item === "number" ? { tabId: item, status: "handoff" } : item));
          if (profileIds.length > 1 && keep.some((item) => !item.profileId)) {
            throw new Error("browser_finalize keep items must include profileId when multiple browser profiles were used");
          }

          const results = {};
          for (const profileId of profileIds) {
            const profileKeep = keep
              .filter((item) => !item.profileId || item.profileId === profileId)
              .map(({ tabId, status }) => ({ tabId, status }));
            results[profileId] = await browserRequest("finalizeTabs", sessionParams(context, { profile_id: profileId, keep: profileKeep }), { profileId });
            clearSessionCache(context, profileId);
          }
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
  return { tool: tools };
};

export const createBrowserToolAdapter = createBrowserOperations;

export const GRANULAR_OPERATION_NAMES = Object.freeze([
  "browser_status", "browser_list_profiles", "browser_selected_profile", "browser_select_profile",
  "browser_name_profile", "browser_capabilities", "browser_list_tabs", "browser_selected_tab",
  "browser_get_tab", "browser_new_tab", "browser_claim_tab", "browser_name_session",
  "browser_navigate", "browser_reload", "browser_back", "browser_forward", "browser_close_tab",
  "browser_history", "browser_screenshot", "browser_move", "browser_click", "browser_double_click",
  "browser_scroll", "browser_drag", "browser_type", "browser_keypress", "browser_snapshot",
  "browser_dom_snapshot", "browser_page_search", "browser_visual_map", "browser_page_inspect",
  "browser_dom_click", "browser_dom_type", "browser_locator_count", "browser_locator_click",
  "browser_locator_fill", "browser_locator_text", "browser_set_file_input", "browser_clipboard_read_text",
  "browser_clipboard_write_text", "browser_enable_inspection", "browser_console_logs",
  "browser_network_events", "browser_clear_events", "browser_download_events",
  "browser_clear_download_events", "browser_cdp", "browser_turn_end", "browser_finalize",
]);

export const GRANULAR_OPERATION_COUNT = GRANULAR_OPERATION_NAMES.length;
