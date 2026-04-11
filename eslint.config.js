// Flat config — https://eslint.org/docs/latest/use/configure/configuration-files
// Covers the whole monorepo:
//   - packages/core          → pure TS
//   - packages/vue           → Vue 3 library (no Nuxt)
//   - packages/element       → Vue 3 custom element wrapper
//   - apps/web               → Nuxt 4 SPA
//   - examples/**            → future embed demos
//
// Vue files use vue-eslint-parser (required by eslint-plugin-vue) with
// typescript-eslint's parser for <script lang="ts"> blocks.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default [
  // ------------------------------------------------------------------
  // Files to skip entirely
  // ------------------------------------------------------------------
  {
    ignores: [
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },

  // ------------------------------------------------------------------
  // Base JavaScript recommended rules
  // ------------------------------------------------------------------
  js.configs.recommended,

  // ------------------------------------------------------------------
  // TypeScript — typescript-eslint recommended, non-type-aware
  // (type-aware rules are slower; we'll opt in per-file later if needed)
  // ------------------------------------------------------------------
  ...tseslint.configs.recommended,

  // ------------------------------------------------------------------
  // Vue — flat/recommended pulls in the essential + strongly-recommended rules
  // ------------------------------------------------------------------
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },

  // ------------------------------------------------------------------
  // Browser globals for app/library code
  // ------------------------------------------------------------------
  {
    files: [
      'packages/**/*.{ts,vue}',
      'apps/web/**/*.{ts,vue}',
      'examples/**/*.{ts,vue}',
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // ------------------------------------------------------------------
  // Project-wide rule overrides
  // ------------------------------------------------------------------
  {
    rules: {
      // Explicit-any is a hard ban across the monorepo. No escape hatches
      // via `any` — use `unknown` + narrowing, or a generic parameter.
      '@typescript-eslint/no-explicit-any': 'error',

      // Unused variables must be prefixed with `_` to signal intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Vue single-word component names are fine for us (NuxtPage, etc.)
      'vue/multi-word-component-names': 'off',

      // Allow <template> blocks with no root element (fragments)
      'vue/no-multiple-template-root': 'off',
    },
  },

  // ------------------------------------------------------------------
  // Node globals for config files + vite.config.ts
  // ------------------------------------------------------------------
  {
    files: ['**/vite.config.ts', '**/eslint.config.js', '**/nuxt.config.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ------------------------------------------------------------------
  // Prettier — MUST be last. Disables stylistic rules that would conflict
  // with `prettier --write`.
  // ------------------------------------------------------------------
  prettier,
]
