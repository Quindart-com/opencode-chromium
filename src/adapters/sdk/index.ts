import { createBrowserAgent } from "./factory.ts";

export { createBrowserAgent };
type AgentOptions = Parameters<typeof createBrowserAgent>[0];
export const anthropicTools = (options: AgentOptions = {}) => createBrowserAgent(options).tools("anthropic");
export const geminiTools = (options: AgentOptions = {}) => createBrowserAgent(options).tools("gemini");
export const mcpTools = (options: AgentOptions = {}) => createBrowserAgent(options).tools("mcp");
export const openAITools = (options: AgentOptions = {}) => createBrowserAgent(options).tools("openai");
