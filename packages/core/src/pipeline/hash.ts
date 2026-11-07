/**
 * Perceptual hashing — 256-bit average hash + 4×4 tile-pHash.
 *
 * Same-page captures taken a second apart in handheld video differ in hand
 * position, page tilt, and micro-adjustments. pHash compares low-frequency
 * content (downsample → bit per pixel vs mean), so small shifts don't alter
 * the bit pattern. Tile-pHash hashes a 4×4 grid per-tile so a hand occluding
 * one corner only perturbs 1-2 tiles; the 80th-percentile per-tile Hamming
 * distance reflects "how well do the well-aligned tiles match".
 *
 * Pure math is exported directly; `createHashOps` binds the thumbnail
 * canvases via the injected canvas factory (DOM or @napi-rs/canvas).
 */

import type {
  CanvasImageSourceLike,
  Context2DLike,
  CreateCanvas,
} from './deps.js'
import { HASH_SIZE, TILE_BITS, TILE_GRID, TILE_HASH_SIZE } from './constants.js'

/** Number of set bits in a bigint. */
export function popcount(x: bigint): number {
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

/** Hamming distance between two same-width hash bigints. */
export function hamming(a: bigint, b: bigint): number {
  return popcount(a ^ b)
}

/** Average hash over `count` RGBA pixels: bit `j` set when pixel `j`
 *  (Rec. 709 luma) is brighter than the mean. */
export function avgHashFromImageData(
  data: Uint8ClampedArray,
  count: number,
): bigint {
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

/**
 * 80th-percentile per-tile Hamming distance between two tile-pHash arrays.
 * Lower = more similar. Same physical page across angles: 5-15; different
 * pages: 25+ on warped 1200×1600 documents. The percentile ignores the
 * worst-affected tiles (hand/glare) — mean would be dragged up by them,
 * min would be too lenient.
 */
export function tileDistance(
  a: readonly bigint[],
  b: readonly bigint[],
  percentile = 0.8,
): number {
  const dists: number[] = []
  for (let i = 0; i < a.length; i += 1)
    dists.push(popcount((a[i] ?? 0n) ^ (b[i] ?? 0n)))
  dists.sort((x, y) => x - y)
  const idx = Math.min(
    dists.length - 1,
    Math.floor(percentile * (dists.length - 1)),
  )
  return dists[idx] ?? 0
}

export interface HashOps {
  /** 256-bit average hash of the full image (16×16 thumbnail). */
  computePHash(source: CanvasImageSourceLike): bigint
  /** 4×4 grid of 64-bit per-tile average hashes (16 bigints). */
  computeTilePHash(source: CanvasImageSourceLike): bigint[]
}

/**
 * Bind the hash functions to a canvas factory. The thumbnail canvases are
 * created lazily and reused across calls (hot path: every accepted frame).
 */
export function createHashOps(createCanvas: CreateCanvas): HashOps {
  let thumbCtx: Context2DLike | null = null
  let tileCtx: Context2DLike | null = null

  const getCtx = (
    size: number,
    cached: Context2DLike | null,
  ): Context2DLike => {
    if (cached) return cached
    const ctx = createCanvas(size, size).getContext('2d', {
      willReadFrequently: true,
    })
    if (!ctx) throw new Error('scan-core: failed to get 2D context for hashing')
    return ctx
  }

  return {
    computePHash(source) {
      thumbCtx = getCtx(HASH_SIZE, thumbCtx)
      thumbCtx.drawImage(source, 0, 0, HASH_SIZE, HASH_SIZE)
      const { data } = thumbCtx.getImageData(0, 0, HASH_SIZE, HASH_SIZE)
      return avgHashFromImageData(data, HASH_SIZE * HASH_SIZE)
    },

    computeTilePHash(source) {
      const W = source.width
      const H = source.height
      const tileW = W / TILE_GRID
      const tileH = H / TILE_GRID
      tileCtx = getCtx(TILE_HASH_SIZE, tileCtx)
      const hashes: bigint[] = []
      for (let row = 0; row < TILE_GRID; row += 1) {
        for (let col = 0; col < TILE_GRID; col += 1) {
          tileCtx.clearRect(0, 0, TILE_HASH_SIZE, TILE_HASH_SIZE)
          tileCtx.drawImage(
            source,
            col * tileW,
            row * tileH,
            tileW,
            tileH,
            0,
            0,
            TILE_HASH_SIZE,
            TILE_HASH_SIZE,
          )
          const { data } = tileCtx.getImageData(
            0,
            0,
            TILE_HASH_SIZE,
            TILE_HASH_SIZE,
          )
          hashes.push(avgHashFromImageData(data, TILE_BITS))
        }
      }
      return hashes
    },
  }
}
