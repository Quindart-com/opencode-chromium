import { createBrowserAgent } from "./index.js";

export function openAITools(options = {}) {
  return createBrowserAgent(options).tools("openai");
}
