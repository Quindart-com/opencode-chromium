import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", "native-host/dist/**", "extension/**", "extension-firefox/**", ".build/**", ".wxt/**"] },
  {
    files: ["src/**/*.ts", "native-host/src/**/*.ts", "extension-src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "no-undef": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  { files: ["native-host/src/host.js"], extends: [js.configs.recommended] },
);
