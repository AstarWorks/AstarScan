/**
 * Small set of geometric helpers shared between quad-classify, bytetrack-doc
 * and the warp step. TS port of `scripts/eval/lib/quad-geometry.mjs`.
 */

import type { Point, Quad } from '@astarworks/scan-core'

export function centroid(q: Quad): Point {
  return {
    x: (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4,
    y: (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4,
  }
}

export function quadArea(q: Quad): number {
  return (
    Math.abs(
      q.tl.x * q.tr.y -
        q.tr.x * q.tl.y +
        (q.tr.x * q.br.y - q.br.x * q.tr.y) +
        (q.br.x * q.bl.y - q.bl.x * q.br.y) +
        (q.bl.x * q.tl.y - q.tl.x * q.bl.y),
    ) / 2
  )
}

export interface Bbox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export function quadBbox(q: Quad): Bbox {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x]
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y]
  return {
    x1: Math.min(...xs),
    y1: Math.min(...ys),
    x2: Math.max(...xs),
    y2: Math.max(...ys),
  }
}

/** Bounding-box IoU. Good-enough approximation for tracking. */
export function iou(qa: Quad, qb: Quad): number {
  const a = quadBbox(qa)
  const b = quadBbox(qb)
  const ix1 = Math.max(a.x1, b.x1)
  const iy1 = Math.max(a.y1, b.y1)
  const ix2 = Math.min(a.x2, b.x2)
  const iy2 = Math.min(a.y2, b.y2)
  const iw = Math.max(0, ix2 - ix1)
  const ih = Math.max(0, iy2 - iy1)
  const inter = iw * ih
  const aArea = (a.x2 - a.x1) * (a.y2 - a.y1)
  const bArea = (b.x2 - b.x1) * (b.y2 - b.y1)
  const union = aArea + bArea - inter
  return union > 0 ? inter / union : 0
}
