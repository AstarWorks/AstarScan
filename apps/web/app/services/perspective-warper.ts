/**
 * Perspective warper using OpenCV.js directly.
 *
 * Previously this re-exported jscanify's `extractPaper` wrapper. Now it
 * calls OpenCV.js's `getPerspectiveTransform` + `warpPerspective` directly,
 * making it independent of any specific detection backend. This means the
 * same warper works whether the caller used JscanifyBackend, DocAligner,
 * or any future backend — the only thing that crosses the boundary is a
 * plain `Quad` object.
 *
 * Requires OpenCV.js to be loaded (via `opencv-loader.ts` or implicitly
 * through `JscanifyBackend.warmUp()`).
 *
 * All `cv.Mat` objects are allocated and freed within this file. Nothing
 * OpenCV-specific crosses the public surface.
 */

import type { Quad } from '@astarworks/scan-core'

/**
 * Minimal typed surface of the OpenCV.js runtime we actually use. This is
 * intentionally NOT in globals.d.ts — it's a private contract between this
 * module and the runtime, scoped to the 5 methods + 3 constants we need.
 * Expanding globals.d.ts with the full cv namespace would be both fragile
 * and misleading (we don't use 99% of OpenCV's API).
 */
interface CvWarpApi {
  imread(canvas: HTMLCanvasElement): CvMat
  imshow(canvas: HTMLCanvasElement, mat: CvMat): void
  matFromArray(rows: number, cols: number, type: number, data: number[]): CvMat
  getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat
  warpPerspective(
    src: CvMat,
    dst: CvMat,
    M: CvMat,
    dsize: CvSize,
    flags?: number,
    borderMode?: number,
    borderValue?: CvScalar,
  ): void
  Mat: new () => CvMat
  Size: new (w: number, h: number) => CvSize
  Scalar: new (v0?: number, v1?: number, v2?: number, v3?: number) => CvScalar
  readonly CV_32FC2: number
  readonly INTER_LINEAR: number
  readonly BORDER_CONSTANT: number
}

interface CvMat {
  delete(): void
}
interface CvSize {
  readonly width: number
  readonly height: number
}
interface CvScalar {
  readonly length: number
}

/**
 * Retrieve the OpenCV.js runtime, asserting that the warp-related API
 * surface is present. This cast is safe because opencv-loader.ts
 * already ensures `window.cv.imread` exists before we reach this point,
 * and the warp functions are part of the same OpenCV build.
 */
function requireCV(): CvWarpApi {
  const cv = window.cv as unknown as CvWarpApi | undefined
  if (!cv?.getPerspectiveTransform) {
    throw new Error(
      'OpenCV.js warpPerspective API is not available. ' +
        'Ensure opencv-loader.ts has completed before calling warpPerspective.',
    )
  }
  return cv
}

/**
 * Apply a perspective transform to `source` using the 4 corners in `quad`,
 * producing an output canvas of `width × height`. This is the "extract
 * the paper from the camera frame" step that comes after boundary
 * detection.
 *
 * The transform maps:
 *   quad.tl → (0, 0)
 *   quad.tr → (width, 0)
 *   quad.br → (width, height)
 *   quad.bl → (0, height)
 *
 * All OpenCV Mat objects are freed in a `finally` block.
 */
export function warpPerspective(
  source: HTMLCanvasElement,
  quad: Quad,
  width: number,
  height: number,
): HTMLCanvasElement {
  const cv = requireCV()

  let srcMat: CvMat | null = null
  let dstMat: CvMat | null = null
  let srcPoints: CvMat | null = null
  let dstPoints: CvMat | null = null
  let transformMatrix: CvMat | null = null

  try {
    srcMat = cv.imread(source)
    dstMat = new cv.Mat()

    srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad.tl.x,
      quad.tl.y,
      quad.tr.x,
      quad.tr.y,
      quad.br.x,
      quad.br.y,
      quad.bl.x,
      quad.bl.y,
    ])

    dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,
      0,
      width,
      0,
      width,
      height,
      0,
      height,
    ])

    transformMatrix = cv.getPerspectiveTransform(srcPoints, dstPoints)
    const dsize = new cv.Size(width, height)

    cv.warpPerspective(
      srcMat,
      dstMat,
      transformMatrix,
      dsize,
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    )

    const output = document.createElement('canvas')
    output.width = width
    output.height = height
    cv.imshow(output, dstMat)

    return output
  } finally {
    srcMat?.delete()
    dstMat?.delete()
    srcPoints?.delete()
    dstPoints?.delete()
    transformMatrix?.delete()
  }
}
