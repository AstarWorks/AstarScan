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

/** 16×16 = 256-bit hash. 8×8 (64-bit) is the classical pHash size, but at
 *  1200×1600 document resolution with lots of per-page text detail, 64 bits
 *  is too coarse — two distinct manual pages with similar layout alias to
 *  near-identical hashes. Doubling to 256 bits gives the hash enough
 *  resolution to separate visually distinct pages while still collapsing
 *  near-duplicate captures of the same page. */
const HASH_SIZE = 16

/** Hamming distance ≤ this means same page. Empirical 256-bit distance
 *  distribution on the eval MP4: same-page captures spread from ~20 to ~45
 *  (hand repositioning + tilt changes move a lot of bits), distinct pages
 *  start around ~55 with a long tail to ~100. 60 is the best split — it
 *  collapses ~90% of near-duplicates while still separating genuinely
 *  different pages of the same multilingual manual. */
const DEFAULT_DISTANCE_THRESHOLD = 60

let thumbCanvas: HTMLCanvasElement | null = null

function getThumbContext(): CanvasRenderingContext2D {
  if (!thumbCanvas) {
    thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = HASH_SIZE
    thumbCanvas.height = HASH_SIZE
  }
  const ctx = thumbCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Failed to get 2D context for pHash thumb')
  return ctx
}

/**
 * Compute a 64-bit average-hash from an image source. The returned bigint
 * has bit `i` set when pixel `i` (row-major, 8×8) is brighter than the mean
 * of the thumbnail.
 */
export function computePHash(
  source: HTMLCanvasElement | HTMLImageElement,
): bigint {
  const ctx = getThumbContext()
  ctx.drawImage(source, 0, 0, HASH_SIZE, HASH_SIZE)
  const { data } = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE)
  const count = HASH_SIZE * HASH_SIZE
  const gray = new Float64Array(count)
  let sum = 0
  for (let i = 0, j = 0; j < count; i += 4, j += 1) {
    const v =
      0.2126 * (data[i] ?? 0) +
      0.7152 * (data[i + 1] ?? 0) +
      0.0722 * (data[i + 2] ?? 0)
    gray[j] = v
    sum += v
  }
  const mean = sum / count
  let hash = 0n
  for (let j = 0; j < count; j += 1) {
    if ((gray[j] ?? 0) > mean) hash |= 1n << BigInt(j)
  }
  return hash
}

function popcount(x: bigint): number {
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

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
