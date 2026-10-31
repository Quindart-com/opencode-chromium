export const PRODUCT = Object.freeze({
  packageName: "opencode-chromium",
  pluginId: "opencode-browser-plugin",
  mcpBin: "opencode-chromium-mcp",
  nativeHost: "com.opencode.browser.plugin",
  firefoxExtensionId: "opencode-browser-plugin@quindart.com",
  runtimeDirectory: ["OpenCode", "browser"] as const,
  runtimeEnvironment: "OPENCODE_BROWSER_RUNTIME_DIR",
});

export const CONTROL_PROTOCOL_VERSION = 2;
export const TOOL_CONTRACT_VERSION = 2;
export const LEGACY_BROWSER_CONTRACT_VERSION = 1;
export const BROWSER_CONTRACT_VERSION = 1;
