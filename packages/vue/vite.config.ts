import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import dts from 'vite-plugin-dts'

/**
 * Vite library build for @astarworks/scan-vue.
 *
 * Key points:
 * - @vitejs/plugin-vue enables .vue SFC support (composables come first,
 *   components follow once we have UI to ship).
 * - External list: `vue` (peer dep, installer brings their own) and
 *   `@astarworks/scan-core` (workspace dep, resolved at consumer side).
 *   Neither is bundled — if they were, we'd ship duplicate Vue runtimes
 *   and break reactivity identity across boundaries.
 * - vite-plugin-dts with rollupTypes bundles all .d.ts into a single file.
 *   Internal files and cross-package re-exports are inlined.
 */
export default defineConfig({
  plugins: [
    vue(),
    dts({
      include: ['src/**/*.ts', 'src/**/*.vue'],
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
      external: ['vue', '@astarworks/scan-core'],
      output: {
        preserveModules: false,
        globals: {
          vue: 'Vue',
        },
      },
    },
    target: 'es2022',
    sourcemap: true,
    minify: false,
    emptyOutDir: true,
  },
})
