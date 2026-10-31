import { z } from "zod";
import { cursorActionForTool } from "../../cursor.ts";
import { defineBrowserOperation,type BrowserOperationDependencies as Dependencies } from "../../operation-definition.ts";
import { domSnapshotExpression } from '../snapshot-expressions.ts';
export { keyDispatchEvents,parseKeyPress } from "../../keyboard.ts";
export { pageInspectExpression,visualMapExpression } from '../inspection-expressions.ts';
export { pageSearchUnitsExpression } from '../snapshot-expressions.ts';

// The browser operation engine is intentionally adapter-neutral. MCP, OpenCode,
// and direct SDK adapters all consume this same operation registry.

const tool = Object.assign(defineBrowserOperation, { schema: z });
export function createInputOperations(dependencies: Dependencies) {
  const { executeCdpRequest, cdp, enableCdpDomains, activate, moveCursor, pointCursor, resolveCursorPoint, inputGesture, mouseButtons, stringify, mouseStep, interpolatePath, runtimeEvaluate, finiteNumber, pageBackend, domNodeHoverTargetExpression, clickAtPointExpression, selectorHoverTargetExpression, focusedEditableSnapshotExpression, focusedEditableTargetExpression, clickPoint, hoverPoint, insertTextAndVerify, pressKey, scrollTab } = dependencies;
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
          const point = await resolveCursorPoint(context, args.tabId, args);
          if (point) await pointCursor(context, args.tabId, point, "click");
          await activate(context, args.tabId);
          await pageBackend.click(context, args.tabId, (trusted: boolean) => clickAtPointExpression(args.x, args.y, { button: args.button, clickCount: 2, trusted }), { button: args.button, clickCount: 2 });
          return stringify({ doubleClicked: true, tabId: args.tabId, x: args.x, y: args.y });
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
          await hoverPoint(context, args.tabId, point.x, point.y);
          return stringify({ hovered: true, tabId: args.tabId, x: point.x, y: point.y, target: point });
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
          const points = interpolatePath(args.path);
          const [start, ...rest] = points;
          if (!start) throw new Error("Drag path is empty");
          const steps = [
            mouseStep({ type: "mouseMoved", x: start.x, y: start.y, button: args.button, buttons: 0, pointerType: "mouse" }, start),
            mouseStep({ type: "mousePressed", x: start.x, y: start.y, button: args.button, buttons: mouseButtons(args.button), clickCount: 1, pointerType: "mouse" }, start, 24),
          ];
          for (const point of rest) {
            steps.push(mouseStep({ type: "mouseMoved", x: point.x, y: point.y, button: args.button, buttons: mouseButtons(args.button), pointerType: "mouse" }, point, 8));
          }
          const end = points.at(-1);
          if (!end) throw new Error("Drag path is empty");
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
  };
}
