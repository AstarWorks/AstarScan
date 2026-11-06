/**
 * Book gutter: split a captured two-page spread into its two pages, and
 * pull a single page's frame back to the gutter when it runs past it.
 *
 * Pure logic on a luminance image of the page frame warped upright (the
 * caller warps with OpenCV / the platform). The gutter of an open book is
 * a dark vertical shadow / fold line across the whole height where the
 * pages dip toward the spine. It is looked for separately in an upper and
 * a lower band, so a fold that is not parallel to the frame's edges is
 * followed (same idea as the Android capture screen's GutterTrim.kt).
 *
 * The split itself is done in the camera picture, not in the warped
 * spread: `splitSpreadQuad` maps the gutter back through the frame's
 * homography, so each page is warped (and later flattened) on its own.
 */

import type { Point, Quad } from '../types.js'

export interface GutterLine {
  /** Gutter x at the top / bottom of the warped frame, 0..1 of its width. */
  readonly top: number
  readonly bottom: number
  /**
   * How much darker the fold is than the paper either side (0..1, 0 when
   * nothing was found and the middle was assumed).
   */
  readonly depth: number
}

export const GUTTER_DEFAULTS = {
  /** Spread: the fold is searched between these shares of the width. */
  spreadFrom: 0.3,
  spreadTo: 0.7,
  /** Upper and lower bands (shares of the height). */
  bands: [
    [0.06, 0.42],
    [0.58, 0.94],
  ] as readonly (readonly [number, number])[],
  /** The fold must be at least this much darker than the paper beside it. */
  minDepth: 0.06,
  /** Single page: a fold is looked for this far in from each side. */
  edgeFrom: 0.02,
  edgeTo: 0.28,
  /** ...and must be at least this much darker than the page's paper. */
  edgeMinDepth: 0.2,
  /** ...with the facing page's paper (bright again) beyond it. */
  edgeBeyondRise: 0.3,
  /**
   * ...and as wide as a shadow, not a printed line: at half its depth the
   * folds of the book clips are 8–12 % of the width, a figure's frame or a
   * rule 1.4–1.7 % (single-port-wood p5 / p7).
   */
  edgeMinWidth: 0.025,
} as const

/** Mean luminance of every column of rows [y0, y1), box-smoothed by `win`. */
export function columnProfile(
  lum: ArrayLike<number>,
  w: number,
  h: number,
  y0: number,
  y1: number,
  win = 1,
): Float64Array {
  const a = Math.max(0, Math.min(h, Math.floor(y0)))
  const b = Math.max(a + 1, Math.min(h, Math.ceil(y1)))
  const raw = new Float64Array(w)
  for (let y = a; y < b; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) raw[x]! += lum[row + x] ?? 0
  }
  const n = b - a
  for (let x = 0; x < w; x++) raw[x] = raw[x]! / n
  if (win <= 1) return raw
  const half = Math.floor(win / 2)
  const out = new Float64Array(w)
  let acc = 0
  let cnt = 0
  // Running box sum over [x - half, x + half].
  for (let x = 0; x < Math.min(w, half); x++) {
    acc += raw[x]!
    cnt++
  }
  for (let x = 0; x < w; x++) {
    const add = x + half
    if (add < w) {
      acc += raw[add]!
      cnt++
    }
    const drop = x - half - 1
    if (drop >= 0) {
      acc -= raw[drop]!
      cnt--
    }
    out[x] = acc / cnt
  }
  return out
}

function percentile(
  values: ArrayLike<number>,
  from: number,
  to: number,
  p: number,
): number {
  const arr: number[] = []
  for (let i = Math.max(0, from); i < Math.min(values.length, to); i++)
    arr.push(values[i]!)
  if (arr.length === 0) return 0
  arr.sort((x, y) => x - y)
  return arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]!
}

interface BandFold {
  x: number
  depth: number
}

/** Darkest column of one band inside [from, to) of the width, with its depth below the paper. */
function bandFold(
  prof: Float64Array,
  w: number,
  from: number,
  to: number,
): BandFold {
  const x0 = Math.floor(from * w)
  const x1 = Math.ceil(to * w)
  let best = x0
  for (let x = x0; x < x1 && x < w; x++) if (prof[x]! < prof[best]!) best = x
  // Paper brightness: a high percentile of each half, so print and the
  // fold itself do not pull it down.
  const left = percentile(prof, 0, best, 0.8)
  const right = percentile(prof, best + 1, w, 0.8)
  const paper = Math.min(left, right)
  const depth = paper > 0 ? Math.max(0, (paper - prof[best]!) / paper) : 0
  return { x: best / Math.max(1, w - 1), depth }
}

/**
 * Gutter of a warped two-page spread, or the middle (depth 0) when no fold
 * is clear enough. Never null: a spread is always split in two.
 */
export function findSpreadGutter(
  lum: ArrayLike<number>,
  w: number,
  h: number,
  opts: Partial<typeof GUTTER_DEFAULTS> = {},
): GutterLine {
  const o = { ...GUTTER_DEFAULTS, ...opts }
  const win = Math.max(1, Math.round(w / 120))
  const folds = o.bands.map(([a, b]) =>
    bandFold(
      columnProfile(lum, w, h, a * h, b * h, win),
      w,
      o.spreadFrom,
      o.spreadTo,
    ),
  )
  const [up, low] = folds as [BandFold, BandFold]
  const ok = (f: BandFold) => f.depth >= o.minDepth
  if (ok(up) && ok(low)) {
    // Two bands disagreeing by more than a tenth of the width is not one fold.
    if (Math.abs(up.x - low.x) <= 0.1) {
      // Band centres → the frame's top and bottom edges (linear in y).
      const [ua, ub] = o.bands[0]!
      const [la, lb] = o.bands[1]!
      const yu = (ua + ub) / 2
      const yl = (la + lb) / 2
      const slope = (low.x - up.x) / (yl - yu)
      return {
        top: up.x - slope * yu,
        bottom: up.x + slope * (1 - yu),
        depth: Math.min(up.depth, low.depth),
      }
    }
  }
  const one = ok(up) ? up : ok(low) ? low : null
  if (one) return { top: one.x, bottom: one.x, depth: one.depth }
  return { top: 0.5, bottom: 0.5, depth: 0 }
}

/**
 * A single page whose frame ran past the gutter into the facing page:
 * the fold near the left or right side (dark across the page, with the
 * facing page's bright paper beyond it). Returns the cut as shares of the
 * width from each side (0 = nothing to cut).
 *
 * The fold runs across the page, so it must show in the upper and in the
 * lower band (`bands`, as the spread's fold) at about the same place. A
 * figure's frame is dark in one half only: book clip single-port-wood p7's
 * figure border (lower half 31 % darker than the paper, upper half 9 %) was
 * cut as a fold and took 13 % of the page with its number. And a fold is a
 * shadow, wider than a printed line (`edgeMinWidth`): p5 has a figure in
 * each half, their borders in line.
 */
export function findEdgeGutter(
  lum: ArrayLike<number>,
  w: number,
  h: number,
  opts: Partial<typeof GUTTER_DEFAULTS> = {},
): { left: number; right: number } {
  const o = { ...GUTTER_DEFAULTS, ...opts }
  const win = Math.max(1, Math.round(w / 150))
  const whole = columnProfile(lum, w, h, 0.1 * h, 0.9 * h, win)
  const bands = o.bands.map(([a, b]) =>
    columnProfile(lum, w, h, a * h, b * h, win),
  )
  const fold = (prof: Float64Array, fromLeft: boolean): number => {
    const paper = percentile(prof, 0, w, 0.8)
    if (paper <= 0) return 0
    const a = Math.floor(o.edgeFrom * w)
    const b = Math.ceil(o.edgeTo * w)
    let best = -1
    let bestV = Infinity
    for (let k = a; k < b; k++) {
      const x = fromLeft ? k : w - 1 - k
      if (prof[x]! < bestV) {
        bestV = prof[x]!
        best = k
      }
    }
    if (best < 0 || (paper - bestV) / paper < o.edgeMinDepth) return 0
    // Beyond the fold (toward the edge) the facing page is bright again.
    let beyond = 0
    for (let k = 0; k < best; k++) {
      const x = fromLeft ? k : w - 1 - k
      beyond = Math.max(beyond, prof[x]!)
    }
    if (beyond - bestV < o.edgeBeyondRise * (paper - bestV)) return 0
    // Width of the dip at half its depth.
    const half = (paper + bestV) / 2
    const at = (k: number) => prof[fromLeft ? k : w - 1 - k]!
    let l = best
    while (l > 0 && at(l - 1) < half) l--
    let r = best
    while (r < w - 1 && at(r + 1) < half) r++
    if ((r - l + 1) / w < o.edgeMinWidth) return 0
    return best / w
  }
  const side = (fromLeft: boolean): number => {
    const cut = fold(whole, fromLeft)
    if (cut === 0) return 0
    for (const band of bands) {
      const c = fold(band, fromLeft)
      if (c === 0 || Math.abs(c - cut) > 0.1) return 0
    }
    return cut
  }
  return { left: side(true), right: side(false) }
}

// --- homography (frame ↔ warped rectangle) ---------------------------------

/** 3×3 homography, row-major, h[8] = 1. */
export type Homography = readonly number[]

/** Solve the 8×8 system mapping `src[i]` → `dst[i]` (4 points each). */
export function homographyFrom(
  src: readonly Point[],
  dst: readonly Point[],
): Homography {
  const A: number[][] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!
    const { x: u, y: v } = dst[i]!
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++)
      if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r
    ;[A[c], A[p]] = [A[p]!, A[c]!]
    const piv = A[c]![c]!
    if (Math.abs(piv) < 1e-12) throw new Error('degenerate quad')
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r]![c]! / piv
      if (f === 0) continue
      for (let k = c; k < 9; k++) A[r]![k]! -= f * A[c]![k]!
    }
  }
  const h: number[] = []
  for (let r = 0; r < 8; r++) h.push(A[r]![8]! / A[r]![r]!)
  h.push(1)
  return h
}

export function applyHomography(H: Homography, p: Point): Point {
  const d = H[6]! * p.x + H[7]! * p.y + H[8]!
  return {
    x: (H[0]! * p.x + H[1]! * p.y + H[2]!) / d,
    y: (H[3]! * p.x + H[4]! * p.y + H[5]!) / d,
  }
}

/** Homography from the unit square (0..1 × 0..1, warped frame) to `quad`. */
export function unitToQuad(quad: Quad): Homography {
  return homographyFrom(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    [quad.tl, quad.tr, quad.br, quad.bl],
  )
}

/** Left and right page frames of a spread, in the camera picture. */
export function splitSpreadQuad(
  quad: Quad,
  g: GutterLine,
): { left: Quad; right: Quad } {
  const H = unitToQuad(quad)
  const top = applyHomography(H, { x: g.top, y: 0 })
  const bottom = applyHomography(H, { x: g.bottom, y: 1 })
  return {
    left: { tl: quad.tl, tr: top, br: bottom, bl: quad.bl },
    right: { tl: top, tr: quad.tr, br: quad.br, bl: bottom },
  }
}

/** A page frame cut `left` / `right` (shares of the warped width) from its sides. */
export function trimQuadSides(quad: Quad, left: number, right: number): Quad {
  if (left <= 0 && right <= 0) return quad
  const H = unitToQuad(quad)
  const at = (x: number, y: number) => applyHomography(H, { x, y })
  return {
    tl: at(left, 0),
    tr: at(1 - right, 0),
    br: at(1 - right, 1),
    bl: at(left, 1),
  }
}

/** Width / height of the frame (mean of opposite sides), the paper's aspect. */
export function quadAspect(q: Quad): number {
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)
  const w = (d(q.tl, q.tr) + d(q.bl, q.br)) / 2
  const h = (d(q.tl, q.bl) + d(q.tr, q.br)) / 2
  return h > 0 ? w / h : 0
}

/**
 * A frame wider than this (width / height) holds an open spread; a book
 * page is ~0.7 (A5 148×210 mm, B6 128×182 mm), a spread ~1.4.
 */
export const SPREAD_MIN_ASPECT = 1.0
