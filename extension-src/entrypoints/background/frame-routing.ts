import type { Browser } from "wxt/browser";
import { beforeDeadline } from "../../../src/shared/deadline.ts";
import { frameGeometryFunction } from "../../../src/shared/frame-geometry.ts";
import { record } from "../../../src/shared/values.ts";

type Route = { frameId: string; parentId: string | null; url: string; sessionId?: string; contextId?: number };
type Send = (tabId: number, method: string, params: object, timeoutMs?: number, sessionId?: string) => Promise<unknown>;
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code, uncertain: false, executionState: "not_started" }); }

/** Only child iframe sessions rooted in an already-owned tab enter this router. */
export class FrameRouting {
  private readonly sessions = new Map<number, Map<string, Promise<unknown>>>();
  private readonly frames = new Map<number, Map<string, Route>>();
  private readonly objects = new Map<number, Map<string, string>>();
  constructor(private readonly send: Send) {}
  private request(tabId: number, method: string, params: object, deadlineAt: number, sessionId?: string) {
    return beforeDeadline(() => this.send(tabId, method, params, Math.max(1, deadlineAt - Date.now()), sessionId), deadlineAt, { tabId, method, phase: "frame command" });
  }

  async enable(tabId: number, sessionId?: string, deadlineAt = Date.now() + 5000) {
    if (sessionId) {
      await this.request(tabId, "Page.enable", {}, deadlineAt, sessionId);
      await this.request(tabId, "Page.setInterceptFileChooserDialog", { enabled: true }, deadlineAt, sessionId);
    }
    await this.request(tabId, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: "iframe", exclude: false }] }, deadlineAt, sessionId);
  }
  forget(tabId: number) { this.frames.delete(tabId); this.sessions.delete(tabId); this.objects.delete(tabId); }
  event(source: Browser.debugger.Debuggee, method: string, input: object | undefined) {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const params = record(input);
    if (method === "Target.attachedToTarget" && record(params.targetInfo).type === "iframe" && typeof params.sessionId === "string") {
      const sessions = this.sessions.get(tabId) ?? new Map<string, Promise<unknown>>();
      this.sessions.set(tabId, sessions);
      const child = params.sessionId;
      const ready = this.enable(tabId, child).catch(() => {}).then(() => undefined);
      sessions.set(child, ready);
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      this.sessions.get(tabId)?.delete(params.sessionId);
      for (const [id, route] of this.frames.get(tabId) ?? []) if (route.sessionId === params.sessionId) this.frames.get(tabId)?.delete(id);
    }
    if (method === "Page.frameNavigated" || method === "Runtime.executionContextsCleared" || method === "Runtime.executionContextDestroyed") {
      for (const route of this.frames.get(tabId)?.values() ?? []) route.contextId = undefined;
    }
  }
  async tree(tabId: number, deadlineAt = Date.now() + 10000) {
    const known = this.frames.get(tabId) ?? new Map<string, Route>();
    const next = new Map<string, Route>();
    const read = async (sessionId?: string) => {
      const result = record(await this.request(tabId, "Page.getFrameTree", {}, deadlineAt, sessionId));
      const visit = (input: unknown, parentId: string | null) => {
        const node = record(input), frame = record(node.frame);
        if (typeof frame.id !== "string" || next.size >= 100) return;
        const previous = known.get(frame.id);
        const route: Route = { frameId: frame.id, parentId: typeof frame.parentId === "string" ? frame.parentId : parentId ?? previous?.parentId ?? next.get(frame.id)?.parentId ?? null,
          url: String(frame.url ?? "about:blank"), ...(sessionId ? { sessionId } : {}) };
        if (previous && previous.sessionId === sessionId && previous.url === route.url) route.contextId = previous.contextId;
        // An OOPIF's own session has the authoritative execution context.
        if (!next.get(frame.id)?.sessionId || sessionId) next.set(frame.id, route);
        for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) visit(child, frame.id);
      };
      visit(result.frameTree, null);
      return result.frameTree;
    };
    const root = await read();
    for (const [sessionId, ready] of this.sessions.get(tabId) ?? []) {
      await beforeDeadline(() => ready, deadlineAt, { tabId, phase: "child attachment", method: "Page.getFrameTree", executionState: "not_started" });
      try { await read(sessionId); } catch (error) { if (record(error).code === "TIMEOUT") throw error; this.sessions.get(tabId)?.delete(sessionId); }
    }
    this.frames.set(tabId, next);
    const build = (id: string, seen = new Set<string>()): unknown => {
      const route = next.get(id);
      if (!route || seen.has(id)) return null;
      seen.add(id);
      return { frame: { id, url: route.url, parentId: route.parentId }, childFrames: [...next.values()].filter(child => child.parentId === id).map(child => build(child.frameId, seen)) };
    };
    return { frameTree: build(String(record(record(root).frame).id)) };
  }
  async route(tabId: number, frameId: string, deadlineAt = Date.now() + 10000): Promise<Route> {
    await this.tree(tabId, deadlineAt);
    const route = this.frames.get(tabId)?.get(frameId);
    if (!route) fail("FRAME_NOT_FOUND", "Frame is detached or no longer belongs to this tab. Discover frames again.");
    return route;
  }
  async viewportPoint(tabId: number, frameId: string, point: { x: number; y: number }, checkUrl: (url: string) => void, deadlineAt = Date.now() + 5000) {
    return this.point(tabId, await this.route(tabId, frameId, deadlineAt), point, checkUrl, deadlineAt);
  }
  private async world(tabId: number, route: Route, deadlineAt: number) {
    if (route.contextId === undefined) {
      const world = record(await this.request(tabId, "Page.createIsolatedWorld", { frameId: route.frameId, worldName: "opencode-browser" }, deadlineAt, route.sessionId).catch(error => {
        if (/no frame|frame.*(not found|detached)|no.*execution context/i.test(String(error))) fail("FRAME_NOT_FOUND", "Frame navigated or detached while resolving its context.");
        throw error;
      }));
      if (typeof world.executionContextId !== "number") fail("UNSUPPORTED_FRAME", "Browser did not expose a frame execution context.");
      route.contextId = world.executionContextId;
    }
    return route.contextId;
  }
  async command(tabId: number, method: string, input: object, frameId: string | undefined, checkUrl: (url: string) => void, timeoutMs: number): Promise<unknown> {
    const deadlineAt = Date.now() + timeoutMs;
    const params = { ...record(input) };
    const qualified = typeof params.contextId === "string" && params.contextId.startsWith("frame-context:") ? params.contextId.split(":") : null;
    if ((params.contextId !== undefined && !qualified || params.uniqueContextId !== undefined || params.executionContextId !== undefined) && (!frameId || frameId === "main")) fail("UNSUPPORTED_FRAME", "Use a discovered frameId to select an owned execution context.");
    const selected = frameId ?? (method === "Page.createIsolatedWorld" && typeof params.frameId === "string" ? params.frameId : qualified ? decodeURIComponent(qualified[1] ?? "") : typeof params.objectId === "string" ? this.objects.get(tabId)?.get(params.objectId) : undefined);
    if (method === "Page.getFrameTree") return this.tree(tabId, deadlineAt);
    const remember = (result: unknown) => {
      const objectId = record(record(result).result).objectId ?? record(record(result).object).objectId;
      if (typeof objectId === "string") { const objects = this.objects.get(tabId) ?? new Map<string, string>(); objects.set(objectId, selected ?? "main"); this.objects.set(tabId, objects); }
      if (method === "Runtime.releaseObject" && typeof params.objectId === "string") this.objects.get(tabId)?.delete(params.objectId);
      return result;
    };
    if (!selected || selected === "main") return remember(await this.request(tabId, method, params, deadlineAt));
    const route = await this.route(tabId, selected, deadlineAt);
    for (let ancestor: Route | undefined = route; ancestor; ancestor = ancestor.parentId ? this.frames.get(tabId)?.get(ancestor.parentId) : undefined) if (ancestor.url !== "about:srcdoc") checkUrl(ancestor.url);
    if (method === "Page.createIsolatedWorld") return { executionContextId: `frame-context:${encodeURIComponent(selected)}:${await this.world(tabId, route, deadlineAt)}` };
    if (method === "Runtime.evaluate") {
      if (qualified && decodeURIComponent(qualified[1] ?? "") !== selected) fail("STALE_TARGET", "Execution context belongs to a different frame.");
      params.contextId = await this.world(tabId, route, deadlineAt);
      delete params.uniqueContextId;
      if (qualified && Number(qualified[2]) !== params.contextId) fail("STALE_TARGET", "Frame execution context expired. Discover the frame again.");
      params.expression = `globalThis.__agentBrowserFrameId=${JSON.stringify(selected)};\n${String(params.expression)}`;
    }
    if (method === "Runtime.callFunctionOn" && !params.objectId) params.executionContextId = await this.world(tabId, route, deadlineAt);
    if (method.startsWith("Input.dispatchMouse") && typeof params.x === "number" && typeof params.y === "number") {
      const point = await this.point(tabId, route, { x: params.x, y: params.y }, checkUrl, deadlineAt);
      return this.request(tabId, method, { ...params, ...point }, deadlineAt);
    }
    // Keyboard input is sent to the owning tab after focus was established in the selected frame.
    return remember(await this.request(tabId, method, params, deadlineAt, method.startsWith("Input.") ? undefined : route.sessionId));
  }
  private async point(tabId: number, initial: Route, point: { x: number; y: number }, checkUrl: (url: string) => void, deadlineAt: number) {
    let current = initial;
    for (let depth = 0; current.parentId && depth < 8; depth++) {
      const parent = this.frames.get(tabId)?.get(current.parentId);
      if (!parent) fail("FRAME_NOT_FOUND", "Parent frame disappeared during input.");
      if (parent.url !== "about:srcdoc") checkUrl(parent.url);
      const owner = record(await this.request(tabId, "DOM.getFrameOwner", { frameId: current.frameId }, deadlineAt, parent.sessionId));
      const resolved = record(await this.request(tabId, "DOM.resolveNode", { backendNodeId: owner.backendNodeId }, deadlineAt, parent.sessionId));
      const objectId = record(resolved.object).objectId;
      if (typeof objectId !== "string") fail("STALE_TARGET", "Frame owner is no longer available.");
      try {
        const geometry = record(await this.request(tabId, "Runtime.callFunctionOn", { objectId, returnByValue: true,
          functionDeclaration: frameGeometryFunction(),
          arguments: [{ value: point.x }, { value: point.y }] }, deadlineAt, parent.sessionId));
        const result = record(record(geometry.result).value);
        if (result.unsupported) fail("UNSUPPORTED_FRAME", "Rotated or perspective-transformed frame coordinates are unsupported.");
        if (!result.clear) fail("FRAME_OBSTRUCTED", "An ancestor frame is clipped or covered by another element.");
        if (typeof result.x !== "number" || typeof result.y !== "number") fail("UNSUPPORTED_FRAME", "Frame coordinates could not be verified.");
        point = { x: result.x, y: result.y };
      } finally { await this.send(tabId, "Runtime.releaseObject", { objectId }, 2000, parent.sessionId).catch(() => {}); }
      current = parent;
    }
    if (current.parentId) fail("UNSUPPORTED_FRAME", "Frame input exceeds the depth limit of eight.");
    return point;
  }
}
