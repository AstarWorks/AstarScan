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
 *     measures text density and rejected sharp, illustration-heavy pages
 *     as "blurry". Sharpness only ranks frames inside a hold (`score`).
 *   - A page is "held" while its quad stays still (corner motion at or
 *     below `maxMotion`). After `holdS` of stillness the best-scoring frame
 *     seen in the hold so far is emitted as `captured`.
 *   - A pHash jump beyond `changeDist` that persists for `changeS` ends the
 *     hold and starts a new one (page turned). After a capture the
 *     reference picture is frozen, so a hold cannot drift onto the next
 *     page through a chain of similar-looking frames.
 *   - Misses are NOT decided per hold. pHash flickers by 50–110 bits
 *     between consecutive frames of the same hand-held page, so holds
 *     split while a page is being placed, settled or re-gripped; reporting
 *     every uncaptured hold flagged pages that were ✓'d a moment before or
 *     after (8 of 9 alerts in the GT replay). Instead the judge tracks the
 *     stretch during which a page stays in view. When no page has been
 *     seen for `leaveS` the page has left the view — "it went away without
 *     being captured" — and a stretch that showed a page for `missMinS`
 *     without any ✓ is reported as `missed`. A page swapped for the next
 *     one without ever leaving the view is therefore not flagged live; the
 *     end-of-scan report still lists it (`recovered` / `missed`).
 *   - Detection dropping out for up to `gapS` does not end the hold. A hold
 *     that re-forms within `gapS` of the last captured page with a picture
 *     within `sameDist` continues that page (`resumed`, no second ✓).
 *
 * Pure: no DOM, no OpenCV. Callers feed `LiveFrame`s and react to events.
 */

import type { Quad } from '../types.js'
import { hamming } from './hash.js'

export const LIVE_CAPTURE_DEFAULTS = {
  /** Detector confidence floor for "a page is in view". */
  minConfidence: 0.5,
  /** Quad area floor (fraction of the source frame). */
  minAreaFrac: 0.01,
  /** Mean corner displacement between consecutive samples, as a fraction
   *  of the frame diagonal, at or below which the page counts as still. */
  maxMotion: 0.07,
  /** Seconds of stillness before a page is captured. */
  holdS: 0.6,
  /** pHash (256-bit) distance to the hold's reference frame above which a
   *  frame shows a different picture. */
  changeDist: 90,
  /** Seconds a different picture must persist to count as a page turn. */
  changeS: 0.2,
  /** Seconds of dropped detection tolerated without ending the page. */
  gapS: 1.5,
  /** pHash distance at or below which a re-formed hold is the page that
   *  was just captured (within `gapS`). */
  sameDist: 50,
  /** Seconds without any page in view after which the page counts as
   *  having left the view: the stretch ends and, if it got no ✓, is
   *  reported as missed. Replay gives the same result for 0.5–1.5 s; the
   *  middle of that range is used. */
  leaveS: 1.0,
  /** Seconds an uncaptured stretch must have been visible to report a miss. */
  missMinS: 0.6,
} as const

export type LiveCaptureOptions = {
  -readonly [K in keyof typeof LIVE_CAPTURE_DEFAULTS]: number
}

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
  /** Caller payload, handed back on events. */
  data: T
}

export type LiveCaptureEvent<T = unknown> =
  | { type: 'hold'; holdId: number; progress: number; t: number }
  | {
      type: 'captured'
      holdId: number
      pageNo: number
      best: LiveFrame<T>
      startT: number
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

/** Time span during which a captured page was on screen. */
export interface LivePageSpan {
  pageNo: number
  startT: number
  endT: number
}

/** Mean corner displacement between two quads / frame diagonal. */
export function quadMotion(
  a: Quad,
  b: Quad,
  frameW: number,
  frameH: number,
): number {
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

interface CapturedRef extends LivePageSpan {
  hash: bigint
}

/** A stretch during which some page stayed in view (see `leaveS`). */
interface Visit<T> {
  startT: number
  lastSeenT: number
  best: LiveFrame<T>
  /** Latest hold seen in the stretch (reported on the miss). */
  holdId: number
  /** A ✓ (or a resumed ✓ page) happened during the stretch. */
  captured: boolean
}

const EPS = 1e-6

export class LiveCaptureJudge<T = unknown> {
  readonly opts: LiveCaptureOptions
  #hold: Hold<T> | null = null
  #captured: CapturedRef[] = []
  #nextHoldId = 1
  #prevQuad: Quad | null = null
  #visit: Visit<T> | null = null

  constructor(opts: Partial<LiveCaptureOptions> = {}) {
    this.opts = { ...LIVE_CAPTURE_DEFAULTS, ...opts }
  }

  /** Spans of every captured page so far, in capture order. */
  get pages(): LivePageSpan[] {
    return this.#captured.map(({ pageNo, startT, endT }) => ({
      pageNo,
      startT,
      endT,
    }))
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
      f.quad && this.#prevQuad
        ? quadMotion(f.quad, this.#prevQuad, f.frameW, f.frameH)
        : Infinity
    this.#prevQuad = f.quad
    const still = motion <= o.maxMotion
    const h = this.#hold

    if (!this.isPage(f) || f.hash === null) {
      if (h && f.t - h.lastSeenT > o.gapS + EPS) this.#close()
      if (this.#visit && f.t - this.#visit.lastSeenT > o.leaveS + EPS)
        this.#closeVisit(f.t, out)
      return out
    }

    const v = this.#visit
    if (v && f.t - v.lastSeenT > o.leaveS + EPS) this.#closeVisit(f.t, out)
    const visit = (this.#visit ??= {
      startT: f.t,
      lastSeenT: f.t,
      best: f,
      holdId: 0,
      captured: false,
    })
    visit.lastSeenT = f.t
    if (f.score > visit.best.score) visit.best = f
    this.#pushPage(f, still, out)
    const hold = this.#hold
    if (hold) {
      visit.holdId = hold.id
      if (hold.pageNo !== null) visit.captured = true
    }
    return out
  }

  #pushPage(f: LiveFrame<T>, still: boolean, out: LiveCaptureEvent<T>[]): void {
    const o = this.opts
    const h = this.#hold
    if (f.hash === null) return

    if (!h || f.t - h.lastSeenT > o.gapS + EPS) {
      if (h) this.#close()
      this.#open([f], still, out)
      return
    }

    if (hamming(f.hash, h.ref) <= o.changeDist) {
      h.pending = []
      h.lastSeenT = f.t
      if (f.score > h.best.score) {
        h.best = f
        // Once captured, the reference stays on the captured picture so
        // the hold cannot drift onto the next page.
        if (h.pageNo === null) h.ref = f.hash
      }
      if (!still) h.stillSinceT = null
      else if (h.stillSinceT === null) h.stillSinceT = f.t
      this.#progress(f.t, out)
      return
    }

    // Different picture. Only a change that persists is a page turn.
    h.pending.push(f)
    const first = h.pending[0]!
    if (f.t - first.t >= o.changeS - EPS) {
      const seed = h.pending
      h.pending = []
      this.#close()
      this.#open(seed, still, out)
    }
  }

  /** End of scan: closes the open hold and stretch (may emit `missed`). */
  finish(t: number): LiveCaptureEvent<T>[] {
    const out: LiveCaptureEvent<T>[] = []
    this.#close()
    this.#closeVisit(t, out)
    return out
  }

  #open(
    seed: LiveFrame<T>[],
    still: boolean,
    out: LiveCaptureEvent<T>[],
  ): void {
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
      first.t - prev.endT <= this.opts.gapS + EPS &&
      hamming(hold.ref, prev.hash) <= this.opts.sameDist
    ) {
      hold.pageNo = prev.pageNo
      prev.endT = last.t
      out.push({
        type: 'resumed',
        holdId: hold.id,
        pageNo: prev.pageNo,
        t: last.t,
      })
      return
    }
    this.#progress(last.t, out)
  }

  #progress(t: number, out: LiveCaptureEvent<T>[]): void {
    const h = this.#hold
    if (!h) return
    if (h.pageNo !== null) {
      const c = this.#captured.find((x) => x.pageNo === h.pageNo)
      if (c) c.endT = t
      return
    }
    const held = h.stillSinceT === null ? 0 : t - h.stillSinceT
    if (held + EPS >= this.opts.holdS) {
      const pageNo = this.#captured.length + 1
      h.pageNo = pageNo
      this.#captured.push({ pageNo, hash: h.ref, startT: h.startT, endT: t })
      out.push({
        type: 'captured',
        holdId: h.id,
        pageNo,
        best: h.best,
        startT: h.startT,
        t,
      })
      return
    }
    out.push({
      type: 'hold',
      holdId: h.id,
      progress: Math.max(0, held / this.opts.holdS),
      t,
    })
  }

  /** Ends the current hold. An uncaptured hold is not a miss by itself:
   *  holds split on pHash noise while the same page settles or is
   *  re-gripped, so misses are decided per stretch (`#closeVisit`). */
  #close(): void {
    this.#hold = null
  }

  /** The page left the view (or the scan ended). A stretch that showed a
   *  page for `missMinS` without any ✓ is reported as missed. */
  #closeVisit(t: number, out: LiveCaptureEvent<T>[]): void {
    const v = this.#visit
    this.#visit = null
    if (!v || v.captured) return
    if (v.lastSeenT - v.startT + EPS >= this.opts.missMinS) {
      out.push({
        type: 'missed',
        holdId: v.holdId,
        best: v.best,
        startT: v.startT,
        endT: v.lastSeenT,
        t,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// End-of-scan report
// ---------------------------------------------------------------------------

export type CaptureRowKind = 'captured' | 'duplicate' | 'recovered' | 'missed'

export interface CaptureRow {
  kind: CaptureRowKind
  /** Start of the row's time span (for ordering). */
  t: number
  /** Live page behind a captured / duplicate row. */
  livePageNo?: number
  /** Post-scan cluster behind the row, when one matched. */
  clusterKey?: number
  /** Live page this duplicate row repeats. */
  duplicateOf?: number
  /** Span of the miss behind a missed row, or behind a recovered row
   *  whose page was reported missed during the scan. */
  missSpan?: { startT: number; endT: number }
}

export interface ReportCluster {
  key: number
  /** Scan-time seconds of every member frame. */
  memberT: readonly number[]
}

const overlapCount = (ts: readonly number[], a: number, b: number): number =>
  ts.reduce((n, t) => (t >= a - EPS && t <= b + EPS ? n + 1 : n), 0)

/**
 * Reconcile what the user saw during the scan (live ✓ and misses) with the
 * post-scan pass (clusters from `clusterBySegments`), so the report keeps
 * the two apart:
 *
 *   - captured   live ✓ (first live page of its cluster, or unclustered)
 *   - duplicate  a further live ✓ that landed in the same cluster
 *   - recovered  a cluster nobody saw ✓ for — "後から拾った"
 *   - missed     a miss that no cluster recovered and no ✓ covered
 *
 * Each live page joins the cluster with the most member frames inside its
 * span. A miss whose span overlaps a captured cluster is dropped (the page
 * was captured after all); one overlapping a recovered cluster marks it.
 */
export function buildCaptureReport(
  live: readonly LivePageSpan[],
  misses: readonly { startT: number; endT: number }[],
  clusters: readonly ReportCluster[],
): CaptureRow[] {
  const liveByCluster = new Map<number, LivePageSpan[]>()
  const unclustered: LivePageSpan[] = []
  for (const p of live) {
    let bestKey: number | null = null
    let bestN = 0
    for (const c of clusters) {
      const n = overlapCount(c.memberT, p.startT, p.endT)
      if (n > bestN) {
        bestN = n
        bestKey = c.key
      }
    }
    if (bestKey === null) unclustered.push(p)
    else liveByCluster.set(bestKey, [...(liveByCluster.get(bestKey) ?? []), p])
  }

  const rows: CaptureRow[] = []
  const recoveredRows = new Map<number, CaptureRow>()
  for (const c of clusters) {
    const lives = liveByCluster.get(c.key)
    if (lives?.length) {
      const [first, ...rest] = [...lives].sort((a, b) => a.startT - b.startT)
      rows.push({
        kind: 'captured',
        t: first!.startT,
        livePageNo: first!.pageNo,
        clusterKey: c.key,
      })
      for (const d of rest) {
        rows.push({
          kind: 'duplicate',
          t: d.startT,
          livePageNo: d.pageNo,
          clusterKey: c.key,
          duplicateOf: first!.pageNo,
        })
      }
    } else {
      const row: CaptureRow = {
        kind: 'recovered',
        t: Math.min(...c.memberT),
        clusterKey: c.key,
      }
      recoveredRows.set(c.key, row)
      rows.push(row)
    }
  }
  for (const p of unclustered)
    rows.push({ kind: 'captured', t: p.startT, livePageNo: p.pageNo })

  for (const m of misses) {
    let hit: ReportCluster | null = null
    let hitN = 0
    for (const c of clusters) {
      const n = overlapCount(c.memberT, m.startT, m.endT)
      if (n > hitN) {
        hitN = n
        hit = c
      }
    }
    const coveredByLive = live.some(
      (p) => p.startT <= m.endT + EPS && p.endT >= m.startT - EPS,
    )
    if (hit) {
      const rec = recoveredRows.get(hit.key)
      if (rec) rec.missSpan ??= { startT: m.startT, endT: m.endT }
      continue
    }
    if (coveredByLive) continue
    rows.push({
      kind: 'missed',
      t: m.startT,
      missSpan: { startT: m.startT, endT: m.endT },
    })
  }

  return rows.sort((a, b) => a.t - b.t)
}
