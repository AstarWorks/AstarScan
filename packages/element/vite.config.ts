import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import dts from 'vite-plugin-dts'

/**
 * Vite library build for @astarworks/scan-element.
 *
 * This is the **library** build (npm consumers). A second "bundled" build
 * config will be added later for CDN-style drop-in usage (`<script src>`),
 * which bundles Vue + scan-core + scan-vue into a single self-contained
 * element.js file. Keeping the two separate keeps npm consumers small.
 *
 * Externals here:
 * - `vue` — peer dep
 * - `@astarworks/scan-core`, `@astarworks/scan-vue` — workspace deps,
 *   consumers either have them already or get them via transitive install
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
      external: ['vue', '@astarworks/scan-core', '@astarworks/scan-vue'],
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
