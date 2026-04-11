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
 * - vite-plugin-dts with rollupTypes: Emits a single bundled `dist/index.d.ts`
 *   so consumers get clean type imports without exposing internal modules.
 * - External: currently empty (core has zero runtime dependencies). When
 *   jscanify / jspdf / onnxruntime-web are added, they belong here so they
 *   are NOT bundled into dist/index.js — consumers install them as peers.
 */
export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      rollupTypes: true,
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
