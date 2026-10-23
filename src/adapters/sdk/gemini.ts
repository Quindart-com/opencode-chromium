import { createBrowserAgent } from "./index.ts";

export function geminiTools(options: Parameters<typeof createBrowserAgent>[0] = {}) {
  return createBrowserAgent(options).tools("gemini");
}
