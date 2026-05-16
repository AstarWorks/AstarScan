/**
 * Aspect-aware quad classifier.
 *
 * TS port of `scripts/eval/lib/quad-classify.mjs`. Given a detected quad
 * and the source frame dimensions, classifies the rectangle as one of:
 *   - 'card'        business card landscape (aspect 1.50-1.85)
 *   - 'card-tall'   elongated design cards (aspect 1.85-2.15)
 *   - 'a4'          A4 / letter paper (aspect 1.35-1.50)
 *   - 'receipt'     thermal receipt (aspect 2.20-5.00)
 *   - 'other'       anything else (or non-convex / wrong area)
 *
 * Aspect is orientation-invariant (uses max(a, 1/a)).
 *
 * Mode determines the perspective-warp target so downstream OCR and dedup
 * see canonical dimensions. The Node side (`meishi.mjs`) and the browser
 * side (`/batch` page) must agree on these constants, hence the duplication
 * is intentional — both are "the spec".
 */

import type { Quad } from '@astarworks/scan-core'

export type DocumentMode = 'card' | 'card-tall' | 'a4' | 'receipt' | 'other'

export interface QuadClassification {
  readonly mode: DocumentMode
  readonly aspect: number
  readonly area_fraction: number
  readonly rejection_reason?: string
  readonly target?: { width: number; height: number }
}

const ASPECT_BANDS: Record<Exclude<DocumentMode, 'other'>, [number, number]> = {
  card: [1.5, 1.85],
  // card-tall extended to 2.5 — event flyers / promotional cards at
  // aspect 2.0-2.5 are still card-class objects, not receipts.
  'card-tall': [1.85, 2.5],
  a4: [1.35, 1.5],
  receipt: [2.5, 5.0],
}

const MIN_AREA_FRACTION = 0.04
const MAX_AREA_FRACTION = 0.97

// Mode-specific BASE long-side pixel count. Actual target dims are derived
// from the detected quad's own aspect ratio so warpPerspective doesn't
// squash a 1.7:1 card to a 1.59:1 rectangle.
const TARGET_BASE_LONG: Record<Exclude<DocumentMode, 'other'>, number> = {
  card: 1010,
  'card-tall': 1100,
  a4: 1696,
  receipt: 1500,
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

function quadArea(q: Quad): number {
  let s = 0
  const pts = [q.tl, q.tr, q.br, q.bl]
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % 4]!
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

function isConvex(q: Quad): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % 4]!
    const c = pts[(i + 2) % 4]!
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross !== 0) {
      if (sign === 0) sign = cross > 0 ? 1 : -1
      else if (sign * cross < 0) return false
    }
  }
  return true
}

function selfIntersects(q: Quad): boolean {
  const pts = [q.tl, q.tr, q.br, q.bl]
  return segIntersect(pts[0]!, pts[1]!, pts[2]!, pts[3]!) ||
    segIntersect(pts[1]!, pts[2]!, pts[3]!, pts[0]!)
}

function segIntersect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  p4: { x: number; y: number },
): boolean {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }) =>
    (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y)
  const d1 = d(p3, p4, p1)
  const d2 = d(p3, p4, p2)
  const d3 = d(p1, p2, p3)
  const d4 = d(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

export function classifyQuad(
  quad: Quad,
  frameW: number,
  frameH: number,
): QuadClassification {
  if (!isConvex(quad)) {
    return { mode: 'other', aspect: 0, area_fraction: 0, rejection_reason: 'non-convex' }
  }
  if (selfIntersects(quad)) {
    return { mode: 'other', aspect: 0, area_fraction: 0, rejection_reason: 'self-intersecting' }
  }

  const w = (dist(quad.tl, quad.tr) + dist(quad.bl, quad.br)) / 2
  const h = (dist(quad.tl, quad.bl) + dist(quad.tr, quad.br)) / 2
  const aspect = w / h
  const r = Math.max(aspect, 1 / aspect)

  const area = quadArea(quad)
  const area_fraction = area / (frameW * frameH)

  if (area_fraction < MIN_AREA_FRACTION) {
    return { mode: 'other', aspect, area_fraction, rejection_reason: 'too-small' }
  }
  if (area_fraction > MAX_AREA_FRACTION) {
    return { mode: 'other', aspect, area_fraction, rejection_reason: 'too-large' }
  }

  for (const [mode, [lo, hi]] of Object.entries(ASPECT_BANDS) as [
    Exclude<DocumentMode, 'other'>,
    [number, number],
  ][]) {
    if (r >= lo && r <= hi) {
      const longSide = TARGET_BASE_LONG[mode]
      const shortSide = Math.round(longSide / r)
      const target = aspect >= 1
        ? { width: longSide, height: shortSide }
        : { width: shortSide, height: longSide }
      return { mode, aspect, area_fraction, target }
    }
  }
  return {
    mode: 'other',
    aspect,
    area_fraction,
    rejection_reason: `aspect-out-of-band:${r.toFixed(2)}`,
  }
}
