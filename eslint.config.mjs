import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Prettier owns formatting. This file owns correctness and layering.
 *
 * The `no-restricted-imports` block is the interesting part: it stops a React component from reaching
 * past the document store into the CRDT or Dexie. That is not a style preference — every operation
 * entering a replica must also advance the authoring Lamport clock, which is the invariant the
 * `id > origin.id` rule rests on, and it is enforced in exactly ONE place (`DocumentStore#absorb`).
 *
 * A component that imports the CRDT and applies operations itself bypasses it. The symptom is not a
 * crash: it is two users' words being shredded into each other, months later, under concurrency.
 * (DECISIONS.md D-003 — this bug was real, and the property test caught it.)
 */
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "playwright-report/**",
    "test-results/**",
    "e2e/.auth/**",
  ]),

  {
    rules: {
      /** `any` is a hole in the type system — every one is a place the compiler stops helping. */
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // Debug output in a browser is how document text ends up in a screenshot on a support ticket.
      "no-console": ["error", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],

      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/database/db", "**/database/db"],
              message:
                "Components must not touch Dexie directly — go through the document store or the sync engine.",
            },
          ],
        },
      ],
    },
  },

  /** The store, the sync engine, the CRDT itself, and the tests ARE those layers. */
  {
    files: [
      "src/services/**",
      "src/sync-engine/**",
      "src/crdt/**",
      "src/hooks/**",
      "src/versioning/**",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "e2e/**",
      "*.config.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
      "no-console": "off",
    },
  },
]);

export default eslintConfig;
