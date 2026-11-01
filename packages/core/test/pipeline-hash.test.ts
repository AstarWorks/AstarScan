import { describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import {
  avgHashFromImageData,
  createHashOps,
  hamming,
  popcount,
  tileDistance,
} from '../src/pipeline/hash.js'
import { HASH_SIZE, TILE_GRID } from '../src/pipeline/constants.js'
import type { CanvasLike, CreateCanvas } from '../src/pipeline/deps.js'

/** Reference copy of the frozen-baseline implementation
 *  (scripts/eval/pipeline.mjs / apps/web phash-dedup.ts at unification
 *  time). Guards bit-exactness across future refactors of hash.ts. */
function referenceAvgHash(data: Uint8ClampedArray, count: number): bigint {
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

/** Deterministic pseudo-random RGBA buffer (LCG, no Math.random). */
function syntheticRgba(pixels: number, seed: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(pixels * 4)
  let s = seed >>> 0
  for (let i = 0; i < data.length; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0
    data[i] = s & 0xff
  }
  return data
}

const nodeCreateCanvas: CreateCanvas = (w, h) =>
  createCanvas(w, h) as unknown as CanvasLike

describe('popcount / hamming', () => {
  it('counts set bits', () => {
    expect(popcount(0n)).toBe(0)
    expect(popcount(0b1011n)).toBe(3)
    expect(popcount((1n << 255n) | 1n)).toBe(2)
  })

  it('hamming is XOR popcount', () => {
    expect(hamming(0b1100n, 0b1010n)).toBe(2)
    expect(hamming(123456789n, 123456789n)).toBe(0)
  })
})

describe('avgHashFromImageData', () => {
  it('is bit-exact against the frozen reference implementation', () => {
    for (const seed of [1, 42, 20260612]) {
      const count = HASH_SIZE * HASH_SIZE
      const data = syntheticRgba(count, seed)
      expect(avgHashFromImageData(data, count)).toBe(
        referenceAvgHash(data, count),
      )
    }
  })

  it('ignores the alpha channel', () => {
    const count = 64
    const a = syntheticRgba(count, 7)
    const b = new Uint8ClampedArray(a)
    for (let i = 3; i < b.length; i += 4) b[i] = 0
    expect(avgHashFromImageData(a, count)).toBe(avgHashFromImageData(b, count))
  })
})

describe('tileDistance', () => {
  it('returns the 80th-percentile per-tile hamming', () => {
    // 16 tiles: 14 identical, 2 wildly different → percentile ignores the outliers
    const a = Array.from({ length: 16 }, () => 0n)
    const b = [...a]
    b[0] = (1n << 64n) - 1n // 64 bits flipped
    b[1] = (1n << 32n) - 1n // 32 bits flipped
    // sorted dists: fourteen 0s then 32, 64; idx = floor(0.8 * 15) = 12 → 0
    expect(tileDistance(a, b)).toBe(0)
    expect(tileDistance(a, b, 1.0)).toBe(64)
  })
})

describe('createHashOps (node canvas)', () => {
  it('produces stable hashes for identical content and differing ones for inverted content', () => {
    const { computePHash, computeTilePHash } = createHashOps(nodeCreateCanvas)
    const make = (invert: boolean): CanvasLike => {
      const c = createCanvas(64, 64)
      const ctx = c.getContext('2d')
      ctx.fillStyle = invert ? '#fff' : '#000'
      ctx.fillRect(0, 0, 64, 64)
      ctx.fillStyle = invert ? '#000' : '#fff'
      ctx.fillRect(0, 0, 32, 64)
      return c as unknown as CanvasLike
    }
    const h1 = computePHash(make(false))
    const h2 = computePHash(make(false))
    const h3 = computePHash(make(true))
    expect(h1).toBe(h2)
    expect(hamming(h1, h3)).toBeGreaterThan(100) // inverted halves flip most bits
    const t1 = computeTilePHash(make(false))
    expect(t1).toHaveLength(TILE_GRID * TILE_GRID)
    expect(tileDistance(t1, computeTilePHash(make(false)))).toBe(0)
  })
})
