import { describe, expect, it } from 'vitest'
import {
  boxAgreement,
  isConvexQuad,
  otsuAbove,
  quadContains,
  type CornerRefineResult,
} from '../src/pipeline/corner-refine.js'
import {
  OrientationPicker,
  detectPageCorners,
  orientationScore,
  quadCoverage,
  type FrameTurn,
} from '../src/pipeline/orientation.js'
import type { PixelBox } from '../src/pipeline/yolo-decode.js'
import type { Quad } from '../src/types.js'

const rect = (x0: number, y0: number, x1: number, y1: number): Quad => ({
  tl: { x: x0, y: y0 },
  tr: { x: x1, y: y0 },
  br: { x: x1, y: y1 },
  bl: { x: x0, y: y1 },
})
const box = (x0: number, y0: number, x1: number, y1: number): PixelBox => ({
  x0,
  y0,
  x1,
  y1,
})

describe('corner-refine helpers', () => {
  it('isConvexQuad rejects self-intersecting and degenerate quads', () => {
    expect(isConvexQuad(rect(0, 0, 10, 20))).toBe(true)
    const bowtie: Quad = {
      tl: { x: 0, y: 0 },
      tr: { x: 10, y: 20 },
      br: { x: 10, y: 0 },
      bl: { x: 0, y: 20 },
    }
    expect(isConvexQuad(bowtie)).toBe(false)
    const dart: Quad = {
      tl: { x: 0, y: 0 },
      tr: { x: 10, y: 0 },
      br: { x: 3, y: 3 },
      bl: { x: 0, y: 10 },
    }
    expect(isConvexQuad(dart)).toBe(false)
    expect(isConvexQuad(rect(0, 0, 0, 10))).toBe(false)
  })

  it('quadContains', () => {
    expect(quadContains(rect(0, 0, 10, 10), { x: 5, y: 5 })).toBe(true)
    expect(quadContains(rect(0, 0, 10, 10), { x: 11, y: 5 })).toBe(false)
  })

  it('boxAgreement is quad area over box area', () => {
    expect(boxAgreement(rect(0, 0, 50, 100), box(0, 0, 100, 100))).toBe(0.5)
    expect(boxAgreement(rect(0, 0, 1, 1), box(0, 0, 0, 0))).toBe(0)
  })

  it('otsuAbove splits the bright side', () => {
    // ink 20, desk 200, paper 245 — first split is ink vs rest.
    const px = [
      ...new Array(100).fill(20),
      ...new Array(400).fill(200),
      ...new Array(500).fill(245),
    ]
    const t = otsuAbove(px, 110)
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThanOrEqual(200)
    expect(t!).toBeLessThan(245)
    expect(otsuAbove([1, 2, 3], 0)).toBeNull()
  })
})

describe('orientation score', () => {
  it('quadCoverage', () => {
    const a = rect(0, 0, 100, 100)
    expect(quadCoverage(a, a)).toBeCloseTo(1)
    expect(quadCoverage(rect(0, 0, 50, 100), a)).toBeCloseTo(0.5)
    expect(quadCoverage(rect(200, 200, 300, 300), a)).toBe(0)
    // Winding of either quad does not matter.
    const ccw: Quad = { tl: a.tl, tr: a.bl, br: a.br, bl: a.tr }
    expect(quadCoverage(ccw, rect(0, 0, 50, 50))).toBeCloseTo(1)
  })

  it('is 0 when the snap failed', () => {
    const q = rect(0, 0, 10, 10)
    expect(orientationScore(q, { quad: q, refined: false })).toBe(0)
    expect(orientationScore(q, { quad: q, refined: true })).toBeCloseTo(1)
  })
})

describe('OrientationPicker', () => {
  it('probes every turn first, then every probeEvery frames', () => {
    const p = new OrientationPicker({ probeEvery: 3 })
    expect(p.plan()).toEqual(['none', 'cw', 'ccw'])
    p.report({ none: 0.2, cw: 0.9, ccw: 0.5 })
    expect(p.current).toBe('cw')
    expect(p.plan()).toEqual(['cw'])
    expect(p.plan()).toEqual(['cw'])
    expect(p.plan()).toEqual(['none', 'cw', 'ccw'])
  })

  it('does not move on a single-turn frame and switches with margin', () => {
    const p = new OrientationPicker({ alpha: 1, switchMargin: 0.1 })
    p.plan()
    expect(p.report({ none: 0.8, cw: 0.85, ccw: 0.1 })).toBe('none')
    expect(p.report({ cw: 1 })).toBe('none')
    expect(p.report({ none: 0.5, cw: 0.9, ccw: 0.7 })).toBe('cw')
  })
})

describe('detectPageCorners', () => {
  const snapTo =
    (q: Quad) =>
    (_: Quad, b: PixelBox): CornerRefineResult => ({
      quad: q,
      refined: true,
      boxAgreement: boxAgreement(q, b),
    })

  it('runs a portrait frame once, unturned', async () => {
    const calls: FrameTurn[] = []
    const r = await detectPageCorners(
      { width: 720, height: 1280 },
      async (t) => {
        calls.push(t)
        return { quad: rect(100, 100, 600, 1100), box: box(80, 80, 640, 1150) }
      },
      () => null,
      new OrientationPicker(),
    )
    expect(calls).toEqual(['none'])
    expect(r!.refine.refined).toBe(false)
    expect(r!.refine.quad).toEqual(rect(100, 100, 600, 1100))
  })

  it('picks the landscape turn whose keypoints cover the snapped page', async () => {
    const page = rect(100, 50, 1100, 650)
    // 'ccw' keypoints cover the page best.
    const kp: Record<FrameTurn, Quad> = {
      none: rect(500, 300, 700, 400),
      cw: rect(300, 200, 900, 500),
      ccw: rect(120, 60, 1080, 640),
    }
    const calls: FrameTurn[] = []
    const r = await detectPageCorners(
      { width: 1280, height: 720 },
      async (t) => {
        calls.push(t)
        return { quad: kp[t], box: box(90, 40, 1110, 660) }
      },
      snapTo(page),
      new OrientationPicker(),
    )
    expect(calls).toEqual(['none', 'cw', 'ccw'])
    expect(r!.turn).toBe('ccw')
    expect(r!.refine.quad).toEqual(page)
  })
})
