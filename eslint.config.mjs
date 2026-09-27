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
  // ── Cloud wire-format boundary (privacy contract) ──────────────────────────
  // src/cloud/forward/ builds the only payload ever sent to TraceRoost Cloud (`RollupPayload`,
  // defined in schema.ts) — every field on it is a number, enum, hash, or timestamp, never free
  // text. These rules mechanically enforce invariants that were previously only doc comments:
  // no type-assertion escape hatch may reintroduce an untyped value, and the wide internal type
  // that actually carries prompts/completions/diffs (`SessionSummaryCard`) must never be
  // reachable from here at all. See schema.ts and buildSessionRollup.ts's header comments, and
  // the pre-release privacy-scan job in release.yml that depends on these rules holding.
  {
    files: ["src/cloud/forward/**/*.ts"],
    rules: {
      // Repo-wide this is "warn" (naming any explicit `any`, including `as any` casts); inside
      // the wire-format boundary an `any` is how a free-text field would sneak back in unnoticed.
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-syntax": ["error", {
        selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
        message: "`as unknown` (typically chained into `as unknown as X`) is a type-safety escape hatch that can defeat the closed RollupPayload contract inside the cloud wire-format boundary. Restructure instead of casting through unknown.",
      }],
    },
  },
  {
    files: ["src/cloud/forward/**/*.ts"],
    ignores: ["src/cloud/forward/sender.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          {
            group: ["**/summarizerTypes"],
            importNames: ["SessionSummaryCard"],
            message: "forward/ must not import SessionSummaryCard — it carries prompts, completions and diffs. Define a narrow structural interface instead (see buildSessionRollup.ts's SessionRollupInput).",
          },
          {
            group: ["**/org/config"],
            importNames: ["ingestUrl", "batchIngestUrl"],
            message: "Only sender.ts may reference the cloud ingest endpoints, so the RollupPayload wire contract stays the single path session data can leave the machine through.",
          },
        ],
      }],
    },
  },
  {
    files: ["src/cloud/forward/sender.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/summarizerTypes"],
          importNames: ["SessionSummaryCard"],
          message: "forward/ must not import SessionSummaryCard — it carries prompts, completions and diffs. Define a narrow structural interface instead (see buildSessionRollup.ts's SessionRollupInput).",
        }],
      }],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/cloud/forward/**", "src/test/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/cloud/org/config"],
          importNames: ["ingestUrl", "batchIngestUrl"],
          message: "Only src/cloud/forward/sender.ts may reference the cloud ingest endpoints, so the RollupPayload wire contract stays the single path session data can leave the machine through.",
        }],
      }],
    },
  },
);
