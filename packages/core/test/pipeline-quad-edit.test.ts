// Geometry tests for manual corner correction. These cover the whole
// testable surface of the feature: `apps/web` has no component test
// harness, so anything that stays inside QuadEditor.vue is verified only
// by hand. That is the reason the geometry lives here at all.
//
// The invariants under test are the ones a drag silently depends on:
// grabbing picks the corner the finger is actually on, dragging moves that
// corner ONLY, corners never escape the frame, and a display→source→display
// round trip is lossless (otherwise the quad creeps every time the editor
// re-opens).
import { describe, expect, it } from 'vitest'
import {
  QUAD_CORNERS,
  clampPointToFrame,
  moveQuadCorner,
  nearestQuadCorner,
  quadCornerList,
  scaleQuad,
} from '../src/pipeline/quad-edit.js'
import type { Quad } from '../src/types.js'

const square: Quad = {
  tl: { x: 100, y: 100 },
  tr: { x: 300, y: 100 },
  br: { x: 300, y: 400 },
  bl: { x: 100, y: 400 },
}

describe('quadCornerList', () => {
  it('emits the four corners in the clockwise order Quad declares', () => {
    expect(quadCornerList(square).map((c) => c.corner)).toEqual(['tl', 'tr', 'br', 'bl'])
  })

  it('carries each corner point through unchanged', () => {
    expect(quadCornerList(square).map((c) => c.point)).toEqual([
      square.tl,
      square.tr,
      square.br,
      square.bl,
    ])
  })
})

describe('nearestQuadCorner', () => {
  it('finds the corner under the press', () => {
    expect(nearestQuadCorner(square, { x: 305, y: 395 }, 40)).toBe('br')
  })

  it('returns null when the press is outside the grab radius', () => {
    // Dead centre of the quad — far from every corner.
    expect(nearestQuadCorner(square, { x: 200, y: 250 }, 40)).toBeNull()
  })

  it('accepts a press exactly at the grab radius', () => {
    // The boundary is inclusive: a 44px tap target must not have a
    // one-pixel dead ring at its edge.
    expect(nearestQuadCorner(square, { x: 140, y: 100 }, 40)).toBe('tl')
    expect(nearestQuadCorner(square, { x: 140.5, y: 100 }, 40)).toBeNull()
  })

  it('picks the closer of two corners in range', () => {
    // Both tl (x=100) and tr (x=300) are within 120 of x=190; tl is closer.
    expect(nearestQuadCorner(square, { x: 190, y: 100 }, 120)).toBe('tl')
    expect(nearestQuadCorner(square, { x: 210, y: 100 }, 120)).toBe('tr')
  })

  it('resolves an exact tie to the earlier corner clockwise', () => {
    // Equidistant from tl and tr. Degenerate either way — only needs to
    // be deterministic so the handle does not flicker between corners.
    expect(nearestQuadCorner(square, { x: 200, y: 100 }, 200)).toBe('tl')
  })
})

describe('clampPointToFrame', () => {
  it('leaves an interior point alone', () => {
    expect(clampPointToFrame({ x: 50, y: 60 }, 640, 480)).toEqual({ x: 50, y: 60 })
  })

  it('clamps past both bounds on both axes', () => {
    expect(clampPointToFrame({ x: -10, y: 900 }, 640, 480)).toEqual({ x: 0, y: 480 })
    expect(clampPointToFrame({ x: 700, y: -5 }, 640, 480)).toEqual({ x: 640, y: 0 })
  })
})

describe('moveQuadCorner', () => {
  it('moves only the named corner', () => {
    const moved = moveQuadCorner(square, 'tr', { x: 280, y: 130 }, 640, 480)
    expect(moved.tr).toEqual({ x: 280, y: 130 })
    expect(moved.tl).toEqual(square.tl)
    expect(moved.br).toEqual(square.br)
    expect(moved.bl).toEqual(square.bl)
  })

  it('never mutates the input quad', () => {
    const before = structuredClone(square)
    moveQuadCorner(square, 'bl', { x: 0, y: 0 }, 640, 480)
    expect(square).toEqual(before)
  })

  it('clamps the dragged corner into the frame', () => {
    const moved = moveQuadCorner(square, 'bl', { x: -50, y: 5000 }, 640, 480)
    expect(moved.bl).toEqual({ x: 0, y: 480 })
  })

  it('allows a drag that crosses a neighbour', () => {
    // Self-intersection is produced, not prevented: the editor shows the
    // bad shape and refuses the SAVE (via classifyQuad). Freezing the
    // handle mid-drag would read as the UI being broken.
    const crossed = moveQuadCorner(square, 'tl', { x: 400, y: 100 }, 640, 480)
    expect(crossed.tl.x).toBeGreaterThan(crossed.tr.x)
  })

  it('handles every corner name', () => {
    for (const corner of QUAD_CORNERS) {
      const moved = moveQuadCorner(square, corner, { x: 7, y: 9 }, 640, 480)
      expect(moved[corner]).toEqual({ x: 7, y: 9 })
    }
  })
})

describe('scaleQuad', () => {
  it('scales both axes independently', () => {
    const scaled = scaleQuad(square, 640, 480, 320, 960)
    expect(scaled.tl).toEqual({ x: 50, y: 200 })
    expect(scaled.br).toEqual({ x: 150, y: 800 })
  })

  it('round-trips display -> source -> display losslessly', () => {
    // The editor maps to source space to save and back to display space to
    // re-open. Drift here would creep the quad on every edit.
    const toSource = scaleQuad(square, 375, 500, 1280, 1707)
    const back = scaleQuad(toSource, 1280, 1707, 375, 500)
    for (const corner of QUAD_CORNERS) {
      expect(back[corner].x).toBeCloseTo(square[corner].x, 10)
      expect(back[corner].y).toBeCloseTo(square[corner].y, 10)
    }
  })

  it('returns the quad unchanged when the source frame has no size', () => {
    // Happens before the image element has loaded; mapping nothing is the
    // right answer, NaN corners are not.
    expect(scaleQuad(square, 0, 0, 1280, 720)).toEqual(square)
  })

  it('is identity when the sizes match', () => {
    expect(scaleQuad(square, 640, 480, 640, 480)).toEqual(square)
  })
})
