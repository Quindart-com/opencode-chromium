import { createBrowserAgent } from "./index.ts";

export function openAITools(options: Parameters<typeof createBrowserAgent>[0] = {}) {
  return createBrowserAgent(options).tools("openai");
}
