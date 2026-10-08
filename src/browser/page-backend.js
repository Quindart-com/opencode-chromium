// Browser differences stay inside this internal adapter, never in tool schemas.
export function createPageBackend({ request, evaluate, command, ready }) {
  const gecko = async context => (await request(context, "getInfo")).engine === "gecko";
  return {
    async configure(context, tabId, env) {
      if (!await gecko(context)) return false;
      const unsupported = Object.keys(env).filter(key => !["viewport", "initScripts", "reset"].includes(key));
      if (unsupported.length || env.viewport?.mobile || env.viewport?.touch) throw new Error(`unsupported_capability: Firefox environment configuration supports viewport and initScripts; requested ${unsupported.join(", ") || "mobile/touch emulation"}`);
      if (env.viewport) await command(context, tabId, "Emulation.setDeviceMetricsOverride", { ...env.viewport, deviceScaleFactor: env.viewport.deviceScaleFactor ?? 1 });
      if (env.initScripts?.length) await command(context, tabId, "Page.addScriptToEvaluateOnNewDocument", { source: env.initScripts.join("\n") });
      return true;
    },
    async reset(context, tabId) {
      if (!await gecko(context)) return false;
      await command(context, tabId, "Emulation.clearDeviceMetricsOverride", {});
      return true;
    },
    async click(context, tabId, expression, options = {}) {
      const trusted = await gecko(context);
      const point = await evaluate(context, tabId, expression(trusted), { userGesture: true });
      if (trusted) {
        await command(context, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        for (let i = 0; i < (options.clickCount ?? 1); i++) {
          await command(context, tabId, "Input.dispatchMouseEvent", { type: "mousePressed", button: options.button ?? "left", x: point.x, y: point.y });
          await command(context, tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", button: options.button ?? "left", x: point.x, y: point.y });
        }
      }
      return point;
    },
    async hover(context, tabId, point) {
      if (point && await gecko(context)) await command(context, tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      return point;
    },
    async history(context, tabId, delta) {
      if (!await gecko(context)) return null;
      await command(context, tabId, "Page.traverseHistory", { delta });
      return { delta, readiness: await ready(context, tabId, "domcontentloaded", 15000) };
    },
  };
}
