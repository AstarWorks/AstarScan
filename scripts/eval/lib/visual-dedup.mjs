/**
 * Visual-similarity dedup for items WITHOUT canonical contact keys.
 *
 * Canonical-key dedup (`canonical-dedup.mjs`) merges items that share an
 * email or phone. That misses cases like "event card filmed twice from
 * different angles" where neither capture has any contact info — they
 * survive as 2 final items even though they're the same physical card.
 *
 * This pass takes a list of items (each with a warpedBuf JPG buffer)
 * and merges those whose 256-bit pHash Hamming distance is ≤ threshold.
 *
 * Default threshold 12 = "very similar" (matches the existing in-app
 * deduper's threshold).
 */

import { jpegToCanvas } from '../canvas-utils.mjs'
import { computePHash, hamming } from '../pipeline.mjs'

// pHash distance 45-50 is "same physical document filmed at different
// angles", confirmed empirically on the 開催会場 event-card duplicate.
// Different cards sit at 60+. We pick 50 as the safe cutoff.
const DEFAULT_HAMMING_MAX = 50

/**
 * @param {Array<{ id: string, warpedBuf: Buffer, score: number, hasContact: boolean }>} items
 * @param {number} maxDist  Hamming distance cutoff
 * @returns {Promise<{ winnerIds: string[], droppedIds: Map<string, string> }>}
 *   winnerIds: items kept after merging
 *   droppedIds: dropped id → winner id mapping (for audit trail)
 */
export async function visualDedup(items, maxDist = DEFAULT_HAMMING_MAX) {
  // Only consider no-contact items; contact-bearing items are already
  // canonically deduped and shouldn't be merged by visual similarity.
  const candidates = []
  const passthrough = []
  for (const it of items) {
    if (it.hasContact) {
      passthrough.push(it)
    } else {
      const canvas = await jpegToCanvas(it.warpedBuf)
      const hash = computePHash(canvas)
      candidates.push({ ...it, hash })
    }
  }

  // Sort by score descending so higher-quality winners are picked first.
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const kept = []
  const dropped = new Map()
  for (const cand of candidates) {
    let matchedTo = null
    for (const k of kept) {
      const d = hamming(k.hash, cand.hash)
      if (d <= maxDist) {
        matchedTo = k
        break
      }
    }
    if (matchedTo) {
      dropped.set(cand.id, matchedTo.id)
    } else {
      kept.push(cand)
    }
  }

  const winnerIds = [...passthrough.map((p) => p.id), ...kept.map((k) => k.id)]
  return { winnerIds, droppedIds: dropped }
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = process.argv[2] ?? '/IdeaProjects/AstarScan/eval-out/meishi/20260516_005528-fps5-v7/items'
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).sort()
  const items = files.map((n, i) => ({
    id: n,
    warpedBuf: fs.readFileSync(path.join(dir, n)),
    score: 100 - i,
    hasContact: false, // treat all as no-contact for the smoke test
  }))
  const result = await visualDedup(items, 12)
  console.log('kept:', result.winnerIds)
  console.log('dropped:')
  for (const [d, w] of result.droppedIds) console.log(`  ${d} → ${w}`)
}
