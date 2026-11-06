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
 * unshown). The model is less sure of the wrong reading: its peak for that
 * corner was 0.42–0.69 against 0.77–0.85 for the right one.
 *
 * So each corner is taken from the detections the model was surest of for
 * THAT corner — those whose peak comes within `peakDrop` of the spell's
 * best peak for it — as the per-coordinate median of the last `recent` of
 * them (the recent ones follow the hand; the whole spell's median lagged
 * it). When fewer than `minSure` detections qualify (a short spell), every
 * detection counts. Pure logic; the caller keeps the spell.
 */
import type { Point, Quad } from '../types.js'

export interface CornerDetection {
  readonly quad: Quad
  /** How sure the model is of each corner, in `tl, tr, br, bl` order (0..1). */
  readonly peaks: readonly [number, number, number, number]
}

export const SHOT_FRAME_DEFAULTS = {
  /** A detection counts for a corner when its peak is within this of the spell's best. */
  peakDrop: 0.15,
  /** The last this many sure detections give the corner (median). */
  recent: 5,
  /** Below this many sure detections every detection counts. */
  minSure: 3,
}

const CORNERS = ['tl', 'tr', 'br', 'bl'] as const

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
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
  const out = {} as Record<(typeof CORNERS)[number], Point>
  CORNERS.forEach((c, k) => {
    const peak = (d: CornerDetection) => d.peaks[k] ?? 0
    const best = Math.max(...spell.map(peak))
    let sure = spell.filter((d) => peak(d) >= best - o.peakDrop)
    if (sure.length < o.minSure) sure = [...spell]
    const last = sure.slice(-o.recent)
    out[c] = {
      x: median(last.map((d) => d.quad[c].x)),
      y: median(last.map((d) => d.quad[c].y)),
    }
  })
  return out
}
