/**
 * Perspective warp: detected quad → upright page crop.
 */

import type { Quad } from '../types.js'
import type { CanvasLike, CvMat, PipelineDeps } from './deps.js'
import { matFromCanvas, matToCanvas } from './cv-canvas.js'

export interface WarpOps {
  /** Warp `quad` in `source` to a fresh `width`×`height` canvas. */
  warpPerspective(
    source: CanvasLike,
    quad: Quad,
    width: number,
    height: number,
  ): CanvasLike
}

export function createWarpOps({ cv, createCanvas }: PipelineDeps): WarpOps {
  return {
    warpPerspective(source, quad, width, height) {
      const srcMat = matFromCanvas(cv, source)
      const dstMat = new cv.Mat()
      const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        quad.tl.x,
        quad.tl.y,
        quad.tr.x,
        quad.tr.y,
        quad.br.x,
        quad.br.y,
        quad.bl.x,
        quad.bl.y,
      ])
      const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        width,
        0,
        width,
        height,
        0,
        height,
      ])
      let M: CvMat | null = null
      try {
        M = cv.getPerspectiveTransform(srcPoints, dstPoints)
        cv.warpPerspective(
          srcMat,
          dstMat,
          M,
          new cv.Size(width, height),
          cv.INTER_LINEAR,
          cv.BORDER_CONSTANT,
          new cv.Scalar(),
        )
        const out = createCanvas(width, height)
        matToCanvas(out, dstMat)
        return out
      } finally {
        srcMat.delete()
        dstMat.delete()
        srcPoints.delete()
        dstPoints.delete()
        M?.delete()
      }
    },
  }
}
