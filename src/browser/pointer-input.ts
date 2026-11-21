import { z } from "zod";
import type { BrowserContext } from "../core/tool-definition.ts";
import { BrowserRuntimeError } from "../core/errors.ts";
import { isMainFrame } from "./agent-world.ts";

// Genuine pointer input for Chromium main frames. Instead of calling
// element.click() inside the page (isTrusted=false, no preceding pointer
// events), the target point is resolved with a read-only expression and a short
// human-paced mouse path plus press/release is sent through the debugger.
export type InputMode = "auto" | "pointer" | "dom";
export type InputRoute = "pointer" | "dom";
type Point = { x: number; y: number };
type Button = "left" | "middle" | "right";
type GestureStep = { method: string; commandParams: object; cursor?: unknown; delayMs?: number };

const pointSchema = z.looseObject({ x: z.number().finite(), y: z.number().finite() });
const BUTTON_MASK: Record<Button, number> = { left: 1, right: 2, middle: 4 };
const ENGINE_TTL_MS = 30000;

export interface PointerDependencies {
  runtimeEvaluate(context: BrowserContext, tabId: number, expression: string, options?: { userGesture?: boolean }): Promise<unknown>;
  inputGesture(context: BrowserContext, tabId: number, steps: GestureStep[], timeoutMs: number): Promise<unknown>;
  mouseStep(commandParams: object, cursor: unknown, delayMs?: number): GestureStep;
  tabFacts(context: BrowserContext, tabId: number): Promise<{ active: boolean; hostname: string | null } | null>;
  cursorEnabled(context: BrowserContext, tabId: number): Promise<boolean>;
  key(context: BrowserContext, tabId: number): string;
  engine?(context: BrowserContext): Promise<"gecko" | "chromium" | string | undefined>;
  /** Makes the tab the active tab of its window without focusing the window. */
  revealTab?(context: BrowserContext, tabId: number): Promise<unknown>;
  sleep?(ms: number): Promise<void>;
  random?(): number;
}

/** A short eased, slightly curved mouse path with per-step delays, ending exactly on the target. */
export function pointerPath(from: Point, to: Point, random: () => number = Math.random) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const count = Math.max(4, Math.min(14, Math.round(distance / 60) + 4));
  const bend = (random() - 0.5) * Math.min(30, distance * 0.15);
  const normal = distance > 0 ? { x: -(to.y - from.y) / distance, y: (to.x - from.x) / distance } : { x: 0, y: 0 };
  const path: (Point & { delayMs: number })[] = [];
  for (let index = 1; index <= count; index += 1) {
    const progress = index / count;
    const eased = 1 - (1 - progress) * (1 - progress);
    const arc = Math.sin(Math.PI * progress) * bend;
    const last = index === count;
    path.push({
      x: Math.round((from.x + (to.x - from.x) * eased + normal.x * arc + (last ? 0 : (random() - 0.5) * 1.4)) * 10) / 10,
      y: Math.round((from.y + (to.y - from.y) * eased + normal.y * arc + (last ? 0 : (random() - 0.5) * 1.4)) * 10) / 10,
      delayMs: 4 + Math.round(random() * 8),
    });
  }
  const end = path.at(-1);
  if (end) { end.x = to.x; end.y = to.y; }
  return path;
}

/** Decides the route for a main-frame action. Frames and the explicit "dom" mode keep the in-page route. */
export function selectInputRoute({ mode, frame, guarded, active }: { mode?: InputMode; frame?: boolean; guarded: boolean; active: boolean }): InputRoute {
  if (frame || mode === "dom") return "dom";
  if (mode === "pointer") return "pointer";
  return guarded || active ? "pointer" : "dom";
}

export function createPointerInput(dependencies: PointerDependencies) {
  const { runtimeEvaluate, inputGesture, mouseStep, tabFacts, cursorEnabled, key } = dependencies;
  const random = dependencies.random ?? Math.random;
  const lastPoint = new Map<string, Point>();
  const engineCache = new Map<string, { at: number; gecko: boolean }>();

  async function isGecko(context: BrowserContext) {
    if (!dependencies.engine) return false;
    const id = String(context.sessionId ?? context.sessionID ?? context.session_id ?? "");
    const cached = engineCache.get(id);
    if (cached && Date.now() - cached.at < ENGINE_TTL_MS) return cached.gecko;
    const gecko = await dependencies.engine(context).then(engine => engine === "gecko", () => false);
    engineCache.set(id, { at: Date.now(), gecko });
    return gecko;
  }

  async function route(context: BrowserContext, tabId: number): Promise<InputRoute> {
    const frame = !isMainFrame(context);
    const mode = context.inputMode;
    if (frame || mode === "dom") return "dom";
    if (mode === "pointer") return "pointer";
    const facts = await tabFacts(context, tabId);
    const guarded = Boolean(facts?.hostname && context.guardedHosts?.has(facts.hostname));
    return selectInputRoute({ mode, guarded, active: facts?.active === true });
  }

  const origin = (target: Point, from: Point | undefined): Point => from ?? {
    x: Math.max(1, Math.round(target.x - (60 + random() * 100))),
    y: Math.max(1, Math.round(target.y - (30 + random() * 60))),
  };

  // Chromium does not acknowledge debugger mouse events for a hidden page, so a
  // pointer gesture sent to a background tab hangs until its deadline. Reveal the
  // tab first and fail fast, before anything is dispatched, if it stays hidden.
  const visible = async (context: BrowserContext, tabId: number) => await runtimeEvaluate(context, tabId, "document.visibilityState", { userGesture: false }).catch(() => "visible") !== "hidden";
  async function ensureVisible(context: BrowserContext, tabId: number) {
    if (await visible(context, tabId)) return;
    await dependencies.revealTab?.(context, tabId).catch(() => null);
    const wait = dependencies.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await visible(context, tabId)) return;
      await wait(100);
    }
    throw new BrowserRuntimeError("Pointer input needs a visible tab. Bring the agent's browser window to the front, or use inputMode \"dom\".", {
      code: "TAB_NOT_VISIBLE", retryable: true, uncertain: false,
    });
  }

  async function dispatch(context: BrowserContext, tabId: number, steps: GestureStep[]) {
    await ensureVisible(context, tabId);
    await inputGesture(context, tabId, steps, Math.max(1, (context.deadlineAt ?? Date.now() + 10000) - Date.now()));
  }

  async function moveSteps(context: BrowserContext, tabId: number, target: Point) {
    const showCursor = await cursorEnabled(context, tabId);
    const cursorFor = (point: Point) => showCursor ? { x: point.x, y: point.y } : undefined;
    const path = pointerPath(origin(target, lastPoint.get(key(context, tabId))), target, random);
    return { cursorFor, steps: path.map(point => mouseStep({ type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0, pointerType: "mouse" }, cursorFor(point), point.delayMs)) };
  }

  return {
    route,
    isGecko,
    /** Resolves the point with a read-only expression, then moves, presses and releases through the debugger. */
    async click(context: BrowserContext, tabId: number, expression: (trusted: boolean) => string, options: { button?: Button; clickCount?: number; skip?(point: Record<string, unknown>): boolean } = {}) {
      const point = pointSchema.parse(await runtimeEvaluate(context, tabId, expression(true), { userGesture: true }));
      if (options.skip?.(point)) return point;
      const button = options.button ?? "left";
      const mask = BUTTON_MASK[button];
      const { cursorFor, steps } = await moveSteps(context, tabId, point);
      const at = { x: point.x, y: point.y };
      for (let count = 1; count <= Math.max(1, options.clickCount ?? 1); count += 1) {
        steps.push(mouseStep({ type: "mousePressed", x: at.x, y: at.y, button, buttons: mask, clickCount: count, pointerType: "mouse" }, cursorFor(at), 25 + Math.round(random() * 40)));
        steps.push(mouseStep({ type: "mouseReleased", x: at.x, y: at.y, button, buttons: 0, clickCount: count, pointerType: "mouse" }, cursorFor(at), count < (options.clickCount ?? 1) ? 40 + Math.round(random() * 50) : 0));
      }
      await dispatch(context, tabId, steps);
      lastPoint.set(key(context, tabId), at);
      return point;
    },
    /** Moves the real pointer over an already resolved point without pressing. */
    async hover<T extends Point | null>(context: BrowserContext, tabId: number, target: T): Promise<T> {
      if (!target) return target;
      const { steps } = await moveSteps(context, tabId, target);
      await dispatch(context, tabId, steps);
      lastPoint.set(key(context, tabId), { x: target.x, y: target.y });
      return target;
    },
    lastPoint: (context: BrowserContext, tabId: number) => lastPoint.get(key(context, tabId)),
  };
}
export type PointerInput = ReturnType<typeof createPointerInput>;
