/**
 * Which way to turn a LANDSCAPE frame before the corner model sees it.
 *
 * `doc-corners.onnx` was trained on portrait 720×1280 frames only. A page
 * lying sideways in a landscape frame (phone turned) needs the frame
 * turned 90° — but which way is unknown, and an upright page in a
 * landscape frame (webcam, tablet stand) must NOT be turned (its corner
 * error goes 33 px → 403 px when turned). The model's confidence does not
 * tell them apart (it is often higher upside-down).
 *
 * What does: after the corners are snapped onto the paper edge
 * (`corner-refine.ts`), the share of the snapped page covered by the
 * model's own keypoint quad (`orientationScore`). The right turn gives the
 * least-shrunk keypoints. Per frame that is noisy (upside-down is
 * sometimes a tie), so `OrientationPicker` probes all three turns on the
 * first landscape frame and then every `probeEvery` frames, keeps an EMA
 * per turn, and runs only the leading turn in between — one inference on
 * most frames.
 *
 * Pure: no DOM, no OpenCV, no model.
 */

import type { Point, Quad } from '../types.js'
import { boxAgreement, type CornerRefineResult } from './corner-refine.js'
import { quadArea } from './quad-smoother.js'
import type { PixelBox } from './yolo-decode.js'

export type FrameTurn = 'none' | 'cw' | 'ccw'
export const FRAME_TURNS: readonly FrameTurn[] = ['none', 'cw', 'ccw']

export const ORIENTATION_DEFAULTS = {
  /** Probe every turn on every this-many-th landscape frame. A probe
   *  costs three inferences; the turn rarely changes within a scan, and
   *  on slow devices frequent probes stall holds (fake-camera check,
   *  ✓ pages of 12: every 10th frame 8 upright / 10 sideways, every
   *  30th 10 / 11). */
  probeEvery: 30,
  /** EMA weight of the newest probe. */
  alpha: 0.5,
  /** The leading turn changes only when beaten by this much. */
  switchMargin: 0.05,
} as const

export type OrientationOptions = {
  -readonly [K in keyof typeof ORIENTATION_DEFAULTS]: number
}

function polyArea(p: readonly Point[]): number {
  let a = 0
  for (let i = 0; i < p.length; i += 1) {
    const u = p[i]!
    const v = p[(i + 1) % p.length]!
    a += u.x * v.y - v.x * u.y
  }
  return Math.abs(a) / 2
}

/** Sutherland–Hodgman: `subject` clipped by convex `clip`. */
function clipPolygon(subject: Point[], clip: readonly Point[]): Point[] {
  // Orient the clip polygon counter-clockwise (in y-down pixels: positive
  // signed area) so "inside" is a fixed side of every edge.
  let signed = 0
  for (let i = 0; i < clip.length; i += 1) {
    const u = clip[i]!
    const v = clip[(i + 1) % clip.length]!
    signed += u.x * v.y - v.x * u.y
  }
  const c = signed < 0 ? [...clip].reverse() : [...clip]
  let out = subject
  for (let i = 0; i < c.length && out.length; i += 1) {
    const a = c[i]!
    const b = c[(i + 1) % c.length]!
    const side = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    const input = out
    out = []
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j]!
      const q = input[(j + 1) % input.length]!
      const sp = side(p)
      const sq = side(q)
      if (sp >= 0) out.push(p)
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq)
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      }
    }
  }
  return out
}

/** Share of convex quad `b` covered by convex quad `a` (0..1). */
export function quadCoverage(a: Quad, b: Quad): number {
  const pb = [b.tl, b.tr, b.br, b.bl]
  const area = quadArea(b)
  if (!(area > 0)) return 0
  return polyArea(clipPolygon(pb, [a.tl, a.tr, a.br, a.bl])) / area
}

/**
 * How well a turn worked: share of the snapped page covered by the
 * model's keypoint quad. 0 when the snap failed (nothing to compare to).
 */
export function orientationScore(
  modelQuad: Quad,
  refine: Pick<CornerRefineResult, 'quad' | 'refined'>,
): number {
  return refine.refined ? quadCoverage(modelQuad, refine.quad) : 0
}

export class OrientationPicker {
  readonly opts: OrientationOptions
  #ema: Record<FrameTurn, number> = { none: 0, cw: 0, ccw: 0 }
  #probed = false
  #frame = 0
  #current: FrameTurn = 'none'

  constructor(opts: Partial<OrientationOptions> = {}) {
    this.opts = { ...ORIENTATION_DEFAULTS, ...opts }
  }

  get current(): FrameTurn {
    return this.#current
  }

  /** Turns to run on the next landscape frame. */
  plan(): FrameTurn[] {
    const probe =
      !this.#probed || this.#frame % Math.max(1, this.opts.probeEvery) === 0
    this.#frame += 1
    return probe ? [...FRAME_TURNS] : [this.#current]
  }

  /**
   * Report the scores of the turns run on this frame (`orientationScore`)
   * and get the turn whose result to use. A single-turn frame does not
   * move the estimate.
   */
  report(scores: Partial<Record<FrameTurn, number>>): FrameTurn {
    const turns = FRAME_TURNS.filter((t) => scores[t] !== undefined)
    if (turns.length < 2) return this.#current
    const a = this.opts.alpha
    for (const t of turns) {
      const s = scores[t]!
      this.#ema[t] = this.#probed ? a * s + (1 - a) * this.#ema[t] : s
    }
    this.#probed = true
    // Switch only to a turn that beats the current one by the margin; of
    // several such turns, the top one.
    const cur = this.#current
    let best = cur
    for (const t of FRAME_TURNS) {
      if (t === cur) continue
      const beats = this.#ema[t] > this.#ema[cur] + this.opts.switchMargin
      if (beats && (best === cur || this.#ema[t] > this.#ema[best])) best = t
    }
    this.#current = best
    return best
  }

  reset(): void {
    this.#ema = { none: 0, cw: 0, ccw: 0 }
    this.#probed = false
    this.#frame = 0
    this.#current = 'none'
  }
}

export interface PageCornersResult<D extends { quad: Quad; box: PixelBox }> {
  /** Model detection of the turn that was used (points in frame pixels). */
  detection: D
  /** Corners after the paper-edge snap (or the model's, if it failed). */
  refine: CornerRefineResult
  turn: FrameTurn
}

/**
 * One frame through the corner path: model (turned per `picker` when the
 * frame is landscape) → paper-edge snap → pick. `run` runs the model on
 * the frame turned by `turn` and returns points in FRAME pixels; `refine`
 * snaps them (null when OpenCV is unavailable — the model's corners are
 * then used). Portrait frames run once, unturned.
 */
export async function detectPageCorners<
  D extends { quad: Quad; box: PixelBox },
>(
  frame: { width: number; height: number },
  run: (turn: FrameTurn) => Promise<D | null>,
  refine: (quad: Quad, box: PixelBox) => CornerRefineResult | null,
  picker: OrientationPicker,
): Promise<PageCornersResult<D> | null> {
  const snap = (d: D): CornerRefineResult =>
    refine(d.quad, d.box) ?? {
      quad: d.quad,
      refined: false,
      boxAgreement: boxAgreement(d.quad, d.box),
    }
  if (frame.width <= frame.height) {
    const d = await run('none')
    return d ? { detection: d, refine: snap(d), turn: 'none' } : null
  }
  const results = new Map<FrameTurn, PageCornersResult<D>>()
  const scores: Partial<Record<FrameTurn, number>> = {}
  for (const turn of picker.plan()) {
    const d = await run(turn)
    if (!d) continue
    const r = snap(d)
    results.set(turn, { detection: d, refine: r, turn })
    scores[turn] = orientationScore(d.quad, r)
  }
  // A probe frame where some turn found nothing still updates the others.
  const chosen = picker.report(scores)
  return results.get(chosen) ?? results.values().next().value ?? null
}
