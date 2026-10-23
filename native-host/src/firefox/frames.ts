import { randomUUID } from "node:crypto";
import type { BrowsingContext } from "webdriver-bidi-protocol";
import type { BidiSend,BridgedFrame } from "./protocol.ts";

export async function bridgedFrameTree({ send, root, maxDepth = 3, maxFrames = 20 }: { send: BidiSend; root: string; maxDepth?: number; maxFrames?: number }) {
  const result = await send("browsingContext.getTree", { root, maxDepth: Math.min(maxDepth, 8) });
  if (result.contexts.length !== 1 || result.contexts[0]?.context !== root) {
    throw new Error("Firefox frame tree does not match the controlled tab; rediscover the frames.");
  }
  const contexts = new Map<string, string>();
  let remaining = Math.min(maxFrames, 50);
  async function convert(frame: BrowsingContext.Info | undefined): Promise<BridgedFrame | null> {
    if (!frame || remaining-- <= 0) return null;
    const marker = randomUUID();
    const response = await send("script.evaluate", { target: { context: frame.context }, awaitPromise: false,
      expression: `(() => { const key = 'data-opencode-frame-id'; const root = document.documentElement; if (!root) return null; const previous = root.getAttribute(key); if (!previous || !/^[a-f0-9-]{36}$/.test(previous)) root.setAttribute(key, ${JSON.stringify(marker)}); return root.getAttribute(key); })()` });
    const id = response.type === "success" && response.result.type === "string" ? response.result.value : null;
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id) || contexts.has(id)) throw new Error("Firefox frame bridge is unavailable or ambiguous; rediscover the frames.");
    contexts.set(id, frame.context);
    const childFrames = [];
    for (const child of (frame.children ?? []).slice(0, 50)) {
      if (remaining <= 0) break;
      const converted = await convert(child);
      if (converted) childFrames.push(converted);
    }
    return { frame: { id, url: frame.url }, childFrames, truncated: frame.children === null || (frame.children ?? []).length > childFrames.length };
  }
  return { frameTree: await convert(result.contexts?.[0]), contexts };
}
