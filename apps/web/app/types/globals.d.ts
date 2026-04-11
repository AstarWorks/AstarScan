/**
 * Ambient type declarations for libraries that ship without their own `.d.ts`
 * or rely on globals (OpenCV.js attaches `cv` to window).
 *
 * This file is for apps/web only. Library packages (@astarworks/scan-*) must
 * not depend on any of these symbols at build time — jscanify and cv are
 * loaded at runtime inside the Nuxt app.
 */

export {}

declare global {
  interface Window {
    /**
     * OpenCV.js runtime handle. Loaded via a `<script>` tag in
     * `pages/index.vue`; `cv.imread` becomes available after
     * `onRuntimeInitialized` fires.
     */
    cv?: {
      imread?: (canvas: HTMLCanvasElement) => unknown
      onRuntimeInitialized?: () => void
    }
  }
}

/**
 * Minimal type shim for the `jscanify` npm package. The library ships as
 * CommonJS without bundled types. We only use two methods, so a thin shim
 * keeps us strict-type clean without pulling in OpenCV.js types.
 *
 * https://github.com/puffinsoft/jscanify
 */
declare module 'jscanify' {
  class Jscanify {
    /**
     * Returns a canvas with the detected paper contour drawn as an overlay
     * on the source image. If no paper is detected, the original canvas is
     * returned unchanged.
     */
    highlightPaper(canvas: HTMLCanvasElement): HTMLCanvasElement
    /**
     * Returns a new canvas containing only the detected paper, perspective-
     * corrected to the requested dimensions. Throws (or returns empty) if
     * no paper is detected.
     */
    extractPaper(
      canvas: HTMLCanvasElement,
      width: number,
      height: number,
    ): HTMLCanvasElement
  }
  export default Jscanify
}
