import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  nextPlugin.configs["core-web-vitals"],
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: ["tests/**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
];

export default eslintConfig;
