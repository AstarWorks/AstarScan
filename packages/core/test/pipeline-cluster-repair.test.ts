// Logic tests for user-driven cluster repair. These are pure array
// transforms — no canvas, no cv, no hashing — so the frame records here
// carry only the fields the repair functions actually read (idx, score).
//
// The invariants under test are the ones a repair UI silently depends on:
// members are never lost or duplicated, ordering matches what
// clusterBySegments emits, and an unaddressable target is a no-op rather
// than a throw (the UI calls these straight from a click handler).
import { describe, expect, it } from 'vitest'
import {
  mergeClusters,
  pickWinner,
  removeCluster,
  setClusterWinner,
  splitCluster,
  updateClusterCrop,
} from '../src/pipeline/cluster-repair.js'
import type { SegmentCluster, SegmentFrameRecord } from '../src/pipeline/segment-cluster.js'

function rec(idx: number, score = 0.5): SegmentFrameRecord {
  return { idx, t_s: idx * 0.1, hash: 0n, tileHash: [], score }
}

/** Build a cluster the way clusterBySegments would: members by idx, winner by score. */
function cluster(members: SegmentFrameRecord[]): SegmentCluster<SegmentFrameRecord> {
  const ordered = [...members].sort((a, b) => a.idx - b.idx)
  return { winner: pickWinner(ordered), members: ordered }
}

const memberIdxs = (cs: readonly SegmentCluster<SegmentFrameRecord>[]): number[] =>
  cs.flatMap((c) => c.members.map((m) => m.idx)).sort((a, b) => a - b)

describe('pickWinner', () => {
  it('picks the highest score', () => {
    expect(pickWinner([rec(0, 0.2), rec(1, 0.9), rec(2, 0.5)]).idx).toBe(1)
  })

  it('keeps the earliest frame on a score tie', () => {
    // Matches the `>` reduce in clusterBySegments — a repair must not
    // re-elect a different frame than the pipeline would have.
    expect(pickWinner([rec(3, 0.7), rec(4, 0.7), rec(5, 0.7)]).idx).toBe(3)
  })
})

describe('mergeClusters', () => {
  const base = [
    cluster([rec(0, 0.3), rec(1, 0.8)]), // winner idx 1
    cluster([rec(10, 0.6), rec(11, 0.4)]), // winner idx 10
    cluster([rec(20, 0.9)]), // winner idx 20
  ]

  it('folds two clusters into one and re-elects across the union', () => {
    const out = mergeClusters(base, [1, 10])
    expect(out).toHaveLength(2)
    const merged = out.find((c) => c.members.length === 4)!
    expect(merged.members.map((m) => m.idx)).toEqual([0, 1, 10, 11])
    expect(merged.winner.idx).toBe(1) // 0.8 beats 0.6
  })

  it('merges three at once', () => {
    const out = mergeClusters(base, [1, 10, 20])
    expect(out).toHaveLength(1)
    expect(out[0]!.members).toHaveLength(5)
    expect(out[0]!.winner.idx).toBe(20) // 0.9 is the global max
  })

  it('preserves every member exactly once', () => {
    expect(memberIdxs(mergeClusters(base, [1, 10]))).toEqual(memberIdxs(base))
  })

  it('returns clusters ordered by winner idx', () => {
    const out = mergeClusters(base, [10, 20])
    expect(out.map((c) => c.winner.idx)).toEqual([1, 20])
  })

  it('is a no-op when fewer than two keys resolve', () => {
    expect(mergeClusters(base, [1])).toHaveLength(3)
    expect(mergeClusters(base, [1, 999])).toHaveLength(3)
    expect(mergeClusters(base, [])).toHaveLength(3)
  })

  it('ignores a repeated key rather than merging a cluster with itself', () => {
    expect(mergeClusters(base, [1, 1])).toHaveLength(3)
  })

  it('does not mutate the input', () => {
    const before = base.map((c) => c.members.length)
    mergeClusters(base, [1, 10, 20])
    expect(base.map((c) => c.members.length)).toEqual(before)
  })
})

describe('splitCluster', () => {
  // One cluster holding what are really two pages: 0-2 and 10-12.
  const base = [cluster([rec(0, 0.4), rec(1, 0.7), rec(2, 0.3), rec(10, 0.9), rec(11, 0.5), rec(12, 0.6)])]

  it('cuts at the given frame index, re-electing both sides', () => {
    const out = splitCluster(base, base[0]!.winner.idx, 10)
    expect(out).toHaveLength(2)
    expect(out[0]!.members.map((m) => m.idx)).toEqual([0, 1, 2])
    expect(out[0]!.winner.idx).toBe(1)
    expect(out[1]!.members.map((m) => m.idx)).toEqual([10, 11, 12])
    expect(out[1]!.winner.idx).toBe(10)
  })

  it('puts the frame at atIdx on the second side', () => {
    const out = splitCluster(base, base[0]!.winner.idx, 11)
    expect(out[0]!.members.map((m) => m.idx)).toEqual([0, 1, 2, 10])
    expect(out[1]!.members.map((m) => m.idx)).toEqual([11, 12])
  })

  it('preserves every member exactly once', () => {
    expect(memberIdxs(splitCluster(base, base[0]!.winner.idx, 10))).toEqual(memberIdxs(base))
  })

  it('is a no-op when the split point leaves a side empty', () => {
    const key = base[0]!.winner.idx
    expect(splitCluster(base, key, 0)).toHaveLength(1) // head empty
    expect(splitCluster(base, key, 13)).toHaveLength(1) // tail empty
  })

  it('is a no-op on an unknown key', () => {
    expect(splitCluster(base, 999, 10)).toHaveLength(1)
  })

  it('splits a two-member cluster into two singletons', () => {
    const tiny = [cluster([rec(4, 0.5), rec(5, 0.6)])]
    const out = splitCluster(tiny, 5, 5)
    expect(out.map((c) => c.members.map((m) => m.idx))).toEqual([[4], [5]])
  })
})

describe('removeCluster', () => {
  const base = [cluster([rec(0, 0.5)]), cluster([rec(10, 0.5)])]

  it('drops the addressed cluster and leaves the rest untouched', () => {
    const out = removeCluster(base, 0)
    expect(out.map((c) => c.winner.idx)).toEqual([10])
  })

  it('is a no-op on an unknown key', () => {
    expect(removeCluster(base, 999)).toHaveLength(2)
  })
})

describe('setClusterWinner', () => {
  const base = [cluster([rec(0, 0.3), rec(1, 0.9), rec(2, 0.5)]), cluster([rec(20, 0.5)])]

  it('overrides the score-elected winner with the chosen member', () => {
    const out = setClusterWinner(base, 1, 2)
    expect(out.find((c) => c.members.length === 3)!.winner.idx).toBe(2)
  })

  it('keeps the member set intact', () => {
    const out = setClusterWinner(base, 1, 0)
    expect(memberIdxs(out)).toEqual(memberIdxs(base))
  })

  it('re-sorts clusters by the new winner idx', () => {
    // Cluster keyed at 1 re-elects to frame 2 — still ahead of 20.
    expect(setClusterWinner(base, 1, 2).map((c) => c.winner.idx)).toEqual([2, 20])
  })

  it('is a no-op on an unknown key or a frame outside the cluster', () => {
    expect(setClusterWinner(base, 999, 0)[0]!.winner.idx).toBe(1)
    expect(setClusterWinner(base, 1, 777).find((c) => c.members.length === 3)!.winner.idx).toBe(1)
  })

  it('loses the override when the cluster is later merged', () => {
    // Documented contract: merge/split re-elect by score across the new
    // member set. Pinned so a future change to that rule is deliberate.
    const picked = setClusterWinner(base, 1, 0) // force the 0.3 frame
    const merged = mergeClusters(picked, [0, 20])
    expect(merged[0]!.winner.idx).toBe(1) // back to the 0.9 frame
  })
})

describe('updateClusterCrop', () => {
  const base = [cluster([rec(0, 0.3), rec(1, 0.9), rec(2, 0.5)]), cluster([rec(20, 0.5)])]

  it('applies the patch to the winner', () => {
    const out = updateClusterCrop(base, 1, { hash: 42n })
    expect(out.find((c) => c.members.length === 3)!.winner.hash).toBe(42n)
  })

  it('updates the winner inside members too, so the filmstrip agrees', () => {
    const out = updateClusterCrop(base, 1, { hash: 42n })
    const target = out.find((c) => c.members.length === 3)!
    expect(target.members.find((m) => m.idx === 1)!.hash).toBe(42n)
    expect(target.members.find((m) => m.idx === 1)).toBe(target.winner)
  })

  it('leaves the other members alone', () => {
    const out = updateClusterCrop(base, 1, { hash: 42n })
    const target = out.find((c) => c.members.length === 3)!
    expect(target.members.filter((m) => m.hash === 0n).map((m) => m.idx)).toEqual([0, 2])
  })

  it('never mutates the input', () => {
    updateClusterCrop(base, 1, { hash: 42n })
    expect(base.find((c) => c.members.length === 3)!.winner.hash).toBe(0n)
  })

  it('keeps the cluster key stable — a crop fix must not re-elect', () => {
    // A patched score would otherwise let the winner jump frames mid-edit,
    // moving the key the UI is holding.
    const out = updateClusterCrop(base, 1, { score: 0.01 })
    expect(out.map((c) => c.winner.idx)).toEqual([1, 20])
  })

  it('keeps the member set intact', () => {
    expect(memberIdxs(updateClusterCrop(base, 1, { hash: 42n }))).toEqual(memberIdxs(base))
  })

  it('is a no-op on an unknown key', () => {
    expect(updateClusterCrop(base, 999, { hash: 42n })).toEqual(base)
  })
})
