import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "extension-src",
  publicDir: "extension-src/public",
  outDir: "extension",
  outDirTemplate: "{{modeSuffix}}",
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "opencode-chromium",
    description: "OpenCode browser automation. Readable extension, native messaging host, and OpenCode plugin for Chromium.",
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
    permissions: [
      "alarms",
      "debugger",
      "downloads",
      "history",
      "nativeMessaging",
      "scripting",
      "storage",
      "tabGroups",
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
        resources: ["images/cursor-chat.png", "popup.html"],
      },
    ],
  },
});
