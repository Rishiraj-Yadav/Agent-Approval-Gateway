import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * ESLint 9 flat config (ADR-014, ADR-017). Non-type-aware rules only for
 * Phase 1 (fast, flake-free on Windows + Linux); type-aware lint upgrade is a
 * Phase 2 item once domain code has shapes worth checking.
 *
 * The architectural import rule from docs/architecture.md is expressed with
 * no-restricted-imports: boundaries first, then a global child_process ban
 * (ADR-004), then zero-runtime-deps expectations.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', 'package-lock.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
              group: ['@raag/*', 'node:*', '*.js'],
              message: '@raag/domain must import nothing (types + ports + state machine only).',
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
