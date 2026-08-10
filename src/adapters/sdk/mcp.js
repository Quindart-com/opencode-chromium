import { createBrowserAgent } from "./index.js";

export function mcpTools(options = {}) {
  return createBrowserAgent(options).tools("mcp");
}
