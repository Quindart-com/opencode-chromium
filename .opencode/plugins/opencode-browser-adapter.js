import { AgentChromiumBrowserPlugin } from "../../opencode-plugin/src/ai-plugin.js";

let registered = false;

export const OpencodeBrowserAdapter = async (...args) => {
  if (registered) return {};
  registered = true;
  return AgentChromiumBrowserPlugin(...args);
};
