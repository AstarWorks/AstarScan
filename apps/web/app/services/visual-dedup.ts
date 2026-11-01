/**
 * Visual-similarity dedup for items WITHOUT canonical contact keys.
 *
 * TS port of `scripts/eval/lib/visual-dedup.mjs`. The companion canonical-
 * key dedup merges items that share an email or phone. That misses cases
 * like "event card filmed twice from different angles" — both captures
 * have no contact so they survive as 2 separate items. This pass merges
 * them by 256-bit pHash Hamming distance.
 *
 * Reuses the existing `computePHash` from `phash-dedup.ts` (same
 * algorithm as the camera flow), so behavior is identical to what
 * Phase 1 already validated. Threshold 50 was tuned on the 開催会場
 * event-card duplicate: matching pairs sit at 45, distinct cards at 60+.
 */

import { computePHash } from './phash-dedup'

export interface VisualDedupItem {
  readonly id: string
  readonly canvas: HTMLCanvasElement
  readonly score: number
  readonly hasContact: boolean
}

export interface VisualDedupResult {
  readonly winnerIds: readonly string[]
  /** Map of dropped id → winner id (audit trail). */
  readonly droppedMap: ReadonlyMap<string, string>
}

const DEFAULT_HAMMING_MAX = 50

function hammingBigint(a: bigint, b: bigint): number {
  let x = a ^ b
  let n = 0
  while (x > 0n) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

export function visualDedup(
  items: readonly VisualDedupItem[],
  maxDist: number = DEFAULT_HAMMING_MAX,
): VisualDedupResult {
  const passthrough = items.filter((it) => it.hasContact)
  const candidates = items
    .filter((it) => !it.hasContact)
    .map((it) => ({ ...it, hash: computePHash(it.canvas) }))
    .sort((a, b) => b.score - a.score)

  const kept: typeof candidates = []
  const droppedMap = new Map<string, string>()

  for (const cand of candidates) {
    let matched: (typeof candidates)[number] | null = null
    for (const k of kept) {
      if (hammingBigint(k.hash, cand.hash) <= maxDist) {
        matched = k
        break
      }
    }
    if (matched) {
      droppedMap.set(cand.id, matched.id)
    } else {
      kept.push(cand)
    }
  }

  const winnerIds = [...passthrough.map((p) => p.id), ...kept.map((k) => k.id)]
  return { winnerIds, droppedMap }
}
