/**
 * Aspect-aware quad classifier — given a detected Quad and the source frame
 * dimensions, decides whether the rectangle is a business card, A4 paper,
 * receipt, or something we should drop.
 *
 * Aspect bands (orientation-invariant — uses max(a,1/a)):
 *   card        1.50 ≤ r ≤ 1.85   JP 名刺 = 91×55 mm = 1.65; international 89×51 mm = 1.74
 *   card-tall   1.85 < r ≤ 2.15   elongated design cards
 *   a4          1.35 ≤ r < 1.50   A4 = 1.414; letter ≈ 1.294 sits just below
 *   receipt     2.20 ≤ r ≤ 5.00   thermal receipts vary wildly
 *   other       everything else (or non-convex, or wrong area)
 *
 * The Quad shape matches `@astarworks/scan-core`: { tl, tr, br, bl } where
 * each corner is { x, y }, listed clockwise from top-left.
 *
 * Returns:
 *   { mode, aspect, area_fraction, rejection_reason? }
 */

const ASPECT_BANDS = {
  card: [1.5, 1.85],
  // card-tall extended to 2.5 to catch event flyers / promotional cards
  // that have slightly elongated proportions but are still business-card
  // class objects (e.g. 倫理法人会 event flyer at aspect 2.475).
  // Real receipts (long thermal-printed strips) only start at 2.5+.
  'card-tall': [1.85, 2.5],
  a4: [1.35, 1.5],
  receipt: [2.5, 5.0],
}

const MIN_AREA_FRACTION = 0.04
const MAX_AREA_FRACTION = 0.97

// Mode-specific BASE long-side pixel count. The actual target dimensions
// are derived from the detected quad's own aspect ratio (see classifyQuad)
// so warpPerspective doesn't squash a 1.7:1 card to a 1.59:1 rectangle.
const TARGET_BASE_LONG = {
  card: 1010,
  'card-tall': 1100,
  a4: 1696,
  receipt: 1500,
}

function dist(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** Shoelace area for a quad given clockwise from TL. */
function quadArea(q) {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let s = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** Convex if every consecutive triplet of edges turns in the same direction. */
function isConvex(q) {
  const pts = [q.tl, q.tr, q.br, q.bl]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    const c = pts[(i + 2) % 4]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (cross !== 0) {
      if (sign === 0) sign = cross > 0 ? 1 : -1
      else if (sign * cross < 0) return false
    }
  }
  return true
}

/** True if any two non-adjacent edges cross. */
function selfIntersects(q) {
  const pts = [q.tl, q.tr, q.br, q.bl]
  // edges: 0=TL-TR, 1=TR-BR, 2=BR-BL, 3=BL-TL
  // non-adjacent pairs: (0,2) and (1,3)
  return (
    segIntersect(pts[0], pts[1], pts[2], pts[3]) ||
    segIntersect(pts[1], pts[2], pts[3], pts[0])
  )
}

function segIntersect(p1, p2, p3, p4) {
  const d1 = direction(p3, p4, p1)
  const d2 = direction(p3, p4, p2)
  const d3 = direction(p1, p2, p3)
  const d4 = direction(p1, p2, p4)
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  )
}

function direction(a, b, c) {
  return (c.x - a.x) * (b.y - a.y) - (b.x - a.x) * (c.y - a.y)
}

/**
 * @param {{tl,tr,br,bl}} quad
 * @param {number} frameW
 * @param {number} frameH
 * @returns {{mode: 'card'|'card-tall'|'a4'|'receipt'|'other',
 *            aspect: number, area_fraction: number, rejection_reason?: string,
 *            target?: {width:number, height:number}}}
 */
export function classifyQuad(quad, frameW, frameH) {
  if (!isConvex(quad)) {
    return {
      mode: 'other',
      aspect: 0,
      area_fraction: 0,
      rejection_reason: 'non-convex',
    }
  }
  if (selfIntersects(quad)) {
    return {
      mode: 'other',
      aspect: 0,
      area_fraction: 0,
      rejection_reason: 'self-intersecting',
    }
  }

  const w = (dist(quad.tl, quad.tr) + dist(quad.bl, quad.br)) / 2
  const h = (dist(quad.tl, quad.bl) + dist(quad.tr, quad.br)) / 2
  const aspect = w / h
  const r = Math.max(aspect, 1 / aspect)

  const area = quadArea(quad)
  const area_fraction = area / (frameW * frameH)

  if (area_fraction < MIN_AREA_FRACTION) {
    return {
      mode: 'other',
      aspect,
      area_fraction,
      rejection_reason: 'too-small',
    }
  }
  if (area_fraction > MAX_AREA_FRACTION) {
    return {
      mode: 'other',
      aspect,
      area_fraction,
      rejection_reason: 'too-large',
    }
  }

  for (const [mode, [lo, hi]] of Object.entries(ASPECT_BANDS)) {
    if (r >= lo && r <= hi) {
      // Derive target dims from the quad's OWN aspect (not a fixed
      // mode size) so the warp preserves the card's natural proportions.
      // The long side is fixed to TARGET_BASE_LONG[mode] for consistent
      // downstream resolution; the short side is computed from r.
      const longSide = TARGET_BASE_LONG[mode]
      const shortSide = Math.round(longSide / r)
      // Honor orientation: if aspect >= 1 (landscape) width=long, else height=long
      const target =
        aspect >= 1
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

export const QUAD_CLASSIFY_DEFAULTS = {
  ASPECT_BANDS,
  MIN_AREA_FRACTION,
  MAX_AREA_FRACTION,
  TARGET_BASE_LONG,
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const exampleCard = {
    tl: { x: 100, y: 100 },
    tr: { x: 760, y: 100 },
    br: { x: 760, y: 500 },
    bl: { x: 100, y: 500 },
  }
  const exampleA4 = {
    tl: { x: 100, y: 100 },
    tr: { x: 800, y: 100 },
    br: { x: 800, y: 1090 },
    bl: { x: 100, y: 1090 },
  }
  const exampleReceipt = {
    tl: { x: 200, y: 100 },
    tr: { x: 400, y: 100 },
    br: { x: 400, y: 800 },
    bl: { x: 200, y: 800 },
  }
  const broken = {
    tl: { x: 100, y: 100 },
    tr: { x: 500, y: 500 },
    br: { x: 500, y: 100 },
    bl: { x: 100, y: 500 },
  }
  console.log('card  :', classifyQuad(exampleCard, 1920, 1080))
  console.log('a4    :', classifyQuad(exampleA4, 1920, 1080))
  console.log('rcpt  :', classifyQuad(exampleReceipt, 1920, 1080))
  console.log('broken:', classifyQuad(broken, 1920, 1080))
}
