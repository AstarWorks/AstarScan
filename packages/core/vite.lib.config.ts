import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

/**
 * Vite library build for @astarworks/scan-core.
 *
 * - ES module only (no UMD / CJS): Modern consumers are ESM-first, and we
 *   don't want to ship two copies of the code.
 * - No minification: Libraries should ship readable code; consumers run
 *   their own minifier, and debugging is easier with unmangled names.
 * - vite-plugin-dts without rollupTypes: Emits a per-source-file .d.ts tree
 *   (dist/index.d.ts, dist/types.d.ts, …). rollupTypes pulls in
 *   @microsoft/api-extractor, which has a fragile peer-dep chain on
 *   ajv-draft-04 → ajv that breaks in some CI environments (notably
 *   Cloudflare Pages' npm install). Multi-file dts is fully equivalent
 *   for consumers — they still `import type { X } from '@astarworks/scan-core'`.
 * - External: currently empty (core has zero runtime dependencies). When
 *   jscanify / jspdf / onnxruntime-web are added, they belong here so they
 *   are NOT bundled into dist/index.js — consumers install them as peers.
 */
export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      tsconfigPath: './tsconfig.json',
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [],
      output: {
        preserveModules: false,
      },
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    emptyOutDir: true,
  },
})
