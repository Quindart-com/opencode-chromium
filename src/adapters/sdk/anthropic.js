import { createBrowserAgent } from "./index.js";

export function anthropicTools(options = {}) {
  return createBrowserAgent(options).tools("anthropic");
}
