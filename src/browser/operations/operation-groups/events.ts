import { z } from "zod";
import { SourceMapResolver } from "../../../shared/source-maps.ts";
import { record } from "../../../shared/values.ts";
import { browserRequest } from "../../client.ts";
import { defineBrowserOperation,type BrowserOperationDependencies as Dependencies } from "../../operation-definition.ts";
export { keyDispatchEvents,parseKeyPress } from "../../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from '../inspection-expressions.ts';
export { pageSearchUnitsExpression } from '../snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

const tool = Object.assign(defineBrowserOperation, { schema: z });
export function createEventOperations(dependencies: Dependencies) {
  const { sessionParams, markProfileUsed, resolveSessionProfileId, targetProfileIdsForSession, extensionRequest, clearSessionCache, ensureAttached, executeCdpRequest, cdp, activate, enableInspection, stringify, compactDialogEvents, compactConsoleEvents, cdpParamsFromArgs, sleep, waitForPageReady, fetchConsoleSourceMaps } = dependencies;
  return {
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
            if (!record(results[profileId]).partial) clearSessionCache(context, profileId);
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
  };
}
