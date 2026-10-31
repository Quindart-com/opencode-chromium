import { z } from "zod";
import type { Environment } from "../core/registry.ts";
import type { BrowserContext } from "../core/tool-definition.ts";
import type { CdpParams,PageCdpRequest } from "../shared/cdp.ts";
import { record } from "../shared/values.ts";

const pointSchema = z.looseObject({ x: z.number().finite(), y: z.number().finite() });
interface BackendDependencies {
  request(context: BrowserContext, method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(context: BrowserContext, tabId: number, expression: string, options?: { userGesture?: boolean }): Promise<unknown>;
  command: PageCdpRequest<BrowserContext>;
  ready(context: BrowserContext, tabId: number, condition: string, timeoutMs: number): Promise<unknown>;
}

// Browser differences stay inside this internal adapter, never in tool schemas.
export function createPageBackend({ request, evaluate, command, ready }: BackendDependencies) {
  const gecko = async (context: BrowserContext): Promise<boolean> => record(await request(context, "getInfo")).engine === "gecko";
  return {
    async configure(context: BrowserContext, tabId: number, env: Environment): Promise<boolean> {
      if (!await gecko(context)) return false;
      const unsupported = Object.keys(env).filter(key => !["viewport", "initScripts", "reset"].includes(key));
      if (unsupported.length || env.viewport?.mobile || env.viewport?.touch) throw new Error(`unsupported_capability: Firefox environment configuration supports viewport and initScripts; requested ${unsupported.join(", ") || "mobile/touch emulation"}`);
      if (env.viewport) await command(context, tabId, "Emulation.setDeviceMetricsOverride", { ...env.viewport, mobile: env.viewport.mobile ?? false, deviceScaleFactor: env.viewport.deviceScaleFactor ?? 1 });
      if (env.initScripts?.length) await command(context, tabId, "Page.addScriptToEvaluateOnNewDocument", { source: env.initScripts.join("\n") });
      return true;
    },
    async reset(context: BrowserContext, tabId: number): Promise<boolean> {
      if (!await gecko(context)) return false;
      await command(context, tabId, "Emulation.clearDeviceMetricsOverride", {});
      return true;
    },
    async click(context: BrowserContext, tabId: number, expression: (trusted: boolean) => string, options: { button?: CdpParams<"Input.dispatchMouseEvent">["button"]; clickCount?: number } = {}) {
      const trusted = await gecko(context);
      const point = pointSchema.parse(await evaluate(context, tabId, expression(trusted || Boolean(context.frameId && context.frameId !== "main")), { userGesture: true }));
      if (context.frameId && context.frameId !== "main") {
        await request(context, "framePoint", { tabId, frameId: context.frameId, ...point });
        if (!trusted) await evaluate(context, tabId, expression(false), { userGesture: true });
      }
      if (trusted) {
        await command(context, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        for (let i = 0; i < (options.clickCount ?? 1); i++) {
          await command(context, tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: options.button ?? "left", x: point.x, y: point.y });
          await command(context, tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: options.button ?? "left", x: point.x, y: point.y });
        }
      }
      return point;
    },
    async hover<T extends { x: number; y: number } | null>(context: BrowserContext, tabId: number, point: T): Promise<T> {
      if (point && await gecko(context)) await command(context, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      return point;
    },
    async history(context: BrowserContext, tabId: number, delta: number) {
      if (!await gecko(context)) return null;
      await command(context, tabId, "Page.traverseHistory", { delta });
      return { delta, readiness: await ready(context, tabId, "domcontentloaded", 15000) };
    },
  };
}
