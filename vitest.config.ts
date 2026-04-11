// Vitest — https://vitest.dev/config/
//
// Single root config covering the whole monorepo. Test files are discovered
// under `packages/*/test/` and `packages/*/src/` (co-located .test.ts) as
// well as `apps/web/test/`.
//
// Environment is `node` by default; tests that need a DOM (Vue component
// tests, etc.) should declare `// @vitest-environment happy-dom` at the
// top of their file once we add @vue/test-utils and happy-dom.
//
// Globals are intentionally disabled — tests must import `describe`, `it`,
// `expect`, etc. explicitly. This keeps the global namespace honest and
// plays well with typescript-eslint's no-unused-vars.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.{test,spec}.ts',
      'packages/*/src/**/*.{test,spec}.ts',
      'apps/web/test/**/*.{test,spec}.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
    ],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/dist/**',
        '**/test/**',
        '**/*.config.*',
        '**/*.d.ts',
        '**/index.ts', // barrel re-exports
      ],
    },
  },
})
