/**
 * Canvas ↔ cv.Mat bridge that works in BOTH environments.
 *
 * OpenCV.js's own `cv.imread` / `cv.imshow` assume a real DOM
 * HTMLCanvasElement and are no-op stubs under Node. Going through the 2D
 * context (getImageData / createImageData / putImageData) gives identical
 * pixels everywhere, so the pipeline never calls cv.imread/imshow.
 */

import type { CanvasLike, CvLike, CvMat } from './deps.js'

export function matFromCanvas(cv: CvLike, canvas: CanvasLike): CvMat {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('scan-core: failed to get 2D context for cv read')
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const mat = new cv.Mat(id.height, id.width, cv.CV_8UC4)
  mat.data.set(id.data)
  return mat
}

export function matToCanvas(canvas: CanvasLike, mat: CvMat): void {
  const w = mat.cols
  const h = mat.rows
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('scan-core: failed to get 2D context for cv write')
  const id = ctx.createImageData(w, h)
  ;(id.data as Uint8ClampedArray).set(mat.data)
  ctx.putImageData(id, 0, 0)
}
