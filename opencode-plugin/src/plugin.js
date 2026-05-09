import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { tool } from "@opencode-ai/plugin";
import { browserRequest } from "./client.js";

function contextValue(context, keys) {
  for (const key of keys) {
    if (context?.[key] !== undefined && context?.[key] !== null) return String(context[key]);
  }
  return null;
}

function sessionParams(context, params = {}) {
  const sessionId = contextValue(context, ["sessionID", "sessionId", "session_id"]) ?? "opencode";
  const turnId = contextValue(context, ["messageID", "messageId", "turnID", "turnId", "requestID", "requestId"])
    ?? sessionId;
  return {
    session_id: sessionId,
    turn_id: turnId,
    ...params,
  };
}

function extensionRequest(context, method, params = {}) {
  return browserRequest(method, sessionParams(context, params));
}

const attachedTabKeys = new Set();
const enabledDomainsByTabKey = new Map();

function tabCacheKey(context, tabId) {
  return `${contextValue(context, ["sessionID", "sessionId", "session_id"]) ?? "opencode"}:${tabId}`;
}

function clearTabCache(context, tabId) {
  const key = tabCacheKey(context, tabId);
  attachedTabKeys.delete(key);
  enabledDomainsByTabKey.delete(key);
}

function clearSessionCache(context) {
  const prefix = `${contextValue(context, ["sessionID", "sessionId", "session_id"]) ?? "opencode"}:`;
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

async function ensureAttached(context, tabId) {
  const key = tabCacheKey(context, tabId);
  if (attachedTabKeys.has(key)) return;
  await extensionRequest(context, "attach", { tabId });
  attachedTabKeys.add(key);
}

function isDebuggerDetachedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /debugger unattached|not attached/i.test(message);
}

function executeCdpRequest(context, tabId, method, commandParams = {}, timeoutMs) {
  return browserRequest(
    "executeCdp",
    sessionParams(context, {
      target: { tabId },
      method,
      commandParams,
      timeoutMs,
    }),
    cdpRequestOptions(timeoutMs),
  );
}

async function cdp(context, tabId, method, commandParams = {}, timeoutMs) {
  if (method === "Target.getTargets") return executeCdpRequest(context, tabId, method, commandParams, timeoutMs);

  await ensureAttached(context, tabId);
  if (method === "Performance.getMetrics") await enableCdpDomains(context, tabId, ["Performance"]);

  try {
    return await executeCdpRequest(context, tabId, method, commandParams, timeoutMs);
  } catch (error) {
    if (!isDebuggerDetachedError(error)) throw error;
    clearTabCache(context, tabId);
    await ensureAttached(context, tabId);
    return executeCdpRequest(context, tabId, method, commandParams, timeoutMs);
  }
}

async function enableCdpDomains(context, tabId, domains, options = {}) {
  const key = tabCacheKey(context, tabId);
  const enabled = enabledDomainsByTabKey.get(key) ?? new Set();

  for (const domain of domains) {
    if (enabled.has(domain)) continue;
    try {
      await cdp(context, tabId, `${domain}.enable`, {});
      enabled.add(domain);
    } catch (error) {
      if (!options.optional) throw error;
    }
  }

  enabledDomainsByTabKey.set(key, enabled);
}

async function activate(context, tabId) {
  return extensionRequest(context, "activateTab", { tabId }).catch(() => null);
}

async function moveCursor(context, tabId, x, y, options = {}) {
  return extensionRequest(context, "moveMouse", { tabId, x, y, ...options }).catch(() => null);
}

async function inputGesture(context, tabId, steps, timeoutMs) {
  return browserRequest(
    "inputGesture",
    sessionParams(context, { tabId, steps, timeoutMs }),
    { timeoutMs: Math.max(timeoutMs ?? 0, 30000) },
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

function normalizeKeyName(key) {
  return KEY_NAME_ALIASES[key] ?? key;
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
    return new Error('File upload was blocked by Chrome. In chrome://extensions, open Details for the OpenCode Browser extension and enable "Allow access to file URLs."');
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
      const node = window.__opencodeDomNodeMap && window.__opencodeDomNodeMap.get(nodeId);
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

    const editableSnapshot = (element, kind) => {
      const value = editableValue(element, kind);
      const selection = window.getSelection();
      return {
        kind,
        tagName: element.localName,
        type: element.getAttribute('type'),
        value,
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
      if (Number(style.opacity) === 0) throw new Error('Element is not visible: opacity is 0: ' + describeElement(element));

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
      const x = Math.floor(rect.left + rect.width / 2);
      const y = Math.floor(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      if (!hit || !composedContains(element, hit)) {
        throw new Error('Element is not clickable: center point is covered by ' + describeElement(hit) + ': ' + describeElement(element));
      }
      return { x, y, tagName: element.localName, text: (element.innerText || element.value || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160) };
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

function domSnapshotExpression() {
  return `(() => {
    window.__opencodeDomNodeMap = new Map();
    window.__opencodeDomNextNodeId = 1;
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
        const id = 'node-' + window.__opencodeDomNextNodeId++;
        window.__opencodeDomNodeMap.set(id, element);
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

function domNodeClickTargetExpression(nodeId) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(nodeByIdStrict(${JSON.stringify(nodeId)}));
  })()`;
}

function domNodeEditableExpression(nodeId, options = {}) {
  return `(() => {
    ${interactionHelpersSource()}
    return prepareEditable(nodeByIdStrict(${JSON.stringify(nodeId)}), ${JSON.stringify(options)});
  })()`;
}

function selectorClickTargetExpression(selector) {
  return `(() => {
    ${interactionHelpersSource()}
    return clickTarget(querySelectorStrict(${JSON.stringify(selector)}));
  })()`;
}

function selectorEditableExpression(selector, options = {}) {
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
  if (text.length > 0) await cdp(context, tabId, "Input.insertText", { text });
  return runtimeEvaluate(context, tabId, verifyFocusedEditableExpression(before, {
    insertedText: text,
    expectedValue: options.expectedValue,
    includeSelect: options.includeSelect,
  }));
}

async function fillFocusedEditable(context, tabId, before, value) {
  if (before.kind === "select") {
    const after = await runtimeEvaluate(context, tabId, setFocusedSelectValueExpression(value));
    return { filled: true, tabId, kind: after.kind, value: after.value };
  }

  if (value.length === 0 && before.value.length > 0) {
    const parsed = parseKeyPress("Backspace");
    for (const event of keyDispatchEvents(parsed)) await cdp(context, tabId, "Input.dispatchKeyEvent", event);
    const after = await runtimeEvaluate(context, tabId, verifyFocusedEditableExpression(before, { expectedValue: "" }));
    return { filled: true, tabId, kind: after.kind, value: after.value };
  }

  const after = await insertTextAndVerify(context, tabId, before, value, { expectedValue: value });
  return { filled: true, tabId, kind: after.kind, value: after.value };
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

export const ChromiumBrowserPlugin = async () => {
  return {
    tool: {
      browser_status: tool({
        description: "Check the OpenCode browser native host connection status.",
        args: {},
        async execute() {
          const host = await browserRequest("host.status");
          let extension = null;
          try {
            extension = {
              ping: await browserRequest("ping"),
              info: await browserRequest("getInfo"),
            };
          } catch (error) {
            extension = { error: error instanceof Error ? error.message : String(error) };
          }
          return stringify({ host, extension });
        },
      }),

      browser_capabilities: tool({
        description: "List capabilities advertised by the OpenCode Browser extension.",
        args: {},
        async execute() {
          return stringify(await browserRequest("getInfo"));
        },
      }),

      browser_list_tabs: tool({
        description: "List Chromium tabs available to OpenCode or all user tabs.",
        args: {
          scope: tool.schema.enum(["session", "user"]).default("user"),
        },
        async execute(args, context) {
          const method = args.scope === "session" ? "getTabs" : "getUserTabs";
          return stringify(await browserRequest(method, sessionParams(context)));
        },
      }),

      browser_selected_tab: tool({
        description: "Return the current logical tab selected for this browser session.",
        args: {},
        async execute(_args, context) {
          return stringify(await extensionRequest(context, "getSelectedTab"));
        },
      }),

      browser_get_tab: tool({
        description: "Get metadata for a controlled Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          return stringify(await extensionRequest(context, "getTab", { tabId: args.tabId }));
        },
      }),

      browser_new_tab: tool({
        description: "Create a new Chromium tab controlled by OpenCode.",
        args: {},
        async execute(_args, context) {
          return stringify(await browserRequest("createTab", sessionParams(context)));
        },
      }),

      browser_claim_tab: tool({
        description: "Claim an existing Chromium tab by tab ID so OpenCode can control it.",
        args: {
          tabId: tool.schema.number().int().positive().describe("Chrome tab ID to claim"),
        },
        async execute(args, context) {
          return stringify(await browserRequest("claimUserTab", sessionParams(context, { tabId: args.tabId })));
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
          const tab = args.tabId
            ? { id: args.tabId }
            : await browserRequest("createTab", sessionParams(context));
          await activate(context, tab.id);
          if (args.url.toLowerCase().startsWith("data:")) {
            const result = await navigateDataUrl(context, tab.id, args.url);
            const readiness = await waitForPageReady(context, tab.id, args.waitUntil, args.timeoutMs);
            return stringify({ ...result, readiness });
          }
          await enableCdpDomains(context, tab.id, ["Page"], { optional: true });
          await cdp(context, tab.id, "Page.navigate", { url: args.url }, args.timeoutMs);
          const readiness = await waitForPageReady(context, tab.id, args.waitUntil, args.timeoutMs);
          return stringify({ tabId: tab.id, url: args.url, readiness });
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
          x: tool.schema.number().default(0),
          y: tool.schema.number().default(0),
          scrollX: tool.schema.number().default(0),
          scrollY: tool.schema.number().default(0),
        },
        async execute(args, context) {
          finiteNumber(args.x, "x");
          finiteNumber(args.y, "y");
          finiteNumber(args.scrollX, "scrollX");
          finiteNumber(args.scrollY, "scrollY");
          await activate(context, args.tabId);
          await dispatchMouse(context, args.tabId, {
            type: "mouseWheel",
            x: args.x,
            y: args.y,
            deltaX: args.scrollX,
            deltaY: args.scrollY,
            pointerType: "mouse",
          });
          return stringify({ scrolled: true, tabId: args.tabId, scrollX: args.scrollX, scrollY: args.scrollY });
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
        description: "Type text into a DOM node ID returned by browser_dom_snapshot.",
        args: {
          tabId: tool.schema.number().int().positive(),
          nodeId: tool.schema.string(),
          text: tool.schema.string(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          const before = await runtimeEvaluate(context, args.tabId, domNodeEditableExpression(args.nodeId, { cursorAtEnd: true }));
          const after = await insertTextAndVerify(context, args.tabId, before, args.text);
          return stringify({ typed: true, tabId: args.tabId, nodeId: args.nodeId, length: args.text.length, kind: after.kind, valueLength: after.value.length });
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
        description: "Fill the first element matching a CSS selector in a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string(),
          value: tool.schema.string(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          const before = await runtimeEvaluate(context, args.tabId, selectorEditableExpression(args.selector, { selectAll: true, includeSelect: true }));
          return stringify(await fillFocusedEditable(context, args.tabId, before, args.value));
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
        description: "Read captured console and log events from a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          limit: tool.schema.number().int().positive().default(100),
        },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["Runtime", "Log"], { optional: true });
          return stringify(await extensionRequest(context, "getCdpEvents", {
            tabId: args.tabId,
            limit: args.limit,
            methods: ["Runtime.consoleAPICalled", "Log.entryAdded"],
          }));
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
          const result = await extensionRequest(context, "turnEnded");
          clearSessionCache(context);
          return stringify(result);
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
              }),
            ]),
          ).default([]),
        },
        async execute(args, context) {
          const keep = args.keep.map((item) => (typeof item === "number" ? { tabId: item, status: "handoff" } : item));
          const result = await browserRequest("finalizeTabs", sessionParams(context, { keep }));
          clearSessionCache(context);
          return stringify(result);
        },
      }),
    },
  };
};
