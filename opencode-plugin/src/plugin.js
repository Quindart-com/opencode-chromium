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
          return stringify(await browserRequest("host.status"));
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
          const result = await cdp(context, args.tabId, "Page.captureScreenshot", { format: "png" });
          return stringify({ mimeType: "image/png", base64: result.data });
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
          const base = { x: args.x, y: args.y, button: args.button, clickCount: 1 };
          await cdp(context, args.tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
          await cdp(context, args.tabId, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
          await cdp(context, args.tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
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
          await cdp(context, args.tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: args.key });
          await cdp(context, args.tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: args.key });
          return stringify({ pressed: args.key, tabId: args.tabId });
        },
      }),

      browser_snapshot: tool({
        description: "Get a Chromium accessibility tree snapshot for a tab.",
        args: {
          tabId: tool.schema.number().int().positive(),
        },
        async execute(args, context) {
          const result = await cdp(context, args.tabId, "Accessibility.getFullAXTree", {});
          return stringify(result);
        },
      }),

      browser_finalize: tool({
        description: "Close controlled tabs unless their IDs are explicitly kept.",
        args: {
          keep: tool.schema.array(tool.schema.number().int().positive()).default([]),
        },
        async execute(args, context) {
          const keep = args.keep.map((tabId) => ({ tabId, status: "handoff" }));
          return stringify(await browserRequest("finalizeTabs", sessionParams(context, { keep })));
        },
      }),
    },
  };
};
