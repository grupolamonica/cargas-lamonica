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
      // Findings pré-existentes do codebase — ESLint só foi habilitado no
      // backend na Wave 2, então essas rules nunca rodaram antes.
      // Mantidas como "warn" temporariamente para não quebrar CI; cada uma
      // tem 4-5 occurrences que merecem PR dedicado:
      //   - preserve-caught-error: throw new Error(...) sem `{ cause }`
      //   - no-useless-assignment: variáveis atribuídas e nunca lidas
      //   - no-useless-escape:    \- em regex character class
      // TODO: criar issues e promover para "error" após limpeza.
      "preserve-caught-error": "warn",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
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
