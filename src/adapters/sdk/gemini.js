import { createBrowserAgent } from "./index.js";

export function geminiTools(options = {}) {
  return createBrowserAgent(options).tools("gemini");
}
