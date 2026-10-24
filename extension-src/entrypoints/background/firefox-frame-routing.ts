import { record } from "../../../src/shared/values.ts";
import { beforeDeadline } from "../../../src/shared/deadline.ts";

type Send = (tabId: number, method: string, params: object, timeoutMs?: number) => Promise<unknown>;
export class FirefoxFrameRouting {
  private readonly objects = new Map<number, Map<string, string>>();
  constructor(private readonly send: Send) {}
  forget(tabId: number) { this.objects.delete(tabId); }
  async command(tabId: number, method: string, input: object, frameId: string | undefined, checkUrl: (url: string) => void, timeoutMs: number): Promise<unknown> {
    const deadlineAt = Date.now() + timeoutMs;
    const send = (name: string, params: object) => beforeDeadline(() => this.send(tabId, name, params, Math.max(1, deadlineAt - Date.now())), deadlineAt, { tabId, method: name, phase: "Firefox frame command" });
    const params = { ...record(input) };
    delete params.agentFrameId;
    const qualified = typeof params.contextId === "string" && params.contextId.startsWith("firefox-frame:") ? decodeURIComponent(params.contextId.slice(14)) : undefined;
    const selected = frameId ?? qualified ?? (method === "Page.createIsolatedWorld" && typeof params.frameId === "string" ? params.frameId : typeof params.objectId === "string" ? this.objects.get(tabId)?.get(params.objectId) : undefined);
    if (params.contextId !== undefined && !qualified && (!frameId || frameId === "main")) throw Object.assign(new Error("Use a discovered frameId to select a Firefox execution context."), { code: "UNSUPPORTED_FRAME", uncertain: false, executionState: "not_started" });
    if (selected && selected !== "main") {
      const tree = record(await send("Page.getFrameTree", { maxDepth: 8, maxFrames: 50 }));
      const visit = (input: unknown, parents: string[]): string[] | null => {
        const node = record(input), frame = record(node.frame), path = [...parents, String(frame.url ?? "about:blank")];
        if (frame.id === selected) return path;
        for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) { const found = visit(child, path); if (found) return found; }
        return null;
      };
      const path = visit(tree.frameTree, []);
      if (!path) throw Object.assign(new Error("Frame no longer belongs to this tab. Discover frames again."), { code: "FRAME_NOT_FOUND", uncertain: false, executionState: "not_started" });
      for (const url of path) if (url !== "about:srcdoc") checkUrl(url);
      if (method === "Page.createIsolatedWorld") return { executionContextId: `firefox-frame:${encodeURIComponent(selected)}` };
      params.agentFrameId = selected;
      if (qualified) delete params.contextId;
    }
    const result = await send(method, params);
    const objectId = record(record(result).result).objectId;
    if (typeof objectId === "string") {
      const objects = this.objects.get(tabId) ?? new Map<string, string>();
      objects.set(objectId, selected ?? "main"); this.objects.set(tabId, objects);
    }
    if (method === "Runtime.releaseObject" && typeof params.objectId === "string") this.objects.get(tabId)?.delete(params.objectId);
    return result;
  }
}
