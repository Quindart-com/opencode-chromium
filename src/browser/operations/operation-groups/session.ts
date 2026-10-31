import { z } from "zod";
import type { CdpParams } from "../../../shared/cdp.ts";
import { record } from "../../../shared/values.ts";
import { browserRequest,listBrowserProfiles,resolveBrowserProfile } from "../../client.ts";
import { defineBrowserOperation,type BrowserOperationDependencies as Dependencies } from "../../operation-definition.ts";
import { assertNavigationAllowed } from "../../url-policy.ts";
import { pageStateExpression } from '../page-state.ts';
export { keyDispatchEvents,parseKeyPress } from "../../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from '../inspection-expressions.ts';
export { pageSearchUnitsExpression } from '../snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

const tool = Object.assign(defineBrowserOperation, { schema: z });
export function createSessionOperations(dependencies: Dependencies) {
  const { selectedProfilesBySession, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_BASE64_CHARS, screenshotMime, sessionKey, markProfileUsed, resolveSessionProfileId, extensionProfileRequest, extensionRequest, addProfileToTabResult, clearTabCache, clearSessionCache, cdp, enableCdpDomains, activate, stringify, navigateDataUrl, runtimeEvaluate, navigateHistory, waitForPageReady } = dependencies;
  return {
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
        description: "List this session's tabs or ungrouped, unclaimed user tabs available to claim.",
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
        description: "Claim an ungrouped, unclaimed tab by ID after the user's explicit request or permission. Prefer a new tab otherwise.",
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
          const observation = record(await runtimeEvaluate(context, args.tabId, pageStateExpression()));
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
          const current = record(await runtimeEvaluate(context, args.tabId, pageStateExpression()));
          if (current.documentId !== observation.documentId) throw Object.assign(new Error("Document changed while capturing the screenshot. Observe it again."), { code: "STALE_OBSERVATION", uncertain: false, retryable: false });
          return stringify({
            mimeType,
            base64: result.data,
            ...capture,
            observation: { ...observation, scope: args.fullPage ? "document" : "viewport", changedDuringCapture: current.revision !== observation.revision },
            bytes: Math.floor(result.data.length * 0.75),
          });
        },
      }),
  };
}
