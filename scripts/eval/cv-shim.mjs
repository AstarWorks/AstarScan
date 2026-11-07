/**
 * Load OpenCV in Node via @techstark/opencv-js.
 *
 * Why a top-level `await`: if we instead exported a Promise that
 * consumers await later, the `onRuntimeInitialized` callback we attach
 * here is silently lost — observed reproducibly in this codebase, even
 * though attaching the same callback at the entry module's top-level
 * works fine. Likely an interop quirk between ESM cross-module
 * Promise propagation and Emscripten's one-shot init event. Top-level
 * await sidesteps it: cv-shim resolves the runtime synchronously (from
 * the consumer's POV) and exports the bound runtime as `cv`.
 */

import cvModule from '@techstark/opencv-js'

let resolveReady
const ready = new Promise((r) => {
  resolveReady = r
})

cvModule.onRuntimeInitialized = () => {
  resolveReady()
}

// Top-level await: this module's load is paused until WASM init fires.
await ready

/** OpenCV runtime, fully initialized. Use as `import { cv } from './cv-shim.mjs'`. */
export const cv = cvModule

/** Backwards-compat alias for code that prefers a function. */
export function getCv() {
  return cv
}

export function imageDataToMat(cvRuntime, imageData) {
  const mat = new cvRuntime.Mat(
    imageData.height,
    imageData.width,
    cvRuntime.CV_8UC4,
  )
  mat.data.set(imageData.data)
  return mat
}

export function matToImageData(mat) {
  const out = new Uint8ClampedArray(mat.data.length)
  out.set(mat.data)
  return { data: out, width: mat.cols, height: mat.rows }
}
