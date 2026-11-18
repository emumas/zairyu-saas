import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.expo/**", "**/.turbo/**", "apps/mobile/ios/**", "apps/mobile/android/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // 個人情報をログに出さないため console は原則禁止(必要時は理由を書いて disable)
      "no-console": "error",
    },
  },
);
