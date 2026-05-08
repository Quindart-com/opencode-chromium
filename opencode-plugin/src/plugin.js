import { tool } from "@opencode-ai/plugin";
import { browserRequest } from "./client.js";

function sessionParams(context, params = {}) {
  return {
    session_id: context.sessionID ?? "opencode",
    ...params,
  };
}

function cdp(context, tabId, method, commandParams = {}, timeoutMs) {
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

function extensionRequest(context, method, params = {}) {
  return browserRequest(method, sessionParams(context, params));
}

async function activate(context, tabId) {
  return extensionRequest(context, "activateTab", { tabId }).catch(() => null);
}

async function moveCursor(context, tabId, x, y) {
  return extensionRequest(context, "moveMouse", { tabId, x, y }).catch(() => null);
}

async function enableInspection(context, tabId) {
  await cdp(context, tabId, "Page.enable", {}).catch(() => {});
  await cdp(context, tabId, "Runtime.enable", {}).catch(() => {});
  await cdp(context, tabId, "Log.enable", {}).catch(() => {});
  await cdp(context, tabId, "Network.enable", {}).catch(() => {});
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
  };
  const base = special[key] ?? {};
  return { key, text: key.length === 1 ? key : undefined, ...base };
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
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

      browser_navigate: tool({
        description: "Navigate a controlled Chromium tab to a URL. Creates a tab when tabId is omitted.",
        args: {
          url: tool.schema.string().url().describe("Destination URL"),
          tabId: tool.schema.number().int().positive().optional().describe("Existing tab ID"),
        },
        async execute(args, context) {
          const tab = args.tabId
            ? { id: args.tabId }
            : await browserRequest("createTab", sessionParams(context));
          await activate(context, tab.id);
          await cdp(context, tab.id, "Page.navigate", { url: args.url });
          return stringify({ tabId: tab.id, url: args.url });
        },
      }),

      browser_screenshot: tool({
        description: "Capture a PNG screenshot from a Chromium tab via CDP.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          await activate(context, args.tabId);
          const result = await cdp(context, args.tabId, "Page.captureScreenshot", { format: "png" });
          return stringify({ mimeType: "image/png", base64: result.data });
        },
      }),

      browser_move: tool({
        description: "Move the visible OpenCode cursor overlay in a Chromium tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          x: tool.schema.number(),
          y: tool.schema.number(),
        },
        async execute(args, context) {
          const result = await moveCursor(context, args.tabId, args.x, args.y);
          return stringify({ moved: true, visibleCursor: result !== null, tabId: args.tabId, x: args.x, y: args.y });
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
          await moveCursor(context, args.tabId, args.x, args.y);
          const base = { x: args.x, y: args.y, button: args.button, clickCount: 1, pointerType: "mouse" };
          await cdp(context, args.tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 });
          await cdp(context, args.tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", buttons: mouseButtons(args.button) });
          await cdp(context, args.tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 });
          return stringify({ clicked: true, tabId: args.tabId, x: args.x, y: args.y });
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

      browser_enable_inspection: tool({
        description: "Enable CDP Runtime, Log, Network, and Page inspection domains for a tab.",
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

      browser_cdp: tool({
        description: "Run a raw Chrome DevTools Protocol command against a controlled tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
          method: tool.schema.string().describe("CDP method, for example Runtime.evaluate"),
          params: tool.schema.record(tool.schema.any()).default({}),
        },
        async execute(args, context) {
          return stringify(await cdp(context, args.tabId, args.method, args.params));
        },
      }),

      browser_finalize: tool({
        description: "Close controlled tabs unless their IDs are explicitly kept.",
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
