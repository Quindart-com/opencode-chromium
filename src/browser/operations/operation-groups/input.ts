import { z } from "zod";
import { cursorActionForTool } from "../../cursor.ts";
import { VIEW_STYLES,layoutScale,projectSnapshot,renderDelta,renderView,type NativeView,type Snapshot } from "../../native-view.ts";
import { defineBrowserOperation,defineObjectOperation,type BrowserOperationDependencies as Dependencies } from "../../operation-definition.ts";
import { pageStateExpression } from '../page-state.ts';
import { domSnapshotExpression } from '../snapshot-expressions.ts';
export { keyDispatchEvents,parseKeyPress } from "../../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from '../inspection-expressions.ts';
export { pageSearchUnitsExpression } from '../snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

const tool = Object.assign(defineBrowserOperation, { schema: z });
export function createInputOperations(dependencies: Dependencies) {
  const views = new Map<string, NativeView>();
  const { sessionKey, fillFocusedEditable, executeCdpRequest, cdp, enableCdpDomains, activate, moveCursor, pointCursor, resolveCursorPoint, inputGesture, mouseButtons, stringify, mouseStep, interpolatePath, runtimeEvaluate, finiteNumber, performClick, cursorEnabled, domNodeHoverTargetExpression, clickAtPointExpression, selectorHoverTargetExpression, focusedEditableSnapshotExpression, focusedEditableTargetExpression, clickPoint, hoverPoint, insertTextAndVerify, pressKey, scrollTab } = dependencies;
  return {
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
          const { inputRoute } = await clickPoint(context, args.tabId, args.x, args.y, { button: args.button });
          return stringify({ clicked: true, tabId: args.tabId, x: args.x, y: args.y, inputRoute });
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
          const { inputRoute } = await performClick(context, args.tabId, (trusted: boolean) => clickAtPointExpression(args.x, args.y, { button: args.button, clickCount: 2, trusted }), { button: args.button, clickCount: 2 });
          return stringify({ doubleClicked: true, tabId: args.tabId, x: args.x, y: args.y, inputRoute });
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
          const { inputRoute } = await hoverPoint(context, args.tabId, point.x, point.y);
          return stringify({ hovered: true, tabId: args.tabId, x: point.x, y: point.y, target: point, inputRoute });
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
          const result = await executeCdpRequest(context, args.tabId, "Page.handleJavaScriptDialog", {
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
          const showCursor = await cursorEnabled(context, args.tabId);
          const points = interpolatePath(args.path);
          const [start, ...rest] = points;
          if (!start) throw new Error("Drag path is empty");
          const steps = [
            mouseStep({ type: "mouseMoved", x: start.x, y: start.y, button: args.button, buttons: 0, pointerType: "mouse" }, showCursor ? start : undefined),
            mouseStep({ type: "mousePressed", x: start.x, y: start.y, button: args.button, buttons: mouseButtons(args.button), clickCount: 1, pointerType: "mouse" }, showCursor ? start : undefined, 24),
          ];
          for (const point of rest) {
            steps.push(mouseStep({ type: "mouseMoved", x: point.x, y: point.y, button: args.button, buttons: mouseButtons(args.button), pointerType: "mouse" }, showCursor ? point : undefined, 8));
          }
          const end = points.at(-1);
          if (!end) throw new Error("Drag path is empty");
          steps.push(mouseStep({ type: "mouseReleased", x: end.x, y: end.y, button: args.button, buttons: 0, clickCount: 1, pointerType: "mouse" }, showCursor ? end : undefined, 16));
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
        description: "Focus an optional target, then dispatch a key press or chord. Without a target, use current focus.",
        args: {
          tabId: tool.schema.number().int().positive(),
          key: tool.schema.string().describe("Key value or chord, such as Enter, Tab, Escape, Control+A, Shift+Tab, or a single character"),
          nodeId: tool.schema.string().optional(), selector: tool.schema.string().optional(),
        },
        async execute(args, context) {
          return stringify(await pressKey(context, args.tabId, args.key, args));
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
      // Cheap settle probe: the mutation observer installed by the page helpers
      // already tracks the age of the last relevant DOM change.
      browser_dom_quiet: defineObjectOperation({
        capabilityOnly: true,
        description: "Report how long the page DOM has been free of relevant mutations.",
        args: { tabId: tool.schema.number().int().positive() },
        async execute(args, context) {
          return runtimeEvaluate(context, args.tabId, pageStateExpression());
        },
      }),
      // Locates a read-view [ref] (a backend node id) through the DOM domain, without page
      // script, scrolling it into view first so the point is current.
      browser_ref_point: defineObjectOperation({
        capabilityOnly: true,
        description: "Return the current click point of a [ref] from the read view, scrolled into view.",
        args: { tabId: tool.schema.number().int().positive(), ref: tool.schema.number().int().positive() },
        async execute(args, context) {
          await enableCdpDomains(context, args.tabId, ["DOM"], { optional: true });
          await cdp(context, args.tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: args.ref }).catch(() => null);
          const quads = await cdp(context, args.tabId, "DOM.getContentQuads", { backendNodeId: args.ref }).then((result: { quads?: number[][] }) => result.quads ?? [], () => [] as number[][]);
          const quad = quads.find((points: number[]) => points.length >= 8 && Math.abs((points[4]! - points[0]!) * (points[5]! - points[1]!)) > 1);
          if (!quad) throw Object.assign(new Error(`[${args.ref}] is no longer on the page or has no size; read the page again.`), { code: "STALE_TARGET", retryable: false });
          const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!], ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!];
          // Wide fields are clicked near their start, like the read view's own points.
          const left = Math.min(...xs), right = Math.max(...xs);
          return { ref: args.ref, x: Math.round(Math.min((left + right) / 2, left + 40)), y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2) };
        },
      }),
      // Clicks a point like a person would, then types into whatever that focused.
      browser_point_type: defineObjectOperation({
        capabilityOnly: true,
        description: "Click a viewport point, then replace or append text in the editable it focused.",
        args: {
          tabId: tool.schema.number().int().positive(),
          x: tool.schema.number(),
          y: tool.schema.number(),
          text: tool.schema.string().default(""),
          mode: tool.schema.enum(["replace", "append", "focus"]).default("replace"),
        },
        async execute(args, context) {
          const { inputRoute } = await clickPoint(context, args.tabId, args.x, args.y, { focusTextControl: true });
          if (args.mode === "focus") return { focused: true, inputRoute };
          const before = await runtimeEvaluate(context, args.tabId, focusedEditableSnapshotExpression());
          // Replacing starts from a full selection (the selectAll editing command, on every platform).
          if (args.mode === "replace" && before?.kind !== "select" && before?.value) await pressKey(context, args.tabId, "Control+A");
          const after = args.mode === "replace" ? await fillFocusedEditable(context, args.tabId, before, args.text) : await insertTextAndVerify(context, args.tabId, before, args.text);
          return { ...(typeof after === "object" && after ? after : {}), inputRoute };
        },
      }),
      // Text view from the browser's DOMSnapshot: no script runs in the page. With
      // delta, a repeat read of the same document returns only what changed.
      browser_read_view: defineObjectOperation({
        capabilityOnly: true,
        description: "Read the page as compact text lines without running page script; repeat reads return changes only.",
        args: {
          tabId: tool.schema.number().int().positive(),
          query: tool.schema.string().optional(),
          scope: tool.schema.enum(["viewport", "page", "target"]).default("viewport"),
          maxChars: tool.schema.number().int().positive().default(3000),
          delta: tool.schema.boolean().default(false),
        },
        async execute(args, context) {
          const key = `${sessionKey(context)}:${args.tabId}`;
          const [snapshot, metrics] = await Promise.all([
            cdp(context, args.tabId, "DOMSnapshot.captureSnapshot", { computedStyles: VIEW_STYLES, includeDOMRects: false }),
            cdp(context, args.tabId, "Page.getLayoutMetrics", {}),
          ]);
          const visual = metrics.cssVisualViewport ?? metrics.cssLayoutViewport;
          const scale = layoutScale((snapshot as unknown as Snapshot).documents[0], metrics.cssContentSize);
          const view = projectSnapshot(snapshot as unknown as Snapshot, { x: visual?.pageX ?? 0, y: visual?.pageY ?? 0, width: visual?.clientWidth ?? 1280, height: visual?.clientHeight ?? 800, scale }, args);
          const comparable = !args.query && args.scope === "viewport";
          const delta = args.delta && comparable ? renderDelta(views.get(key), view) : null;
          if (comparable) { views.delete(key); views.set(key, view); if (views.size > 64) views.delete(views.keys().next().value!); }
          return { url: view.url, title: view.title, view: delta ?? renderView(view), ...(delta ? { delta: true } : {}) };
        },
      }),
  };
}
