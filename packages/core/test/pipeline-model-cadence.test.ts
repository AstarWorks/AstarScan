import { describe, expect, it } from 'vitest'
import { ModelCadence } from '../src/pipeline/model-cadence.js'
import type { Quad } from '../src/types.js'

const rect = (x0: number, y0: number, x1: number, y1: number): Quad => ({
  tl: { x: x0, y: y0 },
  tr: { x: x1, y: y0 },
  br: { x: x1, y: y1 },
  bl: { x: x0, y: y1 },
})
const anchor = {
  box: { x0: 0, y0: 0, x1: 100, y1: 140 },
  quad: rect(10, 10, 90, 130),
  confidence: 0.8,
  frameW: 1080,
  frameH: 1920,
}

describe('ModelCadence', () => {
  it('runs the model first, then snaps until modelEvery', () => {
    const c = new ModelCadence({ modelEvery: 3 })
    expect(c.anchorFor(1080, 1920)).toBeNull()
    c.modelRan(anchor)
    expect(c.anchorFor(1080, 1920)).not.toBeNull()
    c.snapped(rect(12, 10, 92, 130))
    expect(c.anchorFor(1080, 1920)?.quad.tl.x).toBe(12)
    c.snapped(rect(12, 10, 92, 130))
    // Third frame since the model: model again.
    expect(c.anchorFor(1080, 1920)).toBeNull()
  })

  it('runs the model when nothing was found, the snap failed or the size changed', () => {
    const c = new ModelCadence({ modelEvery: 4 })
    c.modelRan(null)
    expect(c.anchorFor(1080, 1920)).toBeNull()
    c.modelRan(anchor)
    expect(c.anchorFor(1920, 1080)).toBeNull()
    expect(c.anchorFor(1080, 1920)).not.toBeNull()
    c.lost()
    expect(c.anchorFor(1080, 1920)).toBeNull()
  })

  it('modelEvery 1 always runs the model', () => {
    const c = new ModelCadence({ modelEvery: 1 })
    c.modelRan(anchor)
    expect(c.anchorFor(1080, 1920)).toBeNull()
  })
})
