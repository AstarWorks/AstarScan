/**
 * Snap the model's page corners onto the paper edge.
 *
 * The YOLOv8n-pose keypoints of `doc-corners.onnx` land well inside the
 * page (184 px mean corner error on portrait frames), while the same
 * model's box hugs the page (57 px) — docs/corner-accuracy-investigation.md.
 * So the paper edge is searched ONLY inside the box widened by a small
 * margin: Otsu threshold → morphology → largest contour → convex hull →
 * 4-vertex polygon (straight-edge fit), minAreaRect when the hull does not
 * reduce to 4 vertices. If that finds nothing plausible, a second Otsu over
 * the bright pixels only is tried (paper on a light desk). Keeping the search inside the box avoids the
 * full-frame OpenCV failure (page + desk in one quad).
 *
 * When the paper runs into a side of the window (the box was short there)
 * that side is widened and the search repeated, a bounded number of times.
 *
 * The snapped quad is used only when it is plausible — convex, between
 * `minAreaOfBox` and `maxAreaOfBox` of the box, not the whole search
 * window, and covering the model quad's centre. Otherwise the model's own
 * corners are kept.
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
  /** ...and one larger than this is page + desk, not the page. */
  maxAreaOfBox: 1.8,
  /** When the paper runs into a side of the search window (the box was
   *  off there), that side is widened by this fraction of the box's long
   *  side and the search repeated, at most `maxGrow` times. */
  growStep: 0.25,
  maxGrow: 2,
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

/**
 * Otsu threshold over the pixels of `gray` brighter than `above`; null
 * when too few such pixels or no spread.
 */
export function otsuAbove(
  gray: ArrayLike<number>,
  above: number,
): number | null {
  const hist = new Array<number>(256).fill(0)
  let n = 0
  for (let i = 0; i < gray.length; i += 1) {
    const v = gray[i]!
    if (v > above) {
      hist[v] = hist[v]! + 1
      n += 1
    }
  }
  if (n < 64) return null
  let sum = 0
  for (let v = 0; v < 256; v += 1) sum += v * hist[v]!
  let wB = 0
  let sumB = 0
  let best = -1
  let bestT: number | null = null
  for (let t = 0; t < 255; t += 1) {
    wB += hist[t]!
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += t * hist[t]!
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      bestT = t
    }
  }
  return bestT
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
    /** Other pages the model found (e.g. the facing page of an open
     *  book). Blacked out in the search window outside `box`, so the
     *  paper found is this page only — without it the window around one
     *  page of a spread holds both and the snap fails. */
    exclude?: readonly PixelBox[],
  ): CornerRefineResult
}

export function createCornerRefiner({
  cv,
  createCanvas,
}: PipelineDeps): CornerRefineOps {
  /** Paper outline inside the window canvas, in window pixels: its 4
   *  corners and the bounding box of its hull. */
  function findPaper(
    win: CanvasLike,
    maxArea: number,
    level: number,
  ): { corners: Point[]; bounds: PixelBox } | null {
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
      const t1 = cv.threshold(
        gray,
        binary,
        0,
        255,
        cv.THRESH_BINARY | cv.THRESH_OTSU,
      )
      if (level > 0) {
        // Second level: Otsu over the bright side only. On a light desk
        // the first split is ink vs (paper + desk); this one separates
        // paper from desk.
        const t2 = otsuAbove(gray.data, t1)
        if (t2 === null) return null
        cv.threshold(gray, binary, t2, 255, cv.THRESH_BINARY)
      }
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
      const hp = matPoints(hull)
      const bounds: PixelBox = {
        x0: Math.min(...hp.map((p) => p.x)),
        y0: Math.min(...hp.map((p) => p.y)),
        x1: Math.max(...hp.map((p) => p.x)),
        y1: Math.max(...hp.map((p) => p.y)),
      }
      const peri = cv.arcLength(hull, true)
      for (const eps of [0.02, 0.03, 0.045, 0.06, 0.08]) {
        cv.approxPolyDP(hull, approx, eps * peri, true)
        if (approx.rows === 4) return { corners: matPoints(approx), bounds }
        if (approx.rows < 4) break
      }
      return { corners: rotatedRectCorners(cv.minAreaRect(hull)), bounds }
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
    refineCorners(frame, quad, box, opts = {}, exclude = []) {
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
      const attempt = (level: number): CornerRefineResult | null => {
        let win: PixelBox = {
          x0: Math.max(0, Math.floor(box.x0 - m)),
          y0: Math.max(0, Math.floor(box.y0 - m)),
          x1: Math.min(frame.width, Math.ceil(box.x1 + m)),
          y1: Math.min(frame.height, Math.ceil(box.y1 + m)),
        }
        let snapped: Quad | null = null
        for (let pass = 0; pass <= o.maxGrow && !snapped; pass += 1) {
          const ww = win.x1 - win.x0
          const wh = win.y1 - win.y0
          if (ww < 8 || wh < 8) return null
          const s = Math.min(1, o.workLongSide / Math.max(ww, wh))
          const cw = Math.max(1, Math.round(ww * s))
          const ch = Math.max(1, Math.round(wh * s))
          const canvas = createCanvas(cw, ch)
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) return null
          ctx.drawImage(frame, win.x0, win.y0, ww, wh, 0, 0, cw, ch)
          if (exclude.length) {
            const toWin = (b: PixelBox) => ({
              x0: Math.max(0, (b.x0 - win.x0) * s),
              y0: Math.max(0, (b.y0 - win.y0) * s),
              x1: Math.min(cw, (b.x1 - win.x0) * s),
              y1: Math.min(ch, (b.y1 - win.y0) * s),
            })
            ctx.fillStyle = '#000'
            for (const ex of exclude) {
              const r = toWin(ex)
              if (r.x1 > r.x0 && r.y1 > r.y0)
                ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
            }
            // Put this page's own box back where the boxes overlap.
            const own = toWin(box)
            if (own.x1 > own.x0 && own.y1 > own.y0)
              ctx.drawImage(
                frame,
                win.x0 + own.x0 / s,
                win.y0 + own.y0 / s,
                (own.x1 - own.x0) / s,
                (own.y1 - own.y0) / s,
                own.x0,
                own.y0,
                own.x1 - own.x0,
                own.y1 - own.y0,
              )
          }
          const found = findPaper(canvas, o.maxAreaOfWindow * cw * ch, level)
          if (!found || found.corners.length !== 4) return null
          // The paper runs into a window edge that is not the frame edge:
          // the box was off on that side. Widen the window there and retry.
          const touch = 2
          const grow = o.growStep * Math.max(bw, bh)
          const next: PixelBox = {
            x0:
              found.bounds.x0 <= touch && win.x0 > 0
                ? Math.max(0, Math.floor(win.x0 - grow))
                : win.x0,
            y0:
              found.bounds.y0 <= touch && win.y0 > 0
                ? Math.max(0, Math.floor(win.y0 - grow))
                : win.y0,
            x1:
              found.bounds.x1 >= cw - 1 - touch && win.x1 < frame.width
                ? Math.min(frame.width, Math.ceil(win.x1 + grow))
                : win.x1,
            y1:
              found.bounds.y1 >= ch - 1 - touch && win.y1 < frame.height
                ? Math.min(frame.height, Math.ceil(win.y1 + grow))
                : win.y1,
          }
          const grew =
            next.x0 !== win.x0 ||
            next.y0 !== win.y0 ||
            next.x1 !== win.x1 ||
            next.y1 !== win.y1
          if (grew && pass < o.maxGrow) {
            win = next
            continue
          }
          if (grew) return null // still clipped after the last widening
          const sx = ww / cw
          const sy = wh / ch
          const x0 = win.x0
          const y0 = win.y0
          snapped = orderQuadCorners(
            found.corners.map((p) => ({ x: x0 + p.x * sx, y: y0 + p.y * sy })),
          )
        }
        if (!snapped) return null
        const agreement = boxAgreement(snapped, box)
        if (
          !isConvexQuad(snapped) ||
          agreement < o.minAreaOfBox ||
          agreement > o.maxAreaOfBox ||
          !quadContains(snapped, centre(quad))
        )
          return null
        return { quad: snapped, refined: true, boxAgreement: agreement }
      }
      return attempt(0) ?? attempt(1) ?? keep
    },
  }
}
