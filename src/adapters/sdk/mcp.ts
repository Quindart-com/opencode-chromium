import { createBrowserAgent } from "./index.ts";

export function mcpTools(options: Parameters<typeof createBrowserAgent>[0] = {}) {
  return createBrowserAgent(options).tools("mcp");
}
