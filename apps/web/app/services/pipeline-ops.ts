/**
 * Browser binding of the shared scan-core pipeline ops.
 *
 * scan-core's cv-dependent ops (sharpness, warp, Otsu detection, ORB) are
 * factories taking `{ cv, createCanvas }`. Here they're bound to the
 * OpenCV.js global (`window.cv`, loaded by opencv-loader) and DOM canvases.
 * The eval harness binds the SAME factories to @napi-rs/canvas + the Node
 * OpenCV runtime — one implementation on both sides.
 */

import {
  createPipelineOps,
  type CanvasLike,
  type CvLike,
  type PipelineOps,
} from '@astarworks/scan-core/pipeline'

export type { PipelineOps }

/** DOM canvas factory. The cast crosses the lib.dom ↔ scan-core
 *  structural-type boundary in one place. */
export function browserCreateCanvas(w: number, h: number): CanvasLike {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c as unknown as CanvasLike
}

let ops: PipelineOps | null = null

/**
 * Pipeline ops bound to the loaded OpenCV.js runtime, or null while
 * OpenCV is still loading / unavailable. Callers degrade gracefully
 * (sharpness 0, no ORB merging) — same contract as the previous
 * window.cv probes.
 */
export function getPipelineOps(): PipelineOps | null {
  if (ops) return ops
  const cv = (window as { cv?: { Mat?: unknown } }).cv
  if (!cv?.Mat) return null
  ops = createPipelineOps({
    cv: cv as unknown as CvLike,
    createCanvas: browserCreateCanvas,
  })
  return ops
}
