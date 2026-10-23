import { createBrowserAgent } from "./index.ts";

export function anthropicTools(options: Parameters<typeof createBrowserAgent>[0] = {}) {
  return createBrowserAgent(options).tools("anthropic");
}
