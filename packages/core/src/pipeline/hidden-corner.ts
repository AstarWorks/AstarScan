/**
 * A corner hidden under a thumb: the corner model (DocAligner) then puts
 * that corner somewhere else — book 6's spread held with the left thumb
 * over the bottom-left corner read it at the foot of the gutter for the
 * whole hold, at a peak of 0.03–0.4 while the other three corners were
 * read at 0.85–0.93 — and the capture screen, which takes a frame whose
 * weakest corner is under `minPeak` as "paper not found", never settled:
 * 4 of 14 pages at 1440×1080, 8 at 720×960.
 *
 * A page is a rectangle; three sure corners fix the fourth well enough
 * (the parallelogram completion, exact without perspective; a hand-held
 * phone's 0–4° of tilt puts it within ~3 % of the frame's width, 40 px of
 * 1440 on that spread). So when exactly one corner is under `minPeak` and
 * the other three are at `surePeak` or more, the weak corner is replaced
 * by the one the other three imply, and reported as `hidden`. Any other
 * mix (two weak corners, or sure ones that are not very sure) is left to
 * the caller. Pure logic.
 */
import type { Point, Quad } from '../types.js'

export const HIDDEN_CORNER_DEFAULTS = {
  /** A corner the model is less sure of than this is not taken. */
  minPeak: 0.3,
  /** The other three corners must be at least this sure. */
  surePeak: 0.6,
}

const CORNERS = ['tl', 'tr', 'br', 'bl'] as const
type Corner = (typeof CORNERS)[number]
/** The two neighbours (sharing an edge) and the opposite corner of each. */
const AROUND: Record<Corner, [Corner, Corner, Corner]> = {
  tl: ['tr', 'bl', 'br'],
  tr: ['tl', 'br', 'bl'],
  br: ['tr', 'bl', 'tl'],
  bl: ['tl', 'br', 'tr'],
}

export interface HiddenCornerResult {
  readonly quad: Quad
  /** The peaks with the hidden corner's set to the lowest of the other three. */
  readonly peaks: [number, number, number, number]
  readonly hidden: Corner
}

/**
 * The quad with its one hidden corner completed from the other three, or
 * null when no corner is hidden that way.
 */
export function completeHiddenCorner(
  quad: Quad,
  peaks: readonly [number, number, number, number],
  opts: Partial<typeof HIDDEN_CORNER_DEFAULTS> = {},
): HiddenCornerResult | null {
  const o = { ...HIDDEN_CORNER_DEFAULTS, ...opts }
  const weak = CORNERS.filter((_, k) => peaks[k]! < o.minPeak)
  if (weak.length !== 1) return null
  const hidden = weak[0]!
  const others = CORNERS.filter((c) => c !== hidden)
  if (!others.every((c) => peaks[CORNERS.indexOf(c)]! >= o.surePeak))
    return null
  const [a, b, opp] = AROUND[hidden]
  const p = (c: Corner): Point => quad[c]
  const completed: Point = {
    x: p(a).x + p(b).x - p(opp).x,
    y: p(a).y + p(b).y - p(opp).y,
  }
  const low = Math.min(...others.map((c) => peaks[CORNERS.indexOf(c)]!))
  const out = [...peaks] as [number, number, number, number]
  out[CORNERS.indexOf(hidden)] = low
  return { quad: { ...quad, [hidden]: completed }, peaks: out, hidden }
}
