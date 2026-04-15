/**
 * Ambient type declarations for libraries that ship without their own `.d.ts`
 * or rely on globals (OpenCV.js attaches `cv` to window).
 *
 * This file is an **ambient script** (no top-level `import` / `export`),
 * which is what lets `declare module 'jscanify'` declare a fresh module
 * rather than try to augment a non-existent one. If we add an `export {}`
 * at the top level, `tsc --noEmit` will fail to find declarations for
 * `jscanify` at consumer sites.
 *
 * This file is for apps/web only. Library packages (@astarworks/scan-*) must
 * not depend on any of these symbols at build time — jscanify and cv are
 * loaded at runtime inside the Nuxt app.
 */

// Vue SFC module declarations for plain tsc (vue-tsc handles these natively,
// but our typecheck uses tsc --noEmit as fallback).
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

/**
 * Window augmentation for OpenCV.js. Loaded via `services/opencv-loader.ts`;
 * `cv.imread` becomes available after the WASM runtime initializes.
 */
interface Window {
  cv?: {
    imread?: (canvas: HTMLCanvasElement) => OpenCvMat
    onRuntimeInitialized?: () => void
  }
}

/**
 * Minimal structural type for an OpenCV.js `cv.Mat` instance. Full type
 * information would require pulling in @types/opencv-js which is heavy
 * and mostly unused. We only need the `.delete()` method for WASM heap
 * cleanup — everything else is passed through `unknown`-safe interop.
 */
interface OpenCvMat {
  delete(): void
}

/**
 * Type shim for the `jscanify` npm package. The library ships as CommonJS
 * without bundled types. We expose the high-level (`highlightPaper` /
 * `extractPaper`) and low-level (`findPaperContour` / `getCornerPoints`)
 * APIs we need, with enough structure to stay strict-type clean.
 *
 * https://github.com/puffinsoft/jscanify
 */
declare module 'jscanify' {
  /** 4-corner point set returned by `getCornerPoints`. */
  export interface JscanifyCornerPoints {
    readonly topLeftCorner: { readonly x: number; readonly y: number }
    readonly topRightCorner: { readonly x: number; readonly y: number }
    readonly bottomLeftCorner: { readonly x: number; readonly y: number }
    readonly bottomRightCorner: { readonly x: number; readonly y: number }
  }

  class Jscanify {
    /**
     * Returns a canvas with the detected paper contour drawn as an overlay
     * on the source image. If no paper is detected, the original canvas is
     * returned unchanged.
     */
    highlightPaper(canvas: HTMLCanvasElement): HTMLCanvasElement

    /**
     * Returns a new canvas containing only the detected paper, perspective-
     * corrected to the requested dimensions. When `cornerPoints` is provided,
     * detection is skipped and the given corners are used directly — this
     * is how the `PerspectiveWarper` service re-warps a user-edited quad
     * without re-running jscanify's classical CV pipeline.
     */
    extractPaper(
      canvas: HTMLCanvasElement,
      width: number,
      height: number,
      cornerPoints?: JscanifyCornerPoints,
    ): HTMLCanvasElement

    /**
     * Low-level: returns the largest 4-point contour from a preprocessed
     * OpenCV image. The return value is an `OpenCvMat` that the caller is
     * responsible for `.delete()`-ing.
     *
     * jscanify's behavior on detection miss is historically to return the
     * image bounds as a fallback quad, so callers should sanity-check the
     * resulting corner points against the frame size.
     */
    findPaperContour(img: OpenCvMat): OpenCvMat

    /**
     * Low-level: extracts 4-corner `{x, y}` points from a contour Mat.
     */
    getCornerPoints(
      contour: OpenCvMat,
      img: OpenCvMat,
    ): JscanifyCornerPoints
  }
  export default Jscanify
}
