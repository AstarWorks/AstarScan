/**
 * Curvature correction ("dewarp") of one page of an open book — the edge
 * fit of the Android capture screen's PageFlatten.kt, as pure logic.
 *
 * An open book's page arches up from the spine, so seen from above its top
 * and bottom edges bow outward between the corners and the text lines bow
 * with them. The caller warps the page with a margin around its four
 * corners (`margin` of the page on every side) to an `ew`×`eh` picture,
 * passes its luminance here, and gets the paper's top and bottom edges as
 * curves y(u) = c + a·u(1−u) + b·u²(1−u) (u: 0..1 across the page). It then
 * stretches every column so the top curve goes to the first row and the
 * bottom curve to the last (a cylinder model: straight along the spine,
 * curved across). Null when the edges are not found well enough — the
 * caller keeps the straight four-corner warp.
 *
 * Constants and steps as PageFlatten.kt (measured there on the book clips
 * and the emulator runs 25–26): 60 columns, a step into brighter paper over
 * ±3 rows of at least 10 grey levels, ≥ 45 % of the columns on one curve,
 * no edge moved more than 6 % of the page height; a second try with a 10 %
 * margin and a fit started from the median row.
 */

export interface EdgeCurve {
  readonly c: number
  readonly a: number
  readonly b: number
  readonly inliers: number
}

export function curveAt(k: EdgeCurve, u: number): number {
  return k.c + k.a * u * (1 - u) + k.b * u * u * (1 - u)
}

export const PAGE_FLATTEN = {
  margin: 0.05,
  marginWide: 0.1,
  search: 0.03,
  maxBow: 0.06,
  columns: 60,
  minInliers: 0.45,
  stepSpan: 3,
  minStep: 10,
} as const

export interface FlattenGeometry {
  /** Page size the result is drawn at. */
  readonly ow: number
  readonly oh: number
  /** Margin in px on each side (round(ow · margin), round(oh · margin)). */
  readonly mx: number
  readonly my: number
}

export function flattenGeometry(
  ow: number,
  oh: number,
  margin: number,
): FlattenGeometry & { ew: number; eh: number } {
  const mx = Math.round(ow * margin)
  const my = Math.round(oh * margin)
  return { ow, oh, mx, my, ew: ow + 2 * mx, eh: oh + 2 * my }
}

function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((row, i) => [row[0]!, row[1]!, row[2]!, b[i]!])
  for (let c = 0; c < 3; c++) {
    let p = c
    for (let i = c + 1; i < 3; i++)
      if (Math.abs(m[i]![c]!) > Math.abs(m[p]![c]!)) p = i
    if (Math.abs(m[p]![c]!) < 1e-12) return null
    ;[m[c], m[p]] = [m[p]!, m[c]!]
    for (let i = 0; i < 3; i++) {
      if (i === c) continue
      const f = m[i]![c]! / m[c]![c]!
      for (let j = c; j < 4; j++) m[i]![j]! -= f * m[c]![j]!
    }
  }
  return [0, 1, 2].map((i) => m[i]![3]! / m[i]![i]!)
}

function lsq(
  us: number[],
  ys: number[],
  idx: number[] | null,
): EdgeCurve | null {
  const ix = idx ?? us.map((_, i) => i)
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const r = [0, 0, 0]
  for (const i of ix) {
    const u = us[i]!
    const f = [1, u * (1 - u), u * u * (1 - u)]
    for (let p = 0; p < 3; p++) {
      for (let q = 0; q < 3; q++) n[p]![q]! += f[p]! * f[q]!
      r[p]! += f[p]! * ys[i]!
    }
  }
  const s = solve3(n, r)
  return s ? { c: s[0]!, a: s[1]!, b: s[2]!, inliers: ix.length } : null
}

/**
 * The paper edge between rows `from` (outside) and `to` (inside) in every
 * sampled column, and the curve through them; `straight` is the row the
 * four-corner warp put the edge on.
 */
export function fitPageEdge(
  lum: ArrayLike<number>,
  w: number,
  h: number,
  x0: number,
  pw: number,
  from: number,
  to: number,
  straight: number,
  ph: number,
  robust: boolean,
): { curve: EdgeCurve | null; why: string } {
  const P = PAGE_FLATTEN
  const dir = to > from ? 1 : -1
  const us: number[] = []
  const ys: number[] = []
  for (let k = 0; k < P.columns; k++) {
    const u = 0.04 + (0.92 * k) / (P.columns - 1)
    const x = Math.min(w - 3, Math.max(2, Math.round(x0 + u * pw)))
    let best = 0
    let bestY = -1
    for (
      let y = from + dir * (P.stepSpan + 1);
      (to - y) * dir > 0 && y + P.stepSpan < h && y - P.stepSpan >= 0;
      y += dir
    ) {
      let g = 0
      for (let dx = -2; dx <= 2; dx++)
        g +=
          (lum[(y + dir * P.stepSpan) * w + x + dx] ?? 0) -
          (lum[(y - dir * P.stepSpan) * w + x + dx] ?? 0)
      const v = g / 5
      if (v > best + 1e-6) {
        best = v
        bestY = y
      }
    }
    if (bestY >= 0 && best >= P.minStep) {
      us.push(u)
      ys.push(bestY)
    }
  }
  const need = P.columns * P.minInliers
  if (us.length < need)
    return {
      curve: null,
      why: `${us.length}/${P.columns} columns with an edge step`,
    }
  let fit = lsq(us, ys, null)
  if (!fit) return { curve: null, why: 'no curve fit' }
  const tol = Math.max(2, ph * 0.012)
  let keep = us
    .map((_, i) => i)
    .filter((i) => Math.abs(ys[i]! - curveAt(fit!, us[i]!)) <= tol)
  if (robust && keep.length < need) {
    const med = [...ys].sort((a, b) => a - b)[Math.floor(ys.length / 2)]!
    let idx = us
      .map((_, i) => i)
      .filter((i) => Math.abs(ys[i]! - med) <= 2 * tol)
    for (let round = 0; round < 3; round++) {
      if (idx.length < 3) break
      const f = lsq(us, ys, idx)
      if (!f) break
      fit = f
      idx = us
        .map((_, i) => i)
        .filter((i) => Math.abs(ys[i]! - curveAt(f, us[i]!)) <= tol)
    }
    keep = idx
  }
  if (keep.length < need)
    return {
      curve: null,
      why: `${us.length}/${P.columns} columns with an edge step, ${keep.length} on one curve`,
    }
  fit = lsq(us, ys, keep)
  if (!fit) return { curve: null, why: 'no curve fit' }
  for (let i = 0; i <= 20; i++) {
    const d = Math.abs(curveAt(fit, i / 20) - straight)
    if (d > ph * P.maxBow)
      return {
        curve: null,
        why: `bows ${((d / ph) * 100).toFixed(1)} % of the page height`,
      }
  }
  return { curve: { ...fit, inliers: keep.length }, why: '' }
}

export interface PageEdges {
  readonly top: EdgeCurve
  readonly bottom: EdgeCurve
  /** Largest outward move of the top / bottom edge, share of the page height. */
  readonly topBow: number
  readonly bottomBow: number
}

/** Top and bottom paper edges of a page warped with margin `g`, or why not. */
export function fitPageEdges(
  lum: ArrayLike<number>,
  g: FlattenGeometry & { ew: number; eh: number },
  robust: boolean,
): { edges: PageEdges | null; why: string } {
  const P = PAGE_FLATTEN
  const reach = g.my + Math.round(g.oh * P.search)
  const top = fitPageEdge(
    lum,
    g.ew,
    g.eh,
    g.mx,
    g.ow,
    0,
    reach,
    g.my,
    g.oh,
    robust,
  )
  if (!top.curve) return { edges: null, why: `top edge: ${top.why}` }
  const bottom = fitPageEdge(
    lum,
    g.ew,
    g.eh,
    g.mx,
    g.ow,
    g.eh - 1,
    g.eh - 1 - reach,
    g.my + g.oh,
    g.oh,
    robust,
  )
  if (!bottom.curve) return { edges: null, why: `bottom edge: ${bottom.why}` }
  let minTop = Infinity
  let maxBottom = -Infinity
  for (let i = 0; i <= 50; i++) {
    minTop = Math.min(minTop, curveAt(top.curve, i / 50))
    maxBottom = Math.max(maxBottom, curveAt(bottom.curve, i / 50))
  }
  return {
    edges: {
      top: top.curve,
      bottom: bottom.curve,
      topBow: (g.my - minTop) / g.oh,
      bottomBow: (maxBottom - (g.my + g.oh)) / g.oh,
    },
    why: '',
  }
}
