/**
 * Segment-first clustering: exploit the temporal structure of the video
 * instead of relying on perceptual-hash distances alone.
 *
 * Why: measured on the two eval videos, same-page consecutive-frame
 * distances (tile p90 32-33, pHash p90 67-105) fully overlap the
 * page-boundary distances (tile 29-42, pHash 60-159). No global hash
 * threshold can separate "same page, crop jitter" from "different page" —
 * the documented structural limit of single-threshold clustering. Two
 * signals DO separate them:
 *
 *   1. TIME — page turns leave acceptance gaps (motion blur / low conf),
 *      and frames 100 ms apart within a hold are almost surely one page.
 *   2. ORB+RANSAC geometry — same page at a different angle matches with
 *      whole-page inlier coverage; different pages sharing boilerplate
 *      match only in a small region (low grid coverage).
 *
 * Pipeline:
 *   L1a  group accepted frames into runs: consecutive idx gap ≤ maxGapFrames
 *   L1b  within-run cuts: at suspicious boundaries (pHash spike or sub-gap),
 *        verify with ORB — cut when geometry says "different page"
 *   L2   cross-segment merge (winner vs winner, union-find, transitive):
 *        tile ≤ tileLo  →  merge (near-identical crops)
 *        else ORB inliers ≥ orbAdjacent (time gap ≤ adjacentGapS)
 *             or ≥ orbDistant (otherwise), AND gridCoverage ≥ minGrid
 *
 * All thresholds are knobs; defaults reflect the measured distributions
 * (see constants.ts). The ORB implementation is injected via
 * `hooks.orb` — it is the only cv-dependent collaborator.
 */

import type { CanvasLike } from './deps.js'
import type { OrbOps, OrbResult } from './orb.js'
import { hamming, tileDistance } from './hash.js'
import { RESCUE_NMS_FRAMES, SEGMENT_DEFAULTS } from './constants.js'

export { SEGMENT_DEFAULTS }

/** Minimal record shape the segmenter needs; extra fields pass through. */
export interface SegmentFrameRecord {
  idx: number
  t_s: number
  hash: bigint
  tileHash: readonly bigint[]
  score: number
  ten?: number
  rescued?: boolean
}

export interface SegmentHooks {
  /** ORB ops (cv-dependent, injected — see createOrbOps). */
  orb: Pick<OrbOps, 'computeOrbDescriptors' | 'countOrbMatches'>
  /**
   * Content-level same-page verifier (e.g. OCR-text similarity, VLM pair
   * compare) consulted when the classical signals abstain: at suspicious
   * within-run boundaries where ORB found nothing, and for temporally
   * adjacent segment pairs that tile/ORB could not merge. Dense-text pages
   * defeat every classical signal (measured: pHash/tile/ORB/IoU/NCC all
   * overlap between same-page and different-page pairs), so this hook is
   * what decides them. Return null to abstain (treated as "different").
   */
  verifySame?: (
    aIdx: number,
    bIdx: number,
    gapS: number,
  ) => Promise<boolean | null>
}

export interface SegmentCut {
  a: number
  b: number
  phash: number
  gap: number
  orb: number
  via: 'orb' | 'verify'
}

export interface SegmentMerge {
  i: number
  j: number
  aIdx: number
  bIdx: number
  tile: number
  orb: number | null
  grid: number | null
  verdict: string | null
}

export interface SegmentCluster<T extends SegmentFrameRecord> {
  winner: T
  members: T[]
}

export interface SegmentDebug {
  segments: Array<{ range: [number, number]; n: number; rescued?: true }>
  cuts: SegmentCut[]
  merges: SegmentMerge[]
  rescues: Array<{
    idx: number
    t_s: number
    score: number
    ten: number | undefined
  }>
}

export interface SegmentResult<T extends SegmentFrameRecord> {
  clusters: Array<SegmentCluster<T>>
  debug: SegmentDebug
}

/**
 * @param records  accepted frame records, ascending idx
 * @param loadCanvas  warped-crop loader by frame idx
 * @param opts  see SEGMENT_DEFAULTS
 * @param hooks  ORB ops (required) + optional content verifier
 * @param candidates  superset of `records` at a LOWER quality floor (same
 *   record shape). Used by the rescue pass: the blur gate that defines
 *   acceptance is content-biased (Tenengrad ∝ texture, so sharp
 *   illustration-heavy pages never pass — measured recall loss of 4/11
 *   pages on mp4-1). Holds made entirely of such pages appear as LONG
 *   inter-segment gaps (>2.5 s; real page-turn gaps measured 1.3–2.1 s).
 *   For each long gap the best-scoring candidate becomes a rescue segment,
 *   recursively splitting the remaining gap. L2 merging and the verifier
 *   then dedupe rescues against their neighbors.
 */
export async function clusterBySegments<T extends SegmentFrameRecord>(
  records: readonly T[],
  loadCanvas: (idx: number) => Promise<CanvasLike>,
  opts: Partial<typeof SEGMENT_DEFAULTS> = {},
  hooks: SegmentHooks,
  candidates: readonly T[] = [],
): Promise<SegmentResult<T>> {
  const o = { ...SEGMENT_DEFAULTS, ...opts }
  if (records.length === 0 && candidates.length === 0) {
    return {
      clusters: [],
      debug: { segments: [], cuts: [], merges: [], rescues: [] },
    }
  }

  // ORB cache: descriptors per frame idx, computed lazily, freed at the end.
  const orbCache = new Map<number, OrbResult | null>()
  const getOrb = async (idx: number): Promise<OrbResult | null> => {
    if (!orbCache.has(idx)) {
      orbCache.set(idx, hooks.orb.computeOrbDescriptors(await loadCanvas(idx)))
    }
    return orbCache.get(idx) ?? null
  }

  try {
    // ----- L1: temporal runs with ORB-verified cuts --------------------
    const segments: T[][] = []
    const cuts: SegmentCut[] = []
    let cur: T[] | null = records.length ? [records[0]!] : null
    for (let i = 1; i < records.length; i += 1) {
      const prev = records[i - 1]!
      const r = records[i]!
      const gap = r.idx - prev.idx
      let split = false
      if (gap > o.maxGapFrames) {
        split = true
      } else {
        // Cut candidates are ONLY acceptance gaps ≥ cutGapFrames. Hash
        // spikes between directly consecutive frames are NEVER cuts: a
        // physical page swap in 100 ms with sharp, detected frames on
        // both sides is impossible — measured on mp4-2, every gap<5
        // pHash-spike "cut" (21 of them) was a false positive from crop
        // jitter, while every real page turn left an acceptance gap.
        const d = Number(hamming(prev.hash, r.hash))
        const suspicious = gap >= o.cutGapFrames
        if (suspicious) {
          const { inliers } = hooks.orb.countOrbMatches(
            await getOrb(prev.idx),
            await getOrb(r.idx),
          )
          let same = inliers >= o.cutOrbInliers
          let via: SegmentCut['via'] = 'orb'
          if (!same && hooks.verifySame) {
            same =
              (await hooks.verifySame(
                prev.idx,
                r.idx,
                (r.idx - prev.idx) * 0.1,
              )) === true
            via = 'verify'
          }
          if (!same) {
            split = true
            cuts.push({
              a: prev.idx,
              b: r.idx,
              phash: d,
              gap,
              orb: inliers,
              via,
            })
          }
        }
      }
      if (split) {
        if (cur) segments.push(cur)
        cur = [r]
      } else {
        cur?.push(r)
      }
    }
    if (cur) segments.push(cur)

    // ----- Rescue pass: long inter-segment gaps hide blur-gated holds ---
    // (see `candidates` docs above). Recursive: the best candidate splits
    // its gap; remaining sub-gaps above the threshold are scanned again.
    const rescues: T[] = []
    if (candidates.length) {
      const acceptedIdx = new Set(records.map((r) => r.idx))
      const lastCandIdx = candidates[candidates.length - 1]!.idx
      // Non-max suppression radius: a rescued frame claims its neighborhood
      // so recursion can't shave the same hold frame-by-frame (observed:
      // one 30-frame gap produced a 5-rescue chain at its edge because
      // each pick shrank the gap by 1). Kept small (0.8 s): a too-wide
      // radius starved the sub-gap recursion of a real hold (g05 sat in a
      // 24-frame leftover < threshold). Over-rescue of the same hold is
      // self-healing — adjacent rescues merge in L2 via ORB/verifier.
      const NMS = RESCUE_NMS_FRAMES
      const rescueInGap = (lo: number, hi: number): void => {
        if (hi - lo <= o.rescueMinGapFrames) return
        // Only consider the middle 60 % of the gap: missed HOLDS occupy
        // gap centers, while gap edges hold page-turn frames — sharp
        // arriving/leaving text that outscores a sparse-content hold and
        // would hijack the rescue (measured: g05's illustration page lost
        // to the flanking turn frames twice). Recursion re-opens edge
        // regions as new sub-gap centers, so real pages near edges are
        // still reachable.
        const margin = Math.floor((hi - lo) * 0.2)
        const inGap = candidates.filter(
          (c) =>
            c.idx > lo + margin &&
            c.idx < hi - margin &&
            !acceptedIdx.has(c.idx),
        )
        if (!inGap.length) return
        const best = inGap.reduce((b, c) => (c.score > b.score ? c : b))
        rescues.push(best)
        rescueInGap(lo, best.idx - NMS)
        rescueInGap(best.idx + NMS, hi)
      }
      let prevEnd = -1
      for (const seg of segments) {
        rescueInGap(prevEnd, seg[0]!.idx)
        prevEnd = seg[seg.length - 1]!.idx
      }
      rescueInGap(prevEnd, lastCandIdx + o.rescueMinGapFrames + 1)
      for (const r of rescues) segments.push([{ ...r, rescued: true }])
      segments.sort((a, b) => a[0]!.idx - b[0]!.idx)
    }

    // ----- L2: cross-segment merge (union-find on segment winners) -----
    const segs = segments.map((members) => {
      const winner = members.reduce((b, m) => (m.score > b.score ? m : b))
      return {
        members,
        winner,
        t0: members[0]!.t_s,
        t1: members[members.length - 1]!.t_s,
      }
    })
    const parent = segs.map((_, i) => i)
    const find = (i: number): number =>
      parent[i] === i ? i : (parent[i] = find(parent[i]!))
    const union = (i: number, j: number): void => {
      parent[find(j)] = find(i)
    }

    const merges: SegmentMerge[] = []
    for (let i = 0; i < segs.length; i += 1) {
      for (let j = i + 1; j < segs.length; j += 1) {
        const a = segs[i]!
        const b = segs[j]!
        const tile = Number(tileDistance(a.winner.tileHash, b.winner.tileHash))
        let verdict: string | null = null
        let orb: { inliers: number; gridCoverage: number } | null = null
        const gapS = Math.max(0, b.t0 - a.t1)
        if (tile <= o.tileLo) {
          verdict = 'tile'
        } else {
          orb = hooks.orb.countOrbMatches(
            await getOrb(a.winner.idx),
            await getOrb(b.winner.idx),
          )
          const floor = gapS <= o.adjacentGapS ? o.orbAdjacent : o.orbDistant
          if (orb.inliers >= floor && orb.gridCoverage >= o.minGrid) {
            verdict = gapS <= o.adjacentGapS ? 'orb-adjacent' : 'orb-distant'
          } else if (gapS <= o.adjacentGapS && hooks.verifySame) {
            // Classical signals abstained on a temporally adjacent pair —
            // exactly the dense-text blind spot. Ask the content verifier.
            if (
              (await hooks.verifySame(a.winner.idx, b.winner.idx, gapS)) ===
              true
            ) {
              verdict = 'verify-adjacent'
            }
          }
        }
        merges.push({
          i,
          j,
          aIdx: a.winner.idx,
          bIdx: b.winner.idx,
          tile,
          orb: orb?.inliers ?? null,
          grid: orb?.gridCoverage ?? null,
          verdict,
        })
        if (verdict) union(i, j)
      }
    }

    const groups = new Map<number, Array<(typeof segs)[number]>>()
    segs.forEach((s, i) => {
      const root = find(i)
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root)!.push(s)
    })
    const clusters = [...groups.values()].map((ss) => {
      const members = ss.flatMap((s) => s.members).sort((a, b) => a.idx - b.idx)
      const winner = members.reduce((b, m) => (m.score > b.score ? m : b))
      return { winner, members }
    })
    clusters.sort((a, b) => a.winner.idx - b.winner.idx)

    return {
      clusters,
      debug: {
        segments: segments.map((s) => ({
          range: [s[0]!.idx, s[s.length - 1]!.idx] as [number, number],
          n: s.length,
          ...(s[0]!.rescued === true ? { rescued: true as const } : {}),
        })),
        cuts,
        merges: merges.filter((m) => m.verdict || (m.orb ?? 0) >= 15),
        rescues: rescues.map((r) => ({
          idx: r.idx,
          t_s: r.t_s,
          score: r.score,
          ten: r.ten,
        })),
      },
    }
  } finally {
    for (const orb of orbCache.values()) orb?.descriptors.delete()
  }
}
