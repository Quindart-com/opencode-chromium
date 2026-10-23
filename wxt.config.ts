import { defineConfig } from "wxt";

const firefox = process.argv.includes("firefox");
export default defineConfig({
  srcDir: "extension-src",
  publicDir: "extension-src/public",
  outDir: firefox ? "extension-firefox" : "extension",
  manifestVersion: 3,
  outDirTemplate: "{{modeSuffix}}",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "opencode-chromium",
    description: "Connect OpenCode, Codex and MCP agents to your browser for page search, forms, screenshots and local action memory.",
    action: {
      default_title: "opencode-chromium",
      default_icon: {
        "16": "images/icon16.png",
        "32": "images/icon32.png",
        "48": "images/icon48.png",
        "128": "images/icon128.png",
      },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; connect-src 'self'; font-src 'self'",
    },
    ...(firefox ? { browser_specific_settings: { gecko: { id: "opencode-browser-plugin@quindart.com", strict_min_version: "140.0", data_collection_permissions: { required: ["websiteContent", "browsingActivity"], optional: ["technicalAndInteraction"] } } } } : {}),
    permissions: [
      "alarms",
      ...(firefox ? [] : ["debugger"]),
      "history",
      "nativeMessaging",
      "scripting",
      "storage",
      ...(firefox ? [] : ["tabGroups"]),
      "tabs",
    ],
    host_permissions: ["<all_urls>"],
    icons: {
      "16": "images/icon16.png",
      "32": "images/icon32.png",
      "48": "images/icon48.png",
      "128": "images/icon128.png",
    },
    web_accessible_resources: [
      {
        matches: ["<all_urls>"],
        resources: ["popup.html"],
      },
    ],
  },
});
