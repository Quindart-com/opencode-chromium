import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "native-host/dist/**", "extension/**", ".build/**", ".wxt/**"] },
  {
    files: ["src/management/**/*.ts", "src/cli/providers.ts", "native-host/src/decisions/**/*.ts", "extension-src/entrypoints/popup/**/*.{ts,tsx}", "extension-src/entrypoints/welcome/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { process: "readonly", Buffer: "readonly", fetch: "readonly", AbortSignal: "readonly", performance: "readonly", window: "readonly", document: "readonly", navigator: "readonly", location: "readonly", URLSearchParams: "readonly" } },
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }] },
  },
  {
    files: ["src/core/**/*.js", "src/browser/**/*.js", "native-host/src/firefox/frames.js", "extension-src/entrypoints/background/{navigation-policy,onboarding,download-events,tab-ownership,decision-image,firefox-bridge}.js"],
    extends: [js.configs.recommended],
    languageOptions: { globals: Object.fromEntries(["process", "Buffer", "fetch", "AbortSignal", "AbortController", "performance", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "URL", "URLSearchParams", "TextDecoder", "TextEncoder", "structuredClone", "WebSocket", "crypto"].map(name => [name, "readonly"])) },
    rules: { "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" }], "no-empty": ["error", { allowEmptyCatch: true }] },
  },
  {
    files: ["extension-src/entrypoints/background/{decision-image,firefox-bridge}.js"],
    languageOptions: { globals: Object.fromEntries(["document", "HTMLInputElement", "createImageBitmap", "OffscreenCanvas", "Blob", "atob", "btoa"].map(name => [name, "readonly"])) },
  },
);
