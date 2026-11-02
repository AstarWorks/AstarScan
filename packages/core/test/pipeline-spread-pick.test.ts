import { describe, expect, it } from 'vitest'
import { SpreadPicker } from '../src/pipeline/spread-pick.js'
import { boxIou, type PixelBox } from '../src/pipeline/yolo-decode.js'

const W = 1080
const H = 1920
const box = (x0: number, y0: number, x1: number, y1: number): PixelBox => ({
  x0,
  y0,
  x1,
  y1,
})
// An open book: left and right page side by side, a page cut by the frame.
const LEFT = box(60, 700, 530, 1300)
const RIGHT = box(550, 700, 1020, 1300)
const CUT = box(-200, 700, 300, 1300)
const cand = (b: PixelBox, confidence: number) => ({ box: b, confidence })

/** One model frame: choose, commit, return the box used. */
function step(p: SpreadPicker, cands: ReturnType<typeof cand>[]): PixelBox {
  const i = p.choose(cands, W, H)
  const b = cands[i]!.box
  p.commit(b)
  return b
}

describe('SpreadPicker', () => {
  it('starts on the left page, then the right one after its ✓', () => {
    const p = new SpreadPicker()
    const frame = [cand(RIGHT, 0.88), cand(LEFT, 0.85)]
    expect(step(p, frame)).toBe(LEFT)
    // Follows the left page even when the right one scores higher.
    expect(step(p, frame)).toBe(LEFT)
    p.onCaptured()
    expect(p.wantsModel).toBe(true)
    expect(step(p, frame)).toBe(RIGHT)
    expect(step(p, [cand(LEFT, 0.9), cand(RIGHT, 0.8)])).toBe(RIGHT)
    // Spread done: a further ✓ does not switch back.
    p.onCaptured()
    expect(step(p, frame)).toBe(RIGHT)
    // New page → left page of the next spread first.
    p.onNewHold()
    expect(step(p, frame)).toBe(LEFT)
  })

  it('ignores a neighbouring page cut by the frame edge', () => {
    const p = new SpreadPicker()
    const frame = [cand(CUT, 0.8), cand(RIGHT, 0.78)]
    expect(step(p, frame)).toBe(RIGHT)
    p.onCaptured()
    // No other whole page: stays, and the page counts as done.
    expect(step(p, frame)).toBe(RIGHT)
    p.onNewHold()
    expect(step(p, frame)).toBe(RIGHT)
  })

  it('new holds before the spread is done do not move it', () => {
    const p = new SpreadPicker()
    const frame = [cand(RIGHT, 0.88), cand(LEFT, 0.85)]
    expect(step(p, frame)).toBe(LEFT)
    p.onNewHold()
    expect(step(p, frame)).toBe(LEFT)
  })
})

describe('boxIou', () => {
  it('is 0 apart, 1 identical', () => {
    expect(boxIou(LEFT, RIGHT)).toBe(0)
    expect(boxIou(LEFT, LEFT)).toBe(1)
  })
})
