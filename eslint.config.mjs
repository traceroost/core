import typescriptEslint from "typescript-eslint";

export default typescriptEslint.config(
  {
    ignores: ["dist/**", "out/**", "media/dashboard.js", "media/dist-check/**", "esbuild.js"],
  },
  {
    files: ["src/**/*.ts", "media/src/**/*.ts", "media/src/**/*.tsx"],
    extends: typescriptEslint.configs.recommended,
    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Style
      semi: ["warn", "never"],
      eqeqeq: "warn",
      curly: "off",

      // TypeScript
      "@typescript-eslint/naming-convention": ["warn", {
        selector: "import",
        format: ["camelCase", "PascalCase"],
      }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-expressions": ["error", { allowTernary: true, allowShortCircuit: true }],

      // Practices
      "no-console": "warn",
      "no-throw-literal": "warn",
    },
  },
  {
    // Editions (CONTRIBUTING.md → Editions): non-cloud code reaches TraceRoost Pro only through
    // the seams, so the core build can leave every cloud/ directory out. Type-only imports are
    // erased and stay allowed. (esbuild.js enforces the same thing for real in a core build.)
    files: ["src/**/*.ts", "media/src/**/*.ts", "media/src/**/*.tsx"],
    ignores: ["src/cloud/**", "src/test/**", "media/src/cloud/**", "src/cloudBridge.ts", "media/src/orgPanel.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/cloud/*", "**/cloud/**"],
          allowTypeImports: true,
          message: "Import TraceRoost Pro code through a seam (src/cloudBridge.ts, media/src/orgPanel.ts) — see CONTRIBUTING.md → Editions.",
        }],
      }],
    },
  },
);
