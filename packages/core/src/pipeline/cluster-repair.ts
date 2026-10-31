/**
 * Cluster repair — user-driven corrections on top of `clusterBySegments`.
 *
 * Why this exists: no clustering threshold separates "same page, crop
 * jitter" from "different page" on real footage (measured — see
 * `segment-cluster.ts` and `docs/eval-results.md`). The residual error on
 * the frozen eval config is entirely duplicates and junk, i.e. exactly the
 * classes a human can fix in one tap. `eval-results.md` calls this out as
 * the cheapest remaining win ("Future work" path 3).
 *
 * Everything here is a pure function over the clustering output: it takes
 * `SegmentCluster<T>[]`, returns a NEW array, and never mutates the input
 * or its members. No canvas, no cv, no re-hashing — every member already
 * carries its own `hash` / `tileHash` / `score`, so repairs are pure
 * bookkeeping over data the pipeline already produced.
 *
 * Clusters are addressed by their winner's frame index (`winner.idx`).
 * That is the same key the pipeline sorts on and it is unique per cluster,
 * so callers can hold it across a repair without a separate id table.
 * Note it CHANGES when a repair re-elects a winner — re-read keys from
 * the returned array rather than caching them across operations.
 *
 * Every function is a no-op returning the input array when its target
 * cannot be addressed (unknown key, split point outside the member range).
 * This matches the `deletePage` / `reorderPages` contract in `types.ts`
 * ("Safe no-op if the id is unknown") so the UI never has to pre-validate.
 */

import type { SegmentCluster, SegmentFrameRecord } from './segment-cluster.js'

/**
 * The cluster's representative frame: highest `score`, earliest frame on a
 * tie. This is the SAME rule `clusterBySegments` applies at both of its
 * winner-election sites (segment formation and post-union-find grouping) —
 * a repair must not silently pick a different frame than the pipeline
 * would have.
 *
 * Callers must not pass an empty array; a cluster with no members is not
 * representable.
 */
export function pickWinner<T extends SegmentFrameRecord>(
  members: readonly T[],
): T {
  return members.reduce((best, m) => (m.score > best.score ? m : best))
}

/** Members ascending by frame index — the order `clusterBySegments` emits. */
function byIdx<T extends SegmentFrameRecord>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => a.idx - b.idx)
}

/** Clusters ascending by winner index — the order `clusterBySegments` emits. */
function sorted<T extends SegmentFrameRecord>(
  clusters: readonly SegmentCluster<T>[],
): SegmentCluster<T>[] {
  return [...clusters].sort((a, b) => a.winner.idx - b.winner.idx)
}

/** Rebuild a cluster from members, re-electing the winner by the shared rule. */
function fromMembers<T extends SegmentFrameRecord>(
  members: readonly T[],
): SegmentCluster<T> {
  const ordered = byIdx(members)
  return { winner: pickWinner(ordered), members: ordered }
}

/**
 * Fold two or more clusters into one — the fix for an over-split page
 * (the same physical page captured at two angles, landing in two
 * clusters). This is the dominant residual error class on the eval set.
 *
 * The merged cluster's winner is re-elected across the combined members,
 * so a manual winner pick (`setClusterWinner`) on any input cluster is
 * discarded. No-op unless at least two of `keys` resolve to a cluster.
 */
export function mergeClusters<T extends SegmentFrameRecord>(
  clusters: readonly SegmentCluster<T>[],
  keys: readonly number[],
): SegmentCluster<T>[] {
  const wanted = new Set(keys)
  const targets = clusters.filter((c) => wanted.has(c.winner.idx))
  if (targets.length < 2) return [...clusters]

  const rest = clusters.filter((c) => !wanted.has(c.winner.idx))
  const merged = fromMembers(targets.flatMap((c) => c.members))
  return sorted([...rest, merged])
}

/**
 * Cut one cluster in two at `atIdx` — the fix for an over-merge (two
 * different pages collapsed into one, e.g. pages sharing boilerplate that
 * ORB validated as a planar match). Members with `idx < atIdx` form the
 * first cluster, the rest form the second.
 *
 * No-op when the key is unknown or when `atIdx` leaves either side empty:
 * a split that produces nothing is not a repair the user can have meant.
 */
export function splitCluster<T extends SegmentFrameRecord>(
  clusters: readonly SegmentCluster<T>[],
  key: number,
  atIdx: number,
): SegmentCluster<T>[] {
  const target = clusters.find((c) => c.winner.idx === key)
  if (!target) return [...clusters]

  const head = target.members.filter((m) => m.idx < atIdx)
  const tail = target.members.filter((m) => m.idx >= atIdx)
  if (head.length === 0 || tail.length === 0) return [...clusters]

  const rest = clusters.filter((c) => c.winner.idx !== key)
  return sorted([...rest, fromMembers(head), fromMembers(tail)])
}

/**
 * Drop a cluster entirely — the fix for a false positive (a hand, a table
 * edge, a transitional frame that no verifier could reject).
 */
export function removeCluster<T extends SegmentFrameRecord>(
  clusters: readonly SegmentCluster<T>[],
  key: number,
): SegmentCluster<T>[] {
  return clusters.filter((c) => c.winner.idx !== key)
}

/**
 * Override which member represents the cluster — the fix for "the right
 * page, but the pipeline kept a blurrier frame of it". The composite score
 * ranks sharpness and detector confidence, which is not always what the
 * user judges by eye.
 *
 * The override survives until that cluster is merged or split, both of
 * which re-elect by score across the new member set.
 *
 * No-op when the key is unknown or `memberIdx` is not in the cluster.
 */
export function setClusterWinner<T extends SegmentFrameRecord>(
  clusters: readonly SegmentCluster<T>[],
  key: number,
  memberIdx: number,
): SegmentCluster<T>[] {
  const target = clusters.find((c) => c.winner.idx === key)
  if (!target) return [...clusters]

  const chosen = target.members.find((m) => m.idx === memberIdx)
  if (!chosen) return [...clusters]

  const rest = clusters.filter((c) => c.winner.idx !== key)
  return sorted([...rest, { winner: chosen, members: byIdx(target.members) }])
}

/**
 * Replace the winner's crop after a manual corner correction — the fix for
 * "right page, right frame, wrong edges". The caller re-warps from the
 * retained source frame and hands the new crop in; this function is the
 * pure bookkeeping half, keeping cluster mutation in one place.
 *
 * `patch` carries whatever the re-warp regenerated (quad, JPEG, size,
 * hashes — `types.ts`'s `updatePageQuad` requires the hashes be
 * regenerated too). It is applied to the winner only, and the member list
 * is updated in place so the winner and its entry in `members` stay the
 * same object — the filmstrip addresses members by `idx`, which the patch
 * never touches.
 *
 * `score` is deliberately patchable but never re-elected on: correcting a
 * crop must not make a page silently jump to a different frame. No-op when
 * the key is unknown.
 */
export function updateClusterCrop<T extends SegmentFrameRecord>(
  clusters: readonly SegmentCluster<T>[],
  key: number,
  patch: Partial<Omit<T, 'idx' | 't_s'>>,
): SegmentCluster<T>[] {
  const target = clusters.find((c) => c.winner.idx === key)
  if (!target) return [...clusters]

  const winner: T = { ...target.winner, ...patch }
  const members = byIdx(target.members).map((m) =>
    m.idx === winner.idx ? winner : m,
  )
  const rest = clusters.filter((c) => c.winner.idx !== key)
  return sorted([...rest, { winner, members }])
}
