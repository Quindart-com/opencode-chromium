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

async function cdp(context, tabId, method, commandParams = {}, timeoutMs) {
  if (method !== "Target.getTargets") {
    await extensionRequest(context, "attach", { tabId });
    if (method === "Performance.getMetrics") {
      await browserRequest(
        "executeCdp",
        sessionParams(context, {
          target: { tabId },
          method: "Performance.enable",
          commandParams: {},
          timeoutMs,
        }),
      ).catch(() => {});
    }
  }
  return browserRequest(
    "executeCdp",
    sessionParams(context, {
      target: { tabId },
      method,
      commandParams,
      timeoutMs,
    }),
  );
}

async function activate(context, tabId) {
  return extensionRequest(context, "activateTab", { tabId }).catch(() => null);
}

async function moveCursor(context, tabId, x, y, options = {}) {
  return extensionRequest(context, "moveMouse", { tabId, x, y, ...options }).catch(() => null);
}

async function inputGesture(context, tabId, steps, timeoutMs) {
  return extensionRequest(context, "inputGesture", { tabId, steps, timeoutMs });
}

async function enableInspection(context, tabId) {
  await cdp(context, tabId, "Page.enable", {}).catch(() => {});
  await cdp(context, tabId, "Runtime.enable", {}).catch(() => {});
  await cdp(context, tabId, "Log.enable", {}).catch(() => {});
  await cdp(context, tabId, "Network.enable", {}).catch(() => {});
  await cdp(context, tabId, "Performance.enable", {}).catch(() => {});
  await cdp(context, tabId, "DOM.enable", {}).catch(() => {});
  await cdp(context, tabId, "Accessibility.enable", {}).catch(() => {});
}

function mouseButtons(button) {
  if (button === "right") return 2;
  if (button === "middle") return 4;
  return 1;
}

function keyEventParams(key) {
  const special = {
    Enter: { windowsVirtualKeyCode: 13, code: "Enter" },
    Tab: { windowsVirtualKeyCode: 9, code: "Tab" },
    Escape: { windowsVirtualKeyCode: 27, code: "Escape" },
    Backspace: { windowsVirtualKeyCode: 8, code: "Backspace" },
    Delete: { windowsVirtualKeyCode: 46, code: "Delete" },
    ArrowUp: { windowsVirtualKeyCode: 38, code: "ArrowUp" },
    ArrowDown: { windowsVirtualKeyCode: 40, code: "ArrowDown" },
    ArrowLeft: { windowsVirtualKeyCode: 37, code: "ArrowLeft" },
    ArrowRight: { windowsVirtualKeyCode: 39, code: "ArrowRight" },
    Home: { windowsVirtualKeyCode: 36, code: "Home" },
    End: { windowsVirtualKeyCode: 35, code: "End" },
    PageUp: { windowsVirtualKeyCode: 33, code: "PageUp" },
    PageDown: { windowsVirtualKeyCode: 34, code: "PageDown" },
  };
  const base = special[key] ?? {};
  return { key, text: key.length === 1 ? key : undefined, ...base };
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
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

function interpolatePath(points, maxStep = 6) {
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
  await enableInspection(context, tabId);
  const result = await cdp(context, tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture !== false,
  }, options.timeoutMs);
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? "Runtime.evaluate failed";
    throw new Error(message);
  }
  return result.result?.value;
}

async function navigateHistory(context, tabId, delta) {
  await enableInspection(context, tabId);
  const history = await cdp(context, tabId, "Page.getNavigationHistory", {});
  const targetIndex = history.currentIndex + delta;
  const entry = history.entries?.[targetIndex];
  if (!entry) throw new Error(delta < 0 ? "No previous history entry" : "No next history entry");
  await cdp(context, tabId, "Page.navigateToHistoryEntry", { entryId: entry.id });
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
    window.__opencodeDomNodeMap = window.__opencodeDomNodeMap || new Map();
    window.__opencodeDomNextNodeId = window.__opencodeDomNextNodeId || 1;
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
    const nameFor = (element) => element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || element.labels?.[0]?.innerText || '';
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex],summary,label,[contenteditable="true"]')]
      .filter(visible)
      .slice(0, 500)
      .map((element) => {
        let id = element.getAttribute('data-opencode-node-id');
        if (!id) {
          id = 'node-' + window.__opencodeDomNextNodeId++;
          element.setAttribute('data-opencode-node-id', id);
        }
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
          disabled: Boolean(element.disabled),
        };
      });
    return { url: location.href, title: document.title, nodes };
  })()`;
}

function domNodeActionExpression(nodeId, action, text) {
  return `(() => {
    const node = window.__opencodeDomNodeMap && window.__opencodeDomNodeMap.get(${JSON.stringify(nodeId)});
    if (!node) throw new Error('Unknown DOM node id. Take a fresh browser_dom_snapshot first.');
    node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (${JSON.stringify(action)} === 'click') {
      node.click();
      return true;
    }
    if (${JSON.stringify(action)} === 'type') {
      node.focus();
      const value = ${JSON.stringify(text ?? "")};
      if ('value' in node) {
        node.value += value;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        node.textContent = (node.textContent || '') + value;
        node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      }
      return true;
    }
    throw new Error('Unsupported DOM action');
  })()`;
}

function selectorExpression(selector, action, value) {
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const element = document.querySelector(selector);
    if (!element) throw new Error('No element matches selector: ' + selector);
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (${JSON.stringify(action)} === 'click') {
      element.click();
      return true;
    }
    if (${JSON.stringify(action)} === 'fill') {
      element.focus();
      const value = ${JSON.stringify(value ?? "")};
      if ('value' in element) {
        element.value = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        element.textContent = value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: value }));
      }
      return true;
    }
    if (${JSON.stringify(action)} === 'text') {
      return (element.innerText || element.value || element.textContent || '').trim();
    }
    throw new Error('Unsupported selector action');
  })()`;
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
        },
        async execute(args, context) {
          const tab = args.tabId
            ? { id: args.tabId }
            : await browserRequest("createTab", sessionParams(context));
          await activate(context, tab.id);
          if (args.url.toLowerCase().startsWith("data:")) {
            return stringify(await navigateDataUrl(context, tab.id, args.url));
          }
          await cdp(context, tab.id, "Network.enable", {}).catch(() => {});
          await cdp(context, tab.id, "Page.navigate", { url: args.url });
          return stringify({ tabId: tab.id, url: args.url });
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
          return stringify(await extensionRequest(context, "closeTab", { tabId: args.tabId }));
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
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          await cdp(context, args.tabId, "Page.enable", {}).catch(() => {});
          const params = { format: "png" };
          if (args.clip) params.clip = { ...args.clip, scale: args.clip.scale ?? 1 };
          if (args.fullPage) {
            const metrics = await cdp(context, args.tabId, "Page.getLayoutMetrics", {});
            const size = metrics.contentSize ?? metrics.cssContentSize;
            if (size) {
              params.captureBeyondViewport = true;
              params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
            }
          }
          const result = await cdp(context, args.tabId, "Page.captureScreenshot", params);
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
          const base = { x: args.x, y: args.y, button: args.button, clickCount: 1, pointerType: "mouse" };
          await inputGesture(context, args.tabId, [
            mouseStep({ ...base, type: "mouseMoved", buttons: 0 }, { x: args.x, y: args.y }),
            mouseStep({ ...base, type: "mousePressed", buttons: mouseButtons(args.button) }, { x: args.x, y: args.y }, 16),
            mouseStep({ ...base, type: "mouseReleased", buttons: 0 }, { x: args.x, y: args.y }, 16),
          ]);
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
          await inputGesture(context, args.tabId, steps);
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
          await cdp(context, args.tabId, "Input.insertText", { text: args.text });
          return stringify({ typed: true, tabId: args.tabId, length: args.text.length });
        },
      }),

      browser_keypress: tool({
        description: "Dispatch a basic key press in a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          key: tool.schema.string().describe("Key value, such as Enter, Tab, Escape, or a single character"),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          const params = keyEventParams(args.key);
          await cdp(context, args.tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...params });
          await cdp(context, args.tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params, text: undefined });
          return stringify({ pressed: args.key, tabId: args.tabId });
        },
      }),

      browser_snapshot: tool({
        description: "Get a Chromium accessibility tree snapshot for a tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          await enableInspection(context, args.tabId);
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
          return stringify({ clicked: await runtimeEvaluate(context, args.tabId, domNodeActionExpression(args.nodeId, "click")) });
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
          return stringify({ typed: await runtimeEvaluate(context, args.tabId, domNodeActionExpression(args.nodeId, "type", args.text)) });
        },
      }),

      browser_locator_count: tool({
        description: "Count elements matching a CSS selector in a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string(),
        },
        async execute(args, context) {
          const count = await runtimeEvaluate(context, args.tabId, `document.querySelectorAll(${JSON.stringify(args.selector)}).length`);
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
          return stringify({ clicked: await runtimeEvaluate(context, args.tabId, selectorExpression(args.selector, "click")) });
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
          return stringify({ filled: await runtimeEvaluate(context, args.tabId, selectorExpression(args.selector, "fill", args.value)) });
        },
      }),

      browser_locator_text: tool({
        description: "Read text from the first element matching a CSS selector in a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          selector: tool.schema.string(),
        },
        async execute(args, context) {
          return stringify({ text: await runtimeEvaluate(context, args.tabId, selectorExpression(args.selector, "text")) });
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
          await enableInspection(context, args.tabId);
          const documentResult = await cdp(context, args.tabId, "DOM.getDocument", { depth: -1, pierce: true });
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
          await enableInspection(context, args.tabId);
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
          await enableInspection(context, args.tabId);
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
          params: tool.schema.record(tool.schema.string(), tool.schema.any()).default({}),
          timeoutMs: tool.schema.number().int().positive().optional(),
        },
        async execute(args, context) {
          return stringify(await cdp(context, args.tabId, args.method, args.params, args.timeoutMs));
        },
      }),

      browser_turn_end: tool({
        description: "End the current browser turn by detaching debuggers and hiding cursors without closing tabs.",
        args: {},
        async execute(_args, context) {
          return stringify(await extensionRequest(context, "turnEnded"));
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
          return stringify(await browserRequest("finalizeTabs", sessionParams(context, { keep })));
        },
      }),
    },
  };
};
