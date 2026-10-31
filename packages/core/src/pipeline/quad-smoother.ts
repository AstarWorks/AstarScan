/**
 * Per-track EMA smoothing of detected quads.
 *
 * YOLO keypoints jitter a few pixels frame-to-frame; the perspective warp
 * amplifies that into whole-crop content shift, which inflates the
 * consecutive-frame pHash distance (measured median 49 vs OpenCV's 20 on
 * mp4-1) far past the cluster threshold — the root cause of same-page
 * over-splits. Smoothing the quad over time kills the jitter at the
 * source instead of compensating downstream with looser thresholds.
 *
 * Reset semantics: smoothing must NOT bridge page turns or camera jumps,
 * so the state resets when the new quad's bbox-IoU against the previous
 * smoothed quad drops below `iouReset`, or when more than `maxGapFrames`
 * elapsed since the last detection (page-turn blur gap).
 */

import type { Point, Quad } from '../types.js'

/** Shoelace area of a quad. */
export function quadArea(q: Quad): number {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x]
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y]
  let s = 0
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4
    s += (xs[i] ?? 0) * (ys[j] ?? 0) - (xs[j] ?? 0) * (ys[i] ?? 0)
  }
  return Math.abs(s) / 2
}

function bboxIou(a: Quad, b: Quad): number {
  const box = (q: Quad) => {
    const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x]
    const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y]
    return {
      x0: Math.min(...xs),
      y0: Math.min(...ys),
      x1: Math.max(...xs),
      y1: Math.max(...ys),
    }
  }
  const A = box(a)
  const B = box(b)
  const ix = Math.max(0, Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0))
  const iy = Math.max(0, Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0))
  const inter = ix * iy
  const areaA = (A.x1 - A.x0) * (A.y1 - A.y0)
  const areaB = (B.x1 - B.x0) * (B.y1 - B.y0)
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

export class QuadSmoother {
  private readonly alpha: number
  private readonly iouReset: number
  private readonly maxGapFrames: number
  private prev: Quad | null = null
  private prevIdx: number | null = null

  constructor(
    alpha = 0.6,
    opts: { iouReset?: number; maxGapFrames?: number } = {},
  ) {
    this.alpha = alpha
    this.iouReset = opts.iouReset ?? 0.6
    this.maxGapFrames = opts.maxGapFrames ?? 5
  }

  /** Returns the smoothed quad; mutates internal state. */
  apply(quad: Quad, idx: number): Quad {
    const gapped =
      this.prevIdx !== null && idx - this.prevIdx > this.maxGapFrames
    if (!this.prev || gapped || bboxIou(this.prev, quad) < this.iouReset) {
      this.prev = quad
      this.prevIdx = idx
      return quad
    }
    const a = this.alpha
    const mix = (p: Point, c: Point): Point => ({
      x: a * c.x + (1 - a) * p.x,
      y: a * c.y + (1 - a) * p.y,
    })
    const sm: Quad = {
      tl: mix(this.prev.tl, quad.tl),
      tr: mix(this.prev.tr, quad.tr),
      br: mix(this.prev.br, quad.br),
      bl: mix(this.prev.bl, quad.bl),
    }
    this.prev = sm
    this.prevIdx = idx
    return sm
  }
}
