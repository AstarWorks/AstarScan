/**
 * Has the page been turned since the shot? The capture screen keeps a tiny
 * grey view of the camera picture (32×24) and, while it waits for the next
 * page, compares it with the view of the shot.
 *
 * The change is measured over the paper of the shot, not over the whole
 * view: the desk round the book does not change when a page is turned, so
 * the whole view's mean change shrinks with the share of the picture the
 * paper takes. A spread held upright (book 3 `book3-spread-paren-port`,
 * 1080×1920) takes about 40 % of the view; turning a whole leaf moved the
 * whole view's mean by only 14.2–15.0 grey levels (the turn threshold is
 * 14) and in one run a turn never crossed it — the next spread was never
 * judged again and not taken. Inside the paper the same turn changes the
 * view two to three times as much.
 *
 * Pure logic; the caller draws the views.
 */
import type { Point, Quad } from '../types.js'

/** At least this many view cells must lie on the paper to use the mask. */
export const PAPER_MASK_MIN_CELLS = 24

function insideConvex(p: Point, poly: readonly Point[]): boolean {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const z = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (z === 0) continue
    const s = Math.sign(z)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/**
 * Cells of a `cols`×`rows` view of a `vw`×`vh` picture whose centre lies on
 * the paper `quad` (video px). Null when too few do (a tiny or broken
 * frame): the caller then compares the whole view.
 */
export function paperViewMask(
  quad: Quad,
  vw: number,
  vh: number,
  cols = 32,
  rows = 24,
): Uint8Array | null {
  const poly = [quad.tl, quad.tr, quad.br, quad.bl]
  const m = new Uint8Array(cols * rows)
  let n = 0
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const c = { x: ((x + 0.5) * vw) / cols, y: ((y + 0.5) * vh) / rows }
      if (insideConvex(c, poly)) {
        m[y * cols + x] = 1
        n++
      }
    }
  return n >= PAPER_MASK_MIN_CELLS ? m : null
}

/**
 * Mean grey difference of two views over the cells of `mask` (the paper of
 * the shot), or over the whole view without a mask.
 */
export function paperViewChange(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  mask: Uint8Array | null,
): number {
  let s = 0
  let n = 0
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask[i]) continue
    s += Math.abs(a[i]! - b[i]!)
    n++
  }
  return n > 0 ? s / n : 0
}
