import type { BrowserContext } from "../core/tool-definition.ts";
import type { PageCdpRequest } from "../shared/cdp.ts";
import { pageException } from "../shared/page-error.ts";
import { record } from "../shared/values.ts";

// Helper expressions (snapshot, search, click and typing helpers) run in a named
// isolated world so page scripts cannot observe our globals, and so evaluating
// them never requires Runtime.enable, which is the main CDP footprint that
// anti-devtools scripts detect. Everything that must see page JavaScript runs
// in the page's main world instead.
export const AGENT_WORLD_NAME = "opencode-agent";
export type EvaluateWorld = "agent" | "page";

const STALE_CONTEXT = /Cannot find context with specified id|Execution context was destroyed|No frame for given id|Inspected target navigated or closed/i;
const UNSUPPORTED = /unsupported|not implemented|not supported|wasn't found|is not a function/i;

/** A context id that no longer exists. Raised before the expression ran, so it is safe to retry once. */
export function isMissingContextError(error: unknown) {
  return /Cannot find context with specified id|No frame for given id/i.test(error instanceof Error ? error.message : String(error));
}
export function isStaleContextError(error: unknown) {
  return STALE_CONTEXT.test(error instanceof Error ? error.message : String(error));
}
export function isMainFrame(context: BrowserContext) {
  return !context.frameId || context.frameId === "main";
}

export interface EvaluateOptions { userGesture?: boolean; timeoutMs?: number; runtimeTimeoutMs?: number; awaitPromise?: boolean; returnByValue?: boolean; world?: EvaluateWorld }
interface Entry { frameId?: string; contextId?: number; unsupported?: boolean }

export function createAgentWorld({ cdp, key }: { cdp: PageCdpRequest<BrowserContext>; key(context: BrowserContext, tabId: number): string }) {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<number | null>>();

  async function create(context: BrowserContext, tabId: number, entry: Entry) {
    if (!entry.frameId) {
      const tree = record(await cdp(context, tabId, "Page.getFrameTree", {}));
      const id = record(record(tree.frameTree).frame).id;
      if (typeof id !== "string") throw new Error("Main frame id unavailable");
      entry.frameId = id;
    }
    const world = await cdp(context, tabId, "Page.createIsolatedWorld", { frameId: entry.frameId, worldName: AGENT_WORLD_NAME, grantUniveralAccess: false });
    // Firefox and frame-qualified routes answer with a string; only a numeric id is usable in the main frame.
    if (typeof world.executionContextId !== "number") { entry.unsupported = true; return null; }
    entry.contextId = world.executionContextId;
    return entry.contextId;
  }

  const world = {
    /** Context id of the agent world for the tab's main frame, or null when callers must use the main world. */
    async contextId(context: BrowserContext, tabId: number): Promise<number | null> {
      if (!isMainFrame(context)) return null;
      const id = key(context, tabId);
      const entry = entries.get(id) ?? {};
      entries.set(id, entry);
      if (entry.unsupported) return null;
      if (entry.contextId !== undefined) return entry.contextId;
      const inflight = pending.get(id);
      if (inflight) return inflight;
      const task = create(context, tabId, entry).catch((error: unknown) => {
        entry.frameId = undefined;
        if (UNSUPPORTED.test(error instanceof Error ? error.message : String(error))) entry.unsupported = true;
        return null; // Transient failures fall back to the main world for this call only.
      }).finally(() => pending.delete(id));
      pending.set(id, task);
      return task;
    },
    invalidate(context: BrowserContext, tabId: number) {
      const entry = entries.get(key(context, tabId));
      if (entry && !entry.unsupported) { entry.contextId = undefined; entry.frameId = undefined; }
    },
    markUnsupported(context: BrowserContext, tabId: number) { entries.set(key(context, tabId), { unsupported: true }); },
    forgetTab(prefix: string, tabId: number) { entries.delete(`${prefix}:${tabId}`); },
    forgetSession(prefix: string) { for (const id of [...entries.keys()]) if (id.startsWith(prefix)) entries.delete(id); },
    /**
     * Runtime.evaluate without Runtime.enable. Helper expressions default to the
     * agent world; pass world "page" for expressions that need page JavaScript.
     */
    async evaluate(context: BrowserContext, tabId: number, expression: string, options: EvaluateOptions = {}) {
      const params = {
        expression,
        awaitPromise: options.awaitPromise !== false,
        returnByValue: options.returnByValue !== false,
        userGesture: options.userGesture !== false,
        timeout: options.runtimeTimeoutMs,
      };
      const useAgentWorld = (options.world ?? "agent") === "agent" && isMainFrame(context);
      for (let attempt = 0; useAgentWorld && attempt < 2; attempt += 1) {
        const contextId = await world.contextId(context, tabId);
        if (contextId === null) break;
        let result;
        try {
          result = await cdp(context, tabId, "Runtime.evaluate", { ...params, contextId }, options.timeoutMs);
        } catch (error) {
          // A host that refuses raw context ids keeps the main-world behavior.
          if (record(error).code === "UNSUPPORTED_FRAME" && attempt === 0) { world.markUnsupported(context, tabId); break; }
          if (!isStaleContextError(error)) throw error;
          world.invalidate(context, tabId);
          // Only a context that never existed is safe to replay; one destroyed
          // mid-evaluation may already have changed the page.
          if (attempt === 1 || !isMissingContextError(error)) throw error;
          continue;
        }
        if (result.exceptionDetails) throw pageException(result.exceptionDetails);
        return result.result?.value;
      }
      const result = await cdp(context, tabId, "Runtime.evaluate", params, options.timeoutMs);
      if (result.exceptionDetails) throw pageException(result.exceptionDetails);
      return result.result?.value;
    },
  };
  return world;
}
export type AgentWorld = ReturnType<typeof createAgentWorld>;
