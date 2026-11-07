/**
 * Sharpness metrics on the warped page crop.
 *
 * Laplacian variance measures high-frequency energy; Tenengrad (mean Sobel
 * gradient magnitude) measures gradient density. NOTE: both are content-
 * biased — they measure TEXTURE amount, not blur. A fixed absolute gate
 * tuned on dense text silently drops sharp illustration-heavy pages
 * (measured recall loss 4/11 on mp4-1); that's why the segment pipeline
 * pairs the gate with a low-floor rescue pass.
 */

import type { CanvasLike, PipelineDeps } from './deps.js'
import { matFromCanvas } from './cv-canvas.js'

export interface SharpnessOps {
  /** Variance of the Laplacian over the grayscale image. */
  computeLaplacian(canvas: CanvasLike): number
  /** Square root of the mean squared Sobel gradient magnitude. */
  computeTenengrad(canvas: CanvasLike): number
}

export function createSharpnessOps({ cv }: PipelineDeps): SharpnessOps {
  return {
    computeLaplacian(canvas) {
      const src = matFromCanvas(cv, canvas)
      const gray = new cv.Mat()
      const lap = new cv.Mat()
      const mean = new cv.Mat()
      const stddev = new cv.Mat()
      try {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
        cv.Laplacian(gray, lap, cv.CV_64F, 1, 1, 0, cv.BORDER_DEFAULT)
        cv.meanStdDev(lap, mean, stddev)
        const sd = stddev.data64F[0] ?? 0
        return sd * sd
      } finally {
        src.delete()
        gray.delete()
        lap.delete()
        mean.delete()
        stddev.delete()
      }
    },

    computeTenengrad(canvas) {
      const src = matFromCanvas(cv, canvas)
      const gray = new cv.Mat()
      const gx = new cv.Mat()
      const gy = new cv.Mat()
      const gx2 = new cv.Mat()
      const gy2 = new cv.Mat()
      const mag = new cv.Mat()
      try {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
        cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT)
        cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT)
        cv.multiply(gx, gx, gx2)
        cv.multiply(gy, gy, gy2)
        cv.add(gx2, gy2, mag)
        const m = cv.mean(mag)
        return Math.sqrt(m[0] ?? 0)
      } finally {
        src.delete()
        gray.delete()
        gx.delete()
        gy.delete()
        gx2.delete()
        gy2.delete()
        mag.delete()
      }
    },
  }
}
