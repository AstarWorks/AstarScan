// Logic tests for segment-first clustering. ORB is stubbed to abstain
// (null descriptors → 0 inliers), so cuts and merges are driven entirely
// by the scripted verifySame hook — this pins the temporal/cascade
// behavior without depending on real image content.
import { describe, expect, it } from 'vitest'
import {
  SEGMENT_DEFAULTS,
  clusterBySegments,
} from '../src/pipeline/segment-cluster.js'
import type { SegmentFrameRecord, SegmentHooks } from '../src/pipeline/segment-cluster.js'
import type { CanvasLike } from '../src/pipeline/deps.js'

const blank = { width: 64, height: 64, getContext: () => null } as unknown as CanvasLike
const loadCanvas = async (): Promise<CanvasLike> => blank

/** ORB that never matches anything — the featureless-canvas equivalent. */
const starvedOrb: SegmentHooks['orb'] = {
  computeOrbDescriptors: () => null,
  countOrbMatches: () => ({ inliers: 0, gridCoverage: 0 }),
}
const hooks = (verifySame?: SegmentHooks['verifySame']): SegmentHooks =>
  verifySame ? { orb: starvedOrb, verifySame } : { orb: starvedOrb }

/** Frame record factory. Distinct hashes far apart so tileLo never fires. */
const MASK64 = 0xffffffffffffffffn
function mix64(x: number | bigint): bigint {
  // splitmix64 finalizer — full avalanche so any two seeds XOR to ~32 set
  // bits and tileDistance lands far above tileLo, never short-circuiting
  // a merge (a weaker xorshift left correlated outputs and a flaky 18).
  let v = (BigInt(x) + 0x9e3779b97f4a7c15n) & MASK64
  v = ((v ^ (v >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64
  v = ((v ^ (v >> 27n)) * 0x94d049bb133111ebn) & MASK64
  return (v ^ (v >> 31n)) & MASK64
}
function rec(idx: number, score = 0.5, bits = idx): SegmentFrameRecord {
  const tile = Array.from({ length: 16 }, (_, t) => mix64(bits * 131 + t))
  return { idx, t_s: idx * 0.1, hash: mix64(bits) << 192n, tileHash: tile, score, ten: 40 }
}

describe('clusterBySegments', () => {
  it('splits on gaps > maxGapFrames and keeps continuous runs together', async () => {
    const records = [rec(0), rec(1), rec(2), rec(50), rec(51)]
    const { clusters, debug } = await clusterBySegments(records, loadCanvas, {}, hooks())
    expect(debug.segments.map((s) => s.range)).toEqual([
      [0, 2],
      [50, 51],
    ])
    expect(clusters).toHaveLength(2)
  })

  it('never cuts at gaps below cutGapFrames even with wild hash jumps', async () => {
    // 100 ms page swaps are physically impossible — hash spikes alone
    // must not cut (mp4-2 regression: 21 false cuts from crop jitter).
    const records = [rec(0, 0.5, 1), rec(1, 0.5, 9999), rec(2, 0.5, 12345)]
    const { debug } = await clusterBySegments(records, loadCanvas, {}, hooks())
    expect(debug.cuts).toHaveLength(0)
    expect(debug.segments).toHaveLength(1)
  })

  it('cuts a suspicious in-run gap when ORB and verifier both say different', async () => {
    const records = [rec(0), rec(1), rec(8), rec(9)] // gap 7 ∈ [5, 10]
    const { debug } = await clusterBySegments(records, loadCanvas, {}, hooks(async () => false))
    expect(debug.cuts).toHaveLength(1)
    expect(debug.cuts[0]).toMatchObject({ a: 1, b: 8 })
    expect(debug.segments.map((s) => s.range)).toEqual([
      [0, 1],
      [8, 9],
    ])
  })

  it('bridges a suspicious gap when the verifier says same', async () => {
    const records = [rec(0), rec(1), rec(8), rec(9)]
    const { debug } = await clusterBySegments(records, loadCanvas, {}, hooks(async () => true))
    expect(debug.cuts).toHaveLength(0)
    expect(debug.segments).toHaveLength(1)
  })

  it('merges adjacent segments via the verifier and picks the global best winner', async () => {
    const records = [rec(0, 0.9), rec(1, 0.3), rec(20, 0.5), rec(21, 0.4)]
    const pairs: Array<[number, number]> = []
    const { clusters } = await clusterBySegments(
      records,
      loadCanvas,
      {},
      hooks(async (a, b) => {
        pairs.push([a, b])
        return true
      }),
    )
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.winner.idx).toBe(0) // score 0.9 wins across the merge
    expect(clusters[0]?.members.map((m) => m.idx)).toEqual([0, 1, 20, 21])
    expect(pairs.length).toBeGreaterThan(0)
  })

  it('does not consult the verifier for temporally distant pairs', async () => {
    // adjacentGapS=3 → 0-1 vs 200-201 (gap ~20 s) must stay separate
    // even with an always-true verifier (no page-revisit support yet).
    const records = [rec(0), rec(1), rec(200), rec(201)]
    const { clusters } = await clusterBySegments(records, loadCanvas, {}, hooks(async () => true))
    expect(clusters).toHaveLength(2)
  })

  it('rescues the best candidate from a long gap, recursively', async () => {
    const records = [rec(0), rec(1), rec(100), rec(101)]
    // Two distinct sub-holds hidden in the 1→100 gap; rescue should find
    // the best of each side after the recursive split.
    const candidates = [
      rec(30, 0.4),
      rec(31, 0.6), // best of the whole gap → first rescue
      rec(70, 0.5), // best of the remaining (31, 100) sub-gap → second rescue
    ]
    const { debug } = await clusterBySegments(
      records,
      loadCanvas,
      {},
      hooks(async () => false),
      candidates,
    )
    expect(debug.rescues.map((r) => r.idx).sort((a, b) => a - b)).toEqual([31, 70])
  })

  it('does not rescue from short (page-turn) gaps', async () => {
    const records = [rec(0), rec(1), rec(20), rec(21)] // gap 19 < 25
    const candidates = [rec(10, 0.9)]
    const { debug } = await clusterBySegments(records, loadCanvas, {}, hooks(), candidates)
    expect(debug.rescues).toHaveLength(0)
  })

  it('rescues from the tail gap after the last segment', async () => {
    const records = [rec(0), rec(1)]
    const candidates = [rec(40, 0.7), rec(41, 0.5)]
    const { debug } = await clusterBySegments(records, loadCanvas, {}, hooks(), candidates)
    expect(debug.rescues.map((r) => r.idx)).toEqual([40])
  })

  it('handles an all-candidates video (every frame below the gate)', async () => {
    const candidates = [rec(0, 0.4), rec(1, 0.6), rec(60, 0.5)]
    const { clusters } = await clusterBySegments([], loadCanvas, {}, hooks(), candidates)
    expect(clusters.length).toBeGreaterThan(0)
  })

  it('exports stable defaults the CLI flags map onto', () => {
    expect(SEGMENT_DEFAULTS.maxGapFrames).toBe(10)
    expect(SEGMENT_DEFAULTS.cutGapFrames).toBe(5)
    expect(SEGMENT_DEFAULTS.rescueMinGapFrames).toBe(25)
  })
})
