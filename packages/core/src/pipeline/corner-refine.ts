/**
 * Snap the model's page corners onto the paper edge.
 *
 * The YOLOv8n-pose keypoints of `doc-corners.onnx` land well inside the
 * page (184 px mean corner error on portrait frames), while the same
 * model's box hugs the page (57 px) — docs/corner-accuracy-investigation.md.
 * So the paper edge is searched ONLY inside the box widened by a small
 * margin: Otsu threshold → morphology → largest contour → convex hull →
 * 4-vertex polygon (straight-edge fit), minAreaRect when the hull does not
 * reduce to 4 vertices. Keeping the search inside the box avoids the
 * full-frame OpenCV failure (page + desk in one quad).
 *
 * The snapped quad is used only when it is plausible — convex, at least
 * `minAreaOfBox` of the box, not the whole search window, and covering the
 * model quad's centre. Otherwise the model's own corners are kept.
 */

import type { Point, Quad } from '../types.js'
import type { CanvasLike, CvMat, PipelineDeps } from './deps.js'
import { matFromCanvas } from './cv-canvas.js'
import { orderQuadCorners, rotatedRectCorners } from './detect-otsu.js'
import { quadArea } from './quad-smoother.js'
import type { PixelBox } from './yolo-decode.js'

export const CORNER_REFINE_DEFAULTS = {
  /** Search window = box widened by this fraction of its long side on
   *  every side (the box itself is ~57 px off on 720×1280 frames). */
  boxMargin: 0.08,
  /** A quad smaller than this fraction of the box is not trusted — for
   *  the snapped quad (fall back to the model's) and, via
   *  `boxAgreement`, for the ✓ judgement (`LiveCaptureJudge`). */
  minAreaOfBox: 0.6,
  /** A contour filling more than this fraction of the search window is
   *  the background, not the page. */
  maxAreaOfWindow: 0.95,
  /** The search window is processed at this long side at most. */
  workLongSide: 480,
} as const

export type CornerRefineOptions = {
  -readonly [K in keyof typeof CORNER_REFINE_DEFAULTS]: number
}

export interface CornerRefineResult {
  quad: Quad
  /** True when the snapped quad replaced the model's corners. */
  refined: boolean
  /** Area of the returned quad / area of the model box. */
  boxAgreement: number
}

export function boxArea(b: PixelBox): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0)
}

/** quad area / box area (0 when the box is empty). */
export function boxAgreement(quad: Quad, box: PixelBox): number {
  const a = boxArea(box)
  return a > 0 ? quadArea(quad) / a : 0
}

/** Strictly convex, consistently wound and not self-intersecting. */
export function isConvexQuad(q: Quad): boolean {
  const p = [q.tl, q.tr, q.br, q.bl]
  let sign = 0
  for (let i = 0; i < 4; i += 1) {
    const a = p[i]!
    const b = p[(i + 1) % 4]!
    const c = p[(i + 2) % 4]!
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) return false
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Point inside a convex quad (either winding). */
export function quadContains(q: Quad, pt: Point): boolean {
  const p = [q.tl, q.tr, q.br, q.bl]
  let sign = 0
  for (let i = 0; i < 4; i += 1) {
    const a = p[i]!
    const b = p[(i + 1) % 4]!
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x)
    const s = Math.sign(cross)
    if (s === 0) continue
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

function centre(q: Quad): Point {
  return {
    x: (q.tl.x + q.tr.x + q.br.x + q.bl.x) / 4,
    y: (q.tl.y + q.tr.y + q.br.y + q.bl.y) / 4,
  }
}

/** Points of an Nx1 CV_32SC2 contour / polygon. */
function matPoints(m: CvMat): Point[] {
  const d = m.data32S
  const out: Point[] = []
  for (let i = 0; i + 1 < d.length; i += 2) out.push({ x: d[i]!, y: d[i + 1]! })
  return out
}

export interface CornerRefineOps {
  /**
   * Snap `quad` (the model's corners) onto the paper edge found inside
   * `box` (the model's box), both in `frame` pixels.
   */
  refineCorners(
    frame: CanvasLike,
    quad: Quad,
    box: PixelBox,
    opts?: Partial<CornerRefineOptions>,
  ): CornerRefineResult
}

export function createCornerRefiner({
  cv,
  createCanvas,
}: PipelineDeps): CornerRefineOps {
  /** Paper outline inside the window canvas, in window pixels. */
  function findPaper(win: CanvasLike, maxArea: number): Point[] | null {
    const src = matFromCanvas(cv, win)
    const gray = new cv.Mat()
    const binary = new cv.Mat()
    const contours = new cv.MatVector()
    const hierarchy = new cv.Mat()
    const hull = new cv.Mat()
    const approx = new cv.Mat()
    const k = Math.max(3, Math.round(Math.min(win.width, win.height) * 0.02))
    const kernel = cv.getStructuringElement(
      cv.MORPH_RECT,
      new cv.Size(k | 1, k | 1),
    )
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
      cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)
      cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel)
      cv.morphologyEx(binary, binary, cv.MORPH_OPEN, kernel)
      cv.findContours(
        binary,
        contours,
        hierarchy,
        cv.RETR_EXTERNAL,
        cv.CHAIN_APPROX_SIMPLE,
      )
      let bestIdx = -1
      let bestArea = 0
      for (let i = 0; i < contours.size(); i += 1) {
        const c = contours.get(i)
        const a = cv.contourArea(c)
        if (a > bestArea) {
          bestArea = a
          bestIdx = i
        }
        c.delete()
      }
      if (bestIdx < 0 || bestArea > maxArea) return null
      const best = contours.get(bestIdx)
      try {
        cv.convexHull(best, hull, false, true)
      } finally {
        best.delete()
      }
      // Straight-edge fit: the hull reduced to 4 vertices. Hand notches
      // and rounded corners vanish in the hull; growing epsilon removes
      // the remaining short edges.
      const peri = cv.arcLength(hull, true)
      for (const eps of [0.02, 0.03, 0.045, 0.06, 0.08]) {
        cv.approxPolyDP(hull, approx, eps * peri, true)
        if (approx.rows === 4) return matPoints(approx)
        if (approx.rows < 4) break
      }
      return rotatedRectCorners(cv.minAreaRect(hull))
    } finally {
      src.delete()
      gray.delete()
      binary.delete()
      contours.delete()
      hierarchy.delete()
      hull.delete()
      approx.delete()
      kernel.delete()
    }
  }

  return {
    refineCorners(frame, quad, box, opts = {}) {
      const o = { ...CORNER_REFINE_DEFAULTS, ...opts }
      const keep: CornerRefineResult = {
        quad,
        refined: false,
        boxAgreement: boxAgreement(quad, box),
      }
      const bw = box.x1 - box.x0
      const bh = box.y1 - box.y0
      if (!(bw > 1 && bh > 1)) return keep
      const m = o.boxMargin * Math.max(bw, bh)
      const x0 = Math.max(0, Math.floor(box.x0 - m))
      const y0 = Math.max(0, Math.floor(box.y0 - m))
      const x1 = Math.min(frame.width, Math.ceil(box.x1 + m))
      const y1 = Math.min(frame.height, Math.ceil(box.y1 + m))
      const ww = x1 - x0
      const wh = y1 - y0
      if (ww < 8 || wh < 8) return keep
      const s = Math.min(1, o.workLongSide / Math.max(ww, wh))
      const cw = Math.max(1, Math.round(ww * s))
      const ch = Math.max(1, Math.round(wh * s))
      const win = createCanvas(cw, ch)
      const ctx = win.getContext('2d', { willReadFrequently: true })
      if (!ctx) return keep
      ctx.drawImage(frame, x0, y0, ww, wh, 0, 0, cw, ch)

      const pts = findPaper(win, o.maxAreaOfWindow * cw * ch)
      if (!pts || pts.length !== 4) return keep
      const sx = ww / cw
      const sy = wh / ch
      const snapped = orderQuadCorners(
        pts.map((p) => ({ x: x0 + p.x * sx, y: y0 + p.y * sy })),
      )
      const agreement = boxAgreement(snapped, box)
      if (
        !isConvexQuad(snapped) ||
        agreement < o.minAreaOfBox ||
        !quadContains(snapped, centre(quad))
      )
        return keep
      return { quad: snapped, refined: true, boxAgreement: agreement }
    },
  }
}
