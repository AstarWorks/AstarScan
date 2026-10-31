/**
 * Live capture judge — decides, frame by frame while the user is still
 * filming, when a page has been captured (✓) and when a page was turned
 * away before it was captured (missed).
 *
 * Rules (every value lives in `LIVE_CAPTURE_DEFAULTS`; they were chosen by
 * replaying the GT frame logs with `bun scripts/eval/live-capture.mjs`):
 *
 *   - A frame shows a page when the detector is confident enough and the
 *     quad is large enough. There is NO blur / texture gate: Tenengrad
 *     measures text density, and rejected sharp, illustration-heavy pages
 *     as "blurry". Sharpness only ranks frames inside a hold (`score`).
 *   - A page is "held" while its quad stays still (corner motion below
 *     `maxMotion`). After `holdS` of stillness the best-scoring frame seen
 *     in the hold so far is emitted as `captured`.
 *   - A pHash jump beyond `changeDist` that persists for `changeS` ends the
 *     hold and starts a new one (page turned). A hold that ends without a
 *     capture after being visible for `missMinS` is reported as `missed`.
 *   - Detection dropping out for up to `gapS` does not end the hold. When a
 *     hold re-forms within `gapS` of a captured page and its picture is
 *     within `sameDist`, it continues that page (`resumed`, no second ✓).
 *     Later look-alikes are still captured but flagged with `duplicateOf`
 *     — the user decides, nothing is dropped automatically.
 *
 * Pure: no DOM, no OpenCV. Callers feed `LiveFrame`s and react to events.
 */

import type { Quad } from '../types.js'
import { hamming } from './hash.js'

export const LIVE_CAPTURE_DEFAULTS = {
  /** Detector confidence floor for "a page is in view". */
  minConfidence: 0.25,
  /** Quad area floor (fraction of the source frame). */
  minAreaFrac: 0.01,
  /** Mean corner displacement between consecutive samples, as a fraction
   *  of the frame diagonal, at or below which the page counts as still. */
  maxMotion: 0.06,
  /** Seconds of stillness before a page is captured. */
  holdS: 0.8,
  /** pHash (256-bit) distance to the hold's reference frame above which a
   *  frame shows a different picture. */
  changeDist: 100,
  /** Seconds a different picture must persist to count as a page turn. */
  changeS: 0.3,
  /** Seconds of dropped detection tolerated without ending the page. */
  gapS: 1.5,
  /** pHash distance at or below which a new hold looks like a captured
   *  page (resume within `gapS`, duplicate candidate beyond). */
  sameDist: 70,
  /** Seconds an uncaptured hold must have been visible to report a miss. */
  missMinS: 0.3,
} as const

export type LiveCaptureOptions = { -readonly [K in keyof typeof LIVE_CAPTURE_DEFAULTS]: number }

export interface LiveFrame<T = unknown> {
  /** Seconds since scan start. */
  t: number
  confidence: number
  /** Detected quad in source-frame pixels (null when nothing detected). */
  quad: Quad | null
  frameW: number
  frameH: number
  areaFrac: number
  /** Ranking score within a hold (higher = better). */
  score: number
  /** 256-bit pHash of the warped page; null when not computed. */
  hash: bigint | null
  /** Caller payload (warped blob etc.), handed back on events. */
  data: T
}

export type LiveCaptureEvent<T = unknown> =
  | { type: 'hold'; holdId: number; progress: number; t: number }
  | {
      type: 'captured'
      holdId: number
      pageNo: number
      best: LiveFrame<T>
      /** pageNo of an earlier captured page this one looks like, or null. */
      duplicateOf: number | null
      t: number
    }
  | { type: 'resumed'; holdId: number; pageNo: number; t: number }
  | {
      type: 'missed'
      holdId: number
      best: LiveFrame<T>
      startT: number
      endT: number
      t: number
    }

/** Mean corner displacement between two quads / frame diagonal. */
export function quadMotion(a: Quad, b: Quad, frameW: number, frameH: number): number {
  const diag = Math.hypot(frameW, frameH) || 1
  const d =
    Math.hypot(a.tl.x - b.tl.x, a.tl.y - b.tl.y) +
    Math.hypot(a.tr.x - b.tr.x, a.tr.y - b.tr.y) +
    Math.hypot(a.br.x - b.br.x, a.br.y - b.br.y) +
    Math.hypot(a.bl.x - b.bl.x, a.bl.y - b.bl.y)
  return d / 4 / diag
}

interface Hold<T> {
  id: number
  startT: number
  lastSeenT: number
  /** Start of the current still run; null while the page is moving. */
  stillSinceT: number | null
  ref: bigint
  best: LiveFrame<T>
  /** Set once captured (or resumed onto a captured page). */
  pageNo: number | null
  /** Consecutive page frames that differ from `ref`. */
  pending: LiveFrame<T>[]
}

interface CapturedRef {
  pageNo: number
  hash: bigint
  lastSeenT: number
}

const EPS = 1e-6

export class LiveCaptureJudge<T = unknown> {
  readonly opts: LiveCaptureOptions
  #hold: Hold<T> | null = null
  #captured: CapturedRef[] = []
  #nextHoldId = 1
  #prevQuad: Quad | null = null

  constructor(opts: Partial<LiveCaptureOptions> = {}) {
    this.opts = { ...LIVE_CAPTURE_DEFAULTS, ...opts }
  }

  isPage(f: Pick<LiveFrame, 'confidence' | 'areaFrac' | 'hash'>): boolean {
    return (
      f.hash !== null &&
      f.confidence >= this.opts.minConfidence &&
      f.areaFrac >= this.opts.minAreaFrac
    )
  }

  /** Feed one sampled frame; returns the events it caused (often none). */
  push(f: LiveFrame<T>): LiveCaptureEvent<T>[] {
    const out: LiveCaptureEvent<T>[] = []
    const o = this.opts
    const motion =
      f.quad && this.#prevQuad ? quadMotion(f.quad, this.#prevQuad, f.frameW, f.frameH) : Infinity
    this.#prevQuad = f.quad
    const still = motion <= o.maxMotion
    const h = this.#hold

    if (!this.isPage(f) || f.hash === null) {
      if (h && f.t - h.lastSeenT > o.gapS + EPS) this.#close(f.t, out)
      return out
    }

    if (!h || f.t - h.lastSeenT > o.gapS + EPS) {
      if (h) this.#close(f.t, out)
      this.#open([f], still, out)
      return out
    }

    if (hamming(f.hash, h.ref) <= o.changeDist) {
      h.pending = []
      h.lastSeenT = f.t
      if (f.score > h.best.score) {
        h.best = f
        h.ref = f.hash
      }
      if (!still) h.stillSinceT = null
      else if (h.stillSinceT === null) h.stillSinceT = f.t
      this.#progress(f.t, out)
      return out
    }

    // Different picture. Only a change that persists is a page turn.
    h.pending.push(f)
    const first = h.pending[0]!
    if (f.t - first.t >= o.changeS - EPS) {
      const seed = h.pending
      h.pending = []
      this.#close(f.t, out)
      this.#open(seed, still, out)
    }
    return out
  }

  /** End of scan: closes the open hold (may emit `missed`). */
  finish(t: number): LiveCaptureEvent<T>[] {
    const out: LiveCaptureEvent<T>[] = []
    this.#close(t, out)
    return out
  }

  #open(seed: LiveFrame<T>[], still: boolean, out: LiveCaptureEvent<T>[]): void {
    const first = seed[0]!
    const last = seed[seed.length - 1]!
    let best = first
    for (const s of seed) if (s.score > best.score) best = s
    const hold: Hold<T> = {
      id: this.#nextHoldId++,
      startT: first.t,
      lastSeenT: last.t,
      stillSinceT: still ? (seed.length > 1 ? first.t : last.t) : null,
      ref: best.hash ?? 0n,
      best,
      pageNo: null,
      pending: [],
    }
    this.#hold = hold
    // The page came back within the gap tolerance: keep counting it as the
    // page already captured instead of capturing it a second time.
    const prev = this.#captured[this.#captured.length - 1]
    if (
      prev &&
      first.t - prev.lastSeenT <= this.opts.gapS + EPS &&
      hamming(hold.ref, prev.hash) <= this.opts.sameDist
    ) {
      hold.pageNo = prev.pageNo
      prev.lastSeenT = last.t
      out.push({ type: 'resumed', holdId: hold.id, pageNo: prev.pageNo, t: last.t })
      return
    }
    this.#progress(last.t, out)
  }

  #progress(t: number, out: LiveCaptureEvent<T>[]): void {
    const h = this.#hold
    if (!h) return
    if (h.pageNo !== null) {
      const c = this.#captured.find((x) => x.pageNo === h.pageNo)
      if (c) c.lastSeenT = t
      return
    }
    const held = h.stillSinceT === null ? 0 : t - h.stillSinceT
    if (held + EPS >= this.opts.holdS) {
      let duplicateOf: number | null = null
      let bestD = Infinity
      for (const c of this.#captured) {
        const d = hamming(h.ref, c.hash)
        if (d <= this.opts.sameDist && d < bestD) {
          bestD = d
          duplicateOf = c.pageNo
        }
      }
      const pageNo = this.#captured.length + 1
      h.pageNo = pageNo
      this.#captured.push({ pageNo, hash: h.ref, lastSeenT: t })
      out.push({ type: 'captured', holdId: h.id, pageNo, best: h.best, duplicateOf, t })
      return
    }
    out.push({ type: 'hold', holdId: h.id, progress: Math.max(0, held / this.opts.holdS), t })
  }

  #close(t: number, out: LiveCaptureEvent<T>[]): void {
    const h = this.#hold
    this.#hold = null
    if (!h || h.pageNo !== null) return
    if (h.lastSeenT - h.startT + EPS >= this.opts.missMinS) {
      out.push({
        type: 'missed',
        holdId: h.id,
        best: h.best,
        startT: h.startT,
        endT: h.lastSeenT,
        t,
      })
    }
  }
}
