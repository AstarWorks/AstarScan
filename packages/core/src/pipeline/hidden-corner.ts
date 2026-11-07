/**
 * A paper corner the corner model cannot see while the other three are
 * plain to it.
 *
 * A heat-map corner model (DocAligner) gives each corner a peak that says
 * how sure it is; a corner under the detector's threshold is not taken and
 * the frame counts as "paper not found". A thumb on a corner hides it for
 * the whole hold: book 6's spread held with the left thumb on the left
 * page's bottom outer corner (cold light, a heavy shadow, a steel desk)
 * had that corner under 0.3 in 13 of the 20 frames of one hold and in 37
 * of 40 of another, while the other three corners stayed at 0.7–0.9 and
 * within 1 % of the diagonal of the true corners. Every such frame was
 * thrown away, the stillness never built up, and four spreads of seven
 * went unshown (both at 720×960 and at 2048×1536). Where the model put the
 * unseen corner was no use: 13–30 % of the diagonal off (median).
 *
 * A corner the model cannot see does not mean the paper moved: when exactly
 * one corner is under the threshold and the other three are sure, the
 * fourth is where those three put it — the fourth corner of their
 * parallelogram (within about 2 % of the diagonal of the true corner on
 * the frames above; a page seen from above is close to a parallelogram,
 * and the hidden corner is under a thumb anyway). Two unseen corners
 * cannot be completed, and three corners that are not plainly sure may be
 * a model that is lost (a turn, no paper), so those frames stay "not
 * found" as before. Pure logic; the detector calls it before ordering the
 * corners (the unseen corner's reading can land anywhere, which would
 * reorder the quad).
 */
import type { Point } from '../types.js'

export const HIDDEN_CORNER_DEFAULTS = {
  /** A corner the model is less sure of than this is not seen (the detector's MIN_PEAK). */
  minPeak: 0.3,
  /** The other three corners must each be at least this sure for the fourth to be completed. */
  surePeak: 0.6,
}

export type FourPoints = readonly [Point, Point, Point, Point]
export type FourPeaks = readonly [number, number, number, number]

export interface HiddenCornerResult {
  /** The corners, the hidden one completed (the model's order kept). */
  points: [Point, Point, Point, Point]
  /** Index of the completed corner, or null when every corner was seen. */
  hidden: number | null
}

/**
 * `points` and `peaks` in the model's channel order (tl, tr, br, bl — any
 * order whose neighbours are adjacent corners and whose index + 2 is the
 * opposite corner). Returns the points with one hidden corner completed
 * (`hidden` says which), the points unchanged when all are seen, or null
 * when the paper is not found (two or more corners unseen, or the three
 * seen ones not sure enough).
 */
export function completeHiddenCorner(
  points: FourPoints,
  peaks: FourPeaks,
  opts: Partial<typeof HIDDEN_CORNER_DEFAULTS> = {},
): HiddenCornerResult | null {
  const o = { ...HIDDEN_CORNER_DEFAULTS, ...opts }
  const unseen: number[] = []
  peaks.forEach((p, i) => {
    if (p < o.minPeak) unseen.push(i)
  })
  const out: [Point, Point, Point, Point] = [
    { ...points[0] },
    { ...points[1] },
    { ...points[2] },
    { ...points[3] },
  ]
  if (unseen.length === 0) return { points: out, hidden: null }
  if (unseen.length > 1) return null
  const i = unseen[0]!
  for (let k = 0; k < 4; k++) if (k !== i && peaks[k]! < o.surePeak) return null
  const prev = points[(i + 3) % 4]!
  const next = points[(i + 1) % 4]!
  const opposite = points[(i + 2) % 4]!
  out[i] = { x: prev.x + next.x - opposite.x, y: prev.y + next.y - opposite.y }
  return { points: out, hidden: i }
}
