import { describe, expect, it } from 'vitest'
import { QuadSmoother, quadArea } from '../src/pipeline/quad-smoother.js'
import type { Quad } from '../src/types.js'

const quad = (x: number, y: number, s = 100): Quad => ({
  tl: { x, y },
  tr: { x: x + s, y },
  br: { x: x + s, y: y + s },
  bl: { x, y: y + s },
})

describe('QuadSmoother', () => {
  it('passes the first quad through unchanged', () => {
    const sm = new QuadSmoother(0.5)
    const q = quad(10, 10)
    expect(sm.apply(q, 0)).toEqual(q)
  })

  it('EMA-blends small jitter toward the history', () => {
    const sm = new QuadSmoother(0.5)
    sm.apply(quad(0, 0), 0)
    const out = sm.apply(quad(10, 0), 1) // high IoU → smooth
    expect(out.tl.x).toBeCloseTo(5)
    expect(out.tl.y).toBeCloseTo(0)
  })

  it('resets on low IoU (page jumped)', () => {
    const sm = new QuadSmoother(0.5)
    sm.apply(quad(0, 0), 0)
    const out = sm.apply(quad(500, 500), 1) // disjoint bboxes → IoU 0
    expect(out).toEqual(quad(500, 500))
  })

  it('resets after a frame gap larger than maxGapFrames', () => {
    const sm = new QuadSmoother(0.5, { maxGapFrames: 5 })
    sm.apply(quad(0, 0), 0)
    const out = sm.apply(quad(10, 0), 20) // gap 20 > 5 → no blending
    expect(out).toEqual(quad(10, 0))
  })
})

describe('quadArea', () => {
  it('computes shoelace area', () => {
    expect(quadArea(quad(0, 0, 100))).toBe(10000)
  })
})
