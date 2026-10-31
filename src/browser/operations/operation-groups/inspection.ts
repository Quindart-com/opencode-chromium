import { z } from "zod";
import { record } from "../../../shared/values.ts";
import { browserRequest } from "../../client.ts";
import { defineBrowserOperation,type BrowserOperationDependencies as Dependencies } from "../../operation-definition.ts";
import { createFileInputOperation } from "../../uploads.ts";
import { freshSearch } from ".././fresh-search.ts";
import { focusExpression } from '../focus-expressions.ts';
import { pageInspectExpression,visualMapExpression } from '../inspection-expressions.ts';
import { pageStateExpression } from '../page-state.ts';
import { pageSearchUnitsExpression } from '../snapshot-expressions.ts';
export { keyDispatchEvents,parseKeyPress } from "../../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from '../inspection-expressions.ts';
export { pageSearchUnitsExpression } from '../snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

const tool = Object.assign(defineBrowserOperation, { schema: z });
export function createInspectionOperations(dependencies: Dependencies) {
  const { sessionParams, markProfileUsed, resolveSessionProfileId, cdp, enableCdpDomains, activate, pointCursor, resolveCursorPoint, stringify, shapePageSearchRanking, runtimeEvaluate, pageBackend, grantClipboardPermission, shouldRunVisualModel, captureVisualMapScreenshot, mergeVisualMapModelResult, domNodeClickExpression, domNodeEditableExpression, selectorClickExpression, selectorEditableExpression, selectorTextExpression, insertTextAndVerify, fillFocusedEditable } = dependencies;
  return {
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
          const { page, ranking } = await freshSearch(async () => runtimeEvaluate(context, args.tabId, pageSearchUnitsExpression({
            maxUnits,
            scope: args.scope,
            selector: args.selector,
            containerNodeId: args.containerNodeId,
            clip: args.clip,
          }), {
            timeoutMs: Math.min(timeoutMs, 30000),
            runtimeTimeoutMs: 5000,
          }), page => browserRequest("semantic.rankPageUnits", sessionParams(context, {
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
          }), { profileId, timeoutMs }), () => runtimeEvaluate(context, args.tabId, pageStateExpression()));
          return stringify(shapePageSearchRanking({
            observation: page.observation, url: page.url,
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
          const inspectArgs = args;
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
          const target = await pageBackend.click(context, args.tabId, (trusted: boolean) => domNodeClickExpression(args.nodeId, { trusted }));
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
          if (args.mode === "focus") return stringify(await runtimeEvaluate(context, args.tabId, focusExpression({ nodeId: args.nodeId })));
          const before = await runtimeEvaluate(context, args.tabId, domNodeEditableExpression(args.nodeId, {
            selectAll: args.mode === "replace",
            cursorAtEnd: args.mode === "append",
            includeSelect: args.mode === "replace",
          }));
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
          const target = await pageBackend.click(context, args.tabId, (trusted: boolean) => selectorClickExpression(args.selector, { trusted }));
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
          if (args.mode === "focus") return stringify(await runtimeEvaluate(context, args.tabId, focusExpression({ selector: args.selector })));
          const before = await runtimeEvaluate(context, args.tabId, selectorEditableExpression(args.selector, {
            selectAll: args.mode === "replace",
            cursorAtEnd: args.mode === "append",
            includeSelect: args.mode === "replace",
          }));
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
          return stringify(await runtimeEvaluate(context, args.tabId, selectorTextExpression(args.selector)));
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
  };
}
