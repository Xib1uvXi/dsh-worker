import { builtinModules } from "node:module";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = [
  "packages/**/*.ts",
  "scripts/**/*.ts",
  "tests/**/*.ts",
  "vitest.config.ts",
];

const nodeOnlyGlobals = Object.keys(globals.node).filter(
  (key) => !(key in globals.browser) && !(key in globals.es2023),
);

export default defineConfig(
  {
    ignores: ["**/node_modules/**", "dist/**", ".scratch/**", "coverage/**"],
  },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: typescriptFiles,
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "all", argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    files: ["packages/web/**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: {
        ...Object.fromEntries(
          Object.keys(globals.node).map((key) => [key, "off"]),
        ),
        ...globals.browser,
      },
    },
    rules: {
      // TypeScript also sees Node declarations through the shared project;
      // reject Node globals explicitly in browser code.
      "no-restricted-globals": ["error", ...nodeOnlyGlobals],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^node:/]",
          message: "Node modules cannot be loaded by browser code.",
        },
        ...builtinModules.map((name) => ({
          selector: `ImportExpression[source.value=${JSON.stringify(name)}]`,
          message: "Node modules cannot be loaded by browser code.",
        })),
      ],
      "no-restricted-imports": [
        "error",
        { patterns: ["node:*", ...builtinModules] },
      ],
    },
  },
);
