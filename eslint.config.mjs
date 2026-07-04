import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Never lint generated or build output.
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.turbo/**",
      "packages/db/src/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Turn off rules that conflict with Prettier — Prettier owns formatting.
  prettier,
);
