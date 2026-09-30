import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "native-host/dist/**", "extension/**", ".build/**", ".wxt/**"] },
  {
    files: ["src/management/**/*.ts", "src/cli/providers.ts", "native-host/src/decisions/**/*.ts", "extension-src/entrypoints/popup/ProviderSettings.tsx"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { process: "readonly", Buffer: "readonly", fetch: "readonly", AbortSignal: "readonly", performance: "readonly" } },
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }] },
  },
);
