#!/usr/bin/env bun
/**
 * Copy the onnxruntime-web WASM runtime into apps/web/public/ort/ so the
 * PWA serves it itself instead of hitting cdn.jsdelivr.net at runtime.
 * Offline-first requirement: the scanner must work with zero network.
 *
 * Resolves onnxruntime-web from apps/web's own dependency graph so the
 * copied binaries always match the bundled JS API version (a mismatch
 * fails at WASM instantiation with an opaque error).
 *
 * Run via `bun scripts/copy-ort-assets.mjs` (wired into apps/web dev/build).
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const webRequire = createRequire(path.join(repoRoot, 'apps/web/package.json'))
const ortPkg = webRequire.resolve('onnxruntime-web/package.json')
const distDir = path.join(path.dirname(ortPkg), 'dist')
const outDir = path.join(repoRoot, 'apps/web/public/ort')

// Single-threaded SIMD is the only configuration we use (see
// ort-model-loader.ts), but ort's browser ESM loader resolves the JSEP
// variant by default (verified via Playwright: it fetches
// ort-wasm-simd-threaded.jsep.mjs), so ship both pairs. All run fine
// with numThreads=1 and no SharedArrayBuffer.
const FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]

await fs.mkdir(outDir, { recursive: true })
const version = JSON.parse(await fs.readFile(ortPkg, 'utf8')).version
for (const f of FILES) {
  await fs.copyFile(path.join(distDir, f), path.join(outDir, f))
}
await fs.writeFile(path.join(outDir, 'VERSION'), version + '\n')
console.log(
  `[copy-ort-assets] onnxruntime-web@${version} → apps/web/public/ort/`,
)
