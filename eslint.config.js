import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint 10 flat config (ADR-014 → ADR-025 type-aware in Phase 2).
 *
 * The architectural import rule from docs/architecture.md is expressed with
 * no-restricted-imports: domain purity, a global child_process ban (ADR-004),
 * and core/application never naming vendor code. Type-aware rules run over
 * everything compiled by tsconfig.dev.json (which includes packages' src,
 * package tests, apps and the root tests) — ADR-025.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'package-lock.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    ...c,
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/tests/**/*.ts',
      'packages/adapters/*/src/**/*.ts',
      'packages/adapters/*/tests/**/*.ts',
      'apps/*/src/**/*.ts',
      'tests/**/*.ts',
    ],
    languageOptions: {
      parserOptions: {
        // type-aware linting via the noEmit dev project (ADR-025)
        project: ['./tsconfig.dev.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  })),
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/adapters/*/src/**/*.ts',
      'apps/*/src/**/*.ts',
      'tests/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // ADR-004: nothing may spawn processes. adapters/ get a narrow exemption
    // review when they actually need it; today the ban is global.
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:child_process', 'child_process'],
              message: 'ADR-004: no path from remote input to process creation.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Anything that is not a relative "./x" import is banned:
              // third-party, node:* builtins AND sibling @raag packages.
              regex: '^(?!\\./).*$',
              message:
                '@raag/domain may only import its own relative modules (ADR-003, architecture.md §16).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts', 'packages/application/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@raag/telegram',
                '@raag/claude-code',
                '@raag/codex',
                '@raag/kilo-code',
                '@raag/generic',
                '@raag/database',
                'grammy',
                'better-sqlite3',
                'node:child_process',
                'child_process',
              ],
              message:
                'Dependency rule: core/application import ports (domain) and logging/config, never vendor code (ADR-003).',
            },
          ],
        },
      ],
    },
  },
);
