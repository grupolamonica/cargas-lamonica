import js from "@eslint/js";
import globals from "globals";
import unusedImports from "eslint-plugin-unused-imports";

export default [
  {
    ignores: ["node_modules", "dist", "coverage", "benchmarks/**/*.snap"],
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-unreachable": "warn",
      "no-constant-condition": ["warn", { checkLoops: false }],
    },
  },
  {
    files: ["**/*.test.{js,mjs}", "**/test-harness.{js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        beforeEach: "readonly",
        afterAll: "readonly",
        afterEach: "readonly",
        vi: "readonly",
        bench: "readonly",
      },
    },
  },
];
