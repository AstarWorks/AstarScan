/**
 * Perceptual hashing (dHash variant).
 *
 * A perceptual hash produces a compact fingerprint where small visual
 * changes (compression artifacts, minor rotation/crop, brightness shifts)
 * produce hashes with low Hamming distance from the original. We use it
 * to warn the user when they capture what appears to be the same page
 * twice — either accidentally (double-tap) or deliberately (retake).
 *
 * Algorithm: dHash (difference hash)
 *   1. Resize the source to 9×8 (72 pixels)
 *   2. Convert to grayscale
 *   3. For each row, compare adjacent pixels left-to-right
 *      (8 comparisons × 8 rows = 64 bits)
 *   4. Each "left < right" produces a 1 bit, else 0 bit
 *
 * dHash is chosen over aHash/pHash because it's more tolerant of
 * brightness shifts (common with varying natural lighting between
 * captures) while still being sensitive to structural content changes.
 *
 * Reference: http://www.hackerfactor.com/blog/index.php?/archives/529-Kind-of-Like-That.html
 *
 * Hamming distance threshold guidance for 64-bit dHash:
 *   - 0-4 bits:  near-identical (same page, same angle, same lighting)
 *   - 5-10 bits: very similar (likely same page, different capture)
 *   - 11-20 bits: related but clearly different (same document type?)
 *   - 20+ bits: unrelated content
 *
 * Our default `DUPLICATE_THRESHOLD` is 10, which catches obvious
 * double-captures without false-positiving on adjacent pages of the
 * same form/template.
 */

const HASH_WIDTH = 9
const HASH_HEIGHT = 8
const HASH_BITS = (HASH_WIDTH - 1) * HASH_HEIGHT // = 64

export const DUPLICATE_THRESHOLD = 10

/**
 * Compute a 64-bit dHash of the source canvas. Returns a `bigint` so
 * the full 64 bits fit without float precision loss.
 *
 * Returns `0n` if the canvas cannot be read. Callers should treat 0n
 * as "hash unavailable" and skip the duplicate check rather than
 * accidentally matching it against future 0n values.
 */
export function computePHash(source: HTMLCanvasElement): bigint {
  if (source.width === 0 || source.height === 0) return 0n

  const work = document.createElement('canvas')
  work.width = HASH_WIDTH
  work.height = HASH_HEIGHT
  const ctx = work.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 0n

  ctx.drawImage(source, 0, 0, HASH_WIDTH, HASH_HEIGHT)
  const imageData = ctx.getImageData(0, 0, HASH_WIDTH, HASH_HEIGHT)
  const pixels = imageData.data

  // --- Grayscale ---
  const gray = new Float64Array(HASH_WIDTH * HASH_HEIGHT)
  for (let i = 0, j = 0; j < gray.length; i += 4, j += 1) {
    const r = pixels[i] ?? 0
    const g = pixels[i + 1] ?? 0
    const b = pixels[i + 2] ?? 0
    gray[j] = 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  // --- Horizontal difference hash ---
  let hash = 0n
  let bitIndex = 0n
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      const current = gray[y * HASH_WIDTH + x] ?? 0
      const right = gray[y * HASH_WIDTH + x + 1] ?? 0
      if (current < right) {
        hash |= 1n << bitIndex
      }
      bitIndex += 1n
    }
  }
  return hash
}

/**
 * Count bits that differ between two dHash values. Range: [0, 64].
 * Smaller = more similar.
 */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

/**
 * Convenience: returns `true` if `hash` is within `threshold` of any
 * hash in `existing`. Used by the capture pipeline to flag duplicate
 * candidates before adding a new page to the session.
 */
export function findDuplicate(
  hash: bigint,
  existing: readonly bigint[],
  threshold: number = DUPLICATE_THRESHOLD,
): { index: number; distance: number } | null {
  if (hash === 0n) return null
  for (let i = 0; i < existing.length; i += 1) {
    const other = existing[i]
    if (other === undefined || other === 0n) continue
    const distance = hammingDistance(hash, other)
    if (distance <= threshold) {
      return { index: i, distance }
    }
  }
  return null
}

/** Exposed for tests / consumers that want to know the bit budget. */
export const PHASH_BIT_WIDTH = HASH_BITS
