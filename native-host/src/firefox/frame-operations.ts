import type { BrowsingContext,Script } from "webdriver-bidi-protocol";
import { frameGeometryFunction } from "../../../src/shared/frame-geometry.ts";
import { bridgedFrameTree } from "./frames.ts";
import type { BidiSend } from "./protocol.ts";

export async function resolveFirefoxFrame(send: BidiSend, root: string, frameId: string) {
  const bridge = await bridgedFrameTree({ send, root, maxDepth: 8, maxFrames: 50 });
  const context = bridge.contexts.get(frameId);
  if (!context) throw Object.assign(new Error("Frame is detached or no longer belongs to this tab."), { code: "FRAME_NOT_FOUND", uncertain: false, executionState: "not_started" });
  return context;
}

export async function verifyFirefoxContext(send: BidiSend, root: string, context: string) {
  const tree = await send("browsingContext.getTree", { root, maxDepth: 8 });
  const pending = [...tree.contexts];
  for (let visited = 0; pending.length && visited < 100; visited++) {
    const frame = pending.shift();
    if (frame?.context === context) return;
    pending.push(...(frame?.children ?? []).slice(0, 50));
  }
  throw Object.assign(new Error("Stale or unowned Firefox frame context"), { code: "STALE_TARGET", uncertain: false, executionState: "not_started" });
}

export async function translateFirefoxPoint(send: BidiSend, root: string, context: string, point: { x: number; y: number }, decode: (value: Script.RemoteValue) => unknown) {
  const tree = await send("browsingContext.getTree", { root, maxDepth: 8 });
  const parents = new Map<string, string>();
  const visit = (frame: BrowsingContext.Info) => { for (const child of frame.children ?? []) { parents.set(child.context, frame.context); visit(child); } };
  for (const frame of tree.contexts) visit(frame);
  for (let depth = 0; context !== root && depth < 8; depth++) {
    const parent = parents.get(context);
    if (!parent) throw Object.assign(new Error("Stale Firefox frame geometry"), { code: "STALE_TARGET", uncertain: false, executionState: "not_started" });
    const located = await send("browsingContext.locateNodes", { context: parent, locator: { type: "context", value: { context } }, maxNodeCount: 1 });
    const owner = located.nodes[0];
    if (!owner?.sharedId) throw Object.assign(new Error("Firefox frame owner is unavailable"), { code: "UNSUPPORTED_FRAME", uncertain: false, executionState: "not_started" });
    const result = await send("script.callFunction", { target: { context: parent }, this: { sharedId: owner.sharedId }, awaitPromise: false,
      functionDeclaration: frameGeometryFunction(),
      arguments: [{ type: "number", value: point.x }, { type: "number", value: point.y }] });
    const value = result.type === "success" ? decode(result.result) as { x?: number; y?: number; clear?: boolean; unsupported?: boolean } : {};
    if (value.unsupported) throw Object.assign(new Error("Rotated or perspective-transformed frame coordinates are unsupported."), { code: "UNSUPPORTED_FRAME", uncertain: false, executionState: "not_started" });
    if (!value.clear || typeof value.x !== "number" || typeof value.y !== "number") throw Object.assign(new Error("Parent frame is clipped or covered by another element."), { code: "FRAME_OBSTRUCTED", uncertain: false, executionState: "not_started" });
    point = { x: value.x, y: value.y };
    context = parent;
  }
  if (context !== root) throw Object.assign(new Error("Frame input exceeds the depth limit"), { code: "UNSUPPORTED_FRAME", uncertain: false, executionState: "not_started" });
  return point;
}
