/**
 * Perceptual-hash (pHash) document deduplication.
 *
 * Same-page captures taken a second apart in handheld video differ in hand
 * position, page tilt, and micro-adjustments of how the user is holding the
 * paper. SSIM on the whole thumbnail punishes those pixel-level shifts and
 * returns scores below the duplicate threshold, so near-identical pages
 * slip through as distinct captures.
 *
 * pHash compares the *low-frequency* content of the image (via a DCT-less
 * average-hash approximation: 8×8 downsample → bit per pixel vs mean) and
 * Hamming distance between two 64-bit hashes. Small shifts and tilts don't
 * alter the mean-based bit pattern, so two frames of the same page reliably
 * collide within a distance of ≤ 10.
 *
 * This replaces the previous SSIM-based dedup for the video-scan flow.
 * Threshold tuned on the AstarScan eval MP4 (11 unique pages handheld).
 */

// Hash math is unified in @astarworks/scan-core (pipeline/hash.ts), shared
// with the eval harness. This file binds it to DOM canvases and keeps the
// legacy PHashDedupManager.

import {
  createHashOps,
  popcount,
  tileDistance as coreTileDistance,
} from '@astarworks/scan-core/pipeline'
import type { CanvasLike } from '@astarworks/scan-core/pipeline'

/** Hamming distance ≤ this means same page. At 256 bits: same-page
 *  captures spread 20-45, distinct pages start around 55. 60 is the
 *  practical split for the legacy PHashDedupManager. The batch
 *  collector passes its own, separately-tuned threshold. */
const DEFAULT_DISTANCE_THRESHOLD = 60

const hashOps = createHashOps((w, h) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  // DOM canvas satisfies the structural contract; the cast crosses the
  // lib.dom ↔ scan-core structural-type boundary in one place.
  return c as unknown as CanvasLike
})

/**
 * Compute a 256-bit average-hash from an image source. The returned bigint
 * has bit `i` set when pixel `i` (row-major, 16×16) is brighter than the
 * mean of the thumbnail.
 */
export function computePHash(
  source: HTMLCanvasElement | HTMLImageElement,
): bigint {
  return hashOps.computePHash(source as unknown as CanvasLike)
}

/**
 * Tile-pHash: split the image into a 4×4 grid and compute an 8×8 = 64-bit
 * average-hash per tile. Returns 16 bigints — input to `tileDistance`.
 */
export function computeTilePHash(
  source: HTMLCanvasElement | HTMLImageElement,
): bigint[] {
  return hashOps.computeTilePHash(source as unknown as CanvasLike)
}

/** 80th-percentile per-tile Hamming distance — see scan-core hash.ts. */
export const tileDistance = coreTileDistance

/**
 * Dedup manager storing a 64-bit pHash per accepted page. `isDuplicate`
 * returns the matching page id when any stored hash is within
 * `threshold` (Hamming distance) of the new hash.
 */
export class PHashDedupManager {
  private readonly hashes: bigint[] = []
  private readonly ids: string[] = []

  isDuplicate(
    newHash: bigint,
    threshold: number = DEFAULT_DISTANCE_THRESHOLD,
  ): { pageId: string; distance: number } | null {
    let bestId: string | null = null
    let bestDistance = Infinity
    for (let i = 0; i < this.hashes.length; i += 1) {
      const d = popcount(this.hashes[i]! ^ newHash)
      if (d < bestDistance) {
        bestDistance = d
        bestId = this.ids[i]!
      }
    }
    return bestId !== null && bestDistance <= threshold
      ? { pageId: bestId, distance: bestDistance }
      : null
  }

  addPage(id: string, hash: bigint): void {
    this.ids.push(id)
    this.hashes.push(hash)
  }

  removePage(id: string): void {
    const idx = this.ids.indexOf(id)
    if (idx >= 0) {
      this.ids.splice(idx, 1)
      this.hashes.splice(idx, 1)
    }
  }

  clear(): void {
    this.ids.length = 0
    this.hashes.length = 0
  }

  get size(): number {
    return this.ids.length
  }
}
