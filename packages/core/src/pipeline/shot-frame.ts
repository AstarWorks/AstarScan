/**
 * The frame of the shot: where the paper's corners are at the moment the
 * capture screen takes the page, from the corner model's detections over
 * the still spell (the frames since the paper came to rest).
 *
 * A heat-map corner model (DocAligner) can read a corner in two places on
 * a page held still — the paper's corner, and a shadow or crease a third
 * of the way down the edge — and switch between them from frame to frame.
 * The median of the last detections then takes whichever reading had the
 * majority (book 3's framed single page 137: the top-left corner read at
 * (71, 116) in 6 frames of the spell and at (93, 320) in 7, the shot took
 * the latter, the frame covered 85 % of the page and the page went
 * unshown). Taking the corner from the detections the model was surest of
 * helped there (the wrong reading peaked at 0.42–0.69 against 0.77–0.85),
 * but not on the same page at 1080×1920 (run12): the reading a third of
 * the way down the edge, (128, 445), peaked at 0.70–0.77 and the corner's
 * at 0.58–0.73, and the frame covered 89 %.
 *
 * What the wrong readings share is that they lie INSIDE the page: a crease,
 * a shadow or a thumb along the edge, never beyond the paper. So the
 * detections of each corner are grouped by place (within `cluster` of the
 * frame's diagonal of each other); among the places read often enough to
 * be a reading and not a flicker (`minSure` detections and `minShare` of
 * the spell), the one furthest out from the frame's centre is the paper's
 * corner. The corner is the per-coordinate median of the last `recent`
 * detections there (the recent ones follow the hand; the whole spell's
 * median lagged it). A spell where no place is read that often takes the
 * median of its last detections. Pure logic; the caller keeps the spell.
 */
import type { Point, Quad } from '../types.js'

export interface CornerDetection {
  readonly quad: Quad
  /**
   * How sure the model is of each corner, in `tl, tr, br, bl` order
   * (0..1). Kept for the caller's logs; the frame no longer depends on it.
   */
  readonly peaks: readonly [number, number, number, number]
}

export const SHOT_FRAME_DEFAULTS = {
  /** Detections of a corner this close (share of the frame's diagonal) read the same place. */
  cluster: 0.04,
  /** The last this many detections of the chosen place give the corner (median). */
  recent: 5,
  /** A place read fewer times than this is a flicker, not a reading. */
  minSure: 3,
  /** ...and read in fewer than this share of the spell's detections, too. */
  minShare: 0.25,
}

const CORNERS = ['tl', 'tr', 'br', 'bl'] as const

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

function medianPoint(pts: readonly Point[]): Point {
  return { x: median(pts.map((p) => p.x)), y: median(pts.map((p) => p.y)) }
}

/**
 * The shot's frame from the spell's detections (oldest first). Null for an
 * empty spell.
 */
export function shotFrameQuad(
  spell: readonly CornerDetection[],
  opts: Partial<typeof SHOT_FRAME_DEFAULTS> = {},
): Quad | null {
  if (spell.length === 0) return null
  const o = { ...SHOT_FRAME_DEFAULTS, ...opts }
  const mid = {} as Record<(typeof CORNERS)[number], Point>
  for (const c of CORNERS) mid[c] = medianPoint(spell.map((d) => d.quad[c]))
  const centre = {
    x: (mid.tl.x + mid.tr.x + mid.br.x + mid.bl.x) / 4,
    y: (mid.tl.y + mid.tr.y + mid.br.y + mid.bl.y) / 4,
  }
  const diag = Math.max(
    Math.hypot(mid.br.x - mid.tl.x, mid.br.y - mid.tl.y),
    Math.hypot(mid.bl.x - mid.tr.x, mid.bl.y - mid.tr.y),
  )
  const radius = o.cluster * diag
  const out = {} as Record<(typeof CORNERS)[number], Point>
  for (const c of CORNERS) {
    const pts = spell.map((d) => d.quad[c])
    // Places: each detection joins the first place whose seed is within
    // `radius`, else starts one.
    const places: { seed: Point; pts: Point[] }[] = []
    for (const p of pts) {
      const place = places.find(
        (q) => Math.hypot(p.x - q.seed.x, p.y - q.seed.y) <= radius,
      )
      if (place) place.pts.push(p)
      else places.push({ seed: p, pts: [p] })
    }
    const enough = places.filter(
      (q) =>
        q.pts.length >= o.minSure && q.pts.length >= o.minShare * pts.length,
    )
    let chosen: Point[]
    if (enough.length === 0) chosen = pts
    else {
      const outness = (q: { pts: Point[] }) => {
        const m = medianPoint(q.pts)
        return Math.hypot(m.x - centre.x, m.y - centre.y)
      }
      chosen = enough.reduce((a, b) => (outness(b) > outness(a) ? b : a)).pts
    }
    out[c] = medianPoint(chosen.slice(-o.recent))
  }
  return out
}
