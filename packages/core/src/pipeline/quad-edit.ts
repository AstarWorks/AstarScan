/**
 * Quad editing geometry — the pure half of manual corner correction.
 *
 * `CLAUDE.md` lists manual corner correction as Phase 1 required, and
 * `types.ts`'s `updatePageQuad` already specifies the contract. What the
 * detector cannot recover on its own — a corner occluded by a thumb, a
 * page with no contrast against the desk — the user fixes by dragging.
 *
 * Everything a drag needs *except pixels* lives here as pure functions so
 * it can be unit-tested: `apps/web` has no component test harness (no
 * `@vue/test-utils`, no happy-dom), so any geometry left inside the SFC is
 * untestable by construction. `QuadEditor.vue` is the thin shell that
 * turns pointer events into calls on these functions.
 *
 * Coordinate spaces: a `Quad` is always in the pixel space of some frame,
 * and every function here takes that frame's dimensions explicitly rather
 * than assuming one. `scaleQuad` is the only bridge between spaces — the
 * editor renders at CSS size, the re-warp runs at source size.
 *
 * Validity is NOT decided here. `classifyQuad`
 * (`apps/web/app/services/quad-classify.ts`) already rejects non-convex,
 * self-intersecting and too-small quads and is the rule the capture path
 * uses; duplicating those thresholds would split the SSoT.
 */

import type { Point, Quad } from '../types.js'

/** The four corner names, in the clockwise order `Quad` declares them. */
export const QUAD_CORNERS = ['tl', 'tr', 'br', 'bl'] as const

export type QuadCorner = (typeof QUAD_CORNERS)[number]

/** Corners as an ordered list — what a renderer iterates to draw handles. */
export function quadCornerList(
  quad: Quad,
): Array<{ corner: QuadCorner; point: Point }> {
  return QUAD_CORNERS.map((corner) => ({ corner, point: quad[corner] }))
}

/**
 * Which corner the user grabbed, or null if the press landed on none.
 *
 * `maxDist` is the grab radius in the SAME space as `quad` and `p`. The UI
 * derives it from the 44x44 px tap target `CLAUDE.md` requires, converted
 * into image space — a fixed image-space radius would shrink to nothing on
 * a high-resolution source displayed small.
 *
 * Ties go to the earlier corner in clockwise order. Two corners that close
 * together are already a degenerate quad, so the choice only has to be
 * deterministic, not clever.
 */
export function nearestQuadCorner(
  quad: Quad,
  p: Point,
  maxDist: number,
): QuadCorner | null {
  let best: QuadCorner | null = null
  let bestDist = Infinity
  for (const corner of QUAD_CORNERS) {
    const c = quad[corner]
    const d = Math.hypot(c.x - p.x, c.y - p.y)
    // Strictly closer, so an exact tie keeps the earlier corner.
    if (d < bestDist) {
      best = corner
      bestDist = d
    }
  }
  return bestDist <= maxDist ? best : null
}

/** Clamp a point into `[0, w] x [0, h]` — the frame's own bounds. */
export function clampPointToFrame(
  p: Point,
  frameW: number,
  frameH: number,
): Point {
  return {
    x: Math.min(Math.max(p.x, 0), frameW),
    y: Math.min(Math.max(p.y, 0), frameH),
  }
}

/**
 * Move one corner, leaving the other three untouched.
 *
 * The result is clamped to the frame but is NOT otherwise constrained:
 * dragging a corner past its neighbours produces a self-intersecting quad,
 * and that is allowed to happen so the editor can show the user what they
 * did and refuse the save with a reason. Blocking the drag itself would
 * read as the handle being stuck.
 */
export function moveQuadCorner(
  quad: Quad,
  corner: QuadCorner,
  p: Point,
  frameW: number,
  frameH: number,
): Quad {
  const moved = clampPointToFrame(p, frameW, frameH)
  return {
    tl: corner === 'tl' ? moved : quad.tl,
    tr: corner === 'tr' ? moved : quad.tr,
    br: corner === 'br' ? moved : quad.br,
    bl: corner === 'bl' ? moved : quad.bl,
  }
}

/**
 * Re-express a quad from one frame size in another — display space to
 * source space and back. Both dimensions scale independently so a
 * letterboxed preview maps correctly.
 *
 * A zero source dimension yields the quad unchanged rather than NaN
 * corners; that only happens before an image has loaded, where the right
 * behaviour is "nothing to map yet".
 */
export function scaleQuad(
  quad: Quad,
  fromW: number,
  fromH: number,
  toW: number,
  toH: number,
): Quad {
  if (fromW <= 0 || fromH <= 0) return quad
  const sx = toW / fromW
  const sy = toH / fromH
  const map = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy })
  return {
    tl: map(quad.tl),
    tr: map(quad.tr),
    br: map(quad.br),
    bl: map(quad.bl),
  }
}
