/**
 * Which of the model's page candidates to follow on an open book.
 *
 * The live scan follows one page at a time. On a two-page spread the
 * model returns both pages with similar confidence, and taking the best
 * one per frame flipped between them, so the page never held still and
 * got no ✓ (book clips). `SpreadPicker`:
 *
 *   - follows the page it is on (largest box overlap with the last one);
 *   - when a new page appears after a finished spread (`onNewHold`), goes
 *     to the LEFT page first;
 *   - after a ✓ (`onCaptured`), moves to the other page of the spread when
 *     there is one — a candidate that does not overlap the captured page,
 *     lies wholly inside the frame (a page cut by the frame edge is the
 *     neighbouring page of a one-page-at-a-time scan, not a target) and is
 *     at least `minAreaRatio` of the captured page's size; after that
 *     page's ✓ the spread is done and it stays put until the next new
 *     page.
 *
 * Reading order is assumed left → right (pages turned right to left).
 *
 * Pure: no DOM, no OpenCV, no model.
 */

import { boxIou, type PixelBox } from './yolo-decode.js'

export const SPREAD_PICK_DEFAULTS = {
  /** Boxes overlapping more than this are the same page. */
  sameIou: 0.3,
  /** A page's box must keep this fraction of the frame from every edge. */
  edgeMargin: 0.005,
  /** The other page must be at least this fraction of the captured one. */
  minAreaRatio: 0.5,
  /** Candidates below this fraction of the top confidence are ignored. */
  minRelConf: 0.6,
} as const

export type SpreadPickOptions = {
  -readonly [K in keyof typeof SPREAD_PICK_DEFAULTS]: number
}

export interface PageCandidate {
  box: PixelBox
  confidence: number
}

type Mode =
  /** Follow the current page. */
  | 'follow'
  /** Go to the left page on the next model frame. */
  | 'left'
  /** Go to the page beside the captured one on the next model frame. */
  | 'other'

const area = (b: PixelBox) =>
  Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0)
const cx = (b: PixelBox) => (b.x0 + b.x1) / 2

export class SpreadPicker {
  readonly opts: SpreadPickOptions
  // Start on the left page of whatever is in view.
  #mode: Mode = 'left'
  #last: PixelBox | null = null
  #captured: PixelBox | null = null
  /** The second page of the current spread is being (or was) followed. */
  #onSecond = false
  /** Both pages of the spread (or the only page) have their ✓. */
  #done = false

  constructor(opts: Partial<SpreadPickOptions> = {}) {
    this.opts = { ...SPREAD_PICK_DEFAULTS, ...opts }
  }

  #inside(b: PixelBox, w: number, h: number): boolean {
    const mx = this.opts.edgeMargin * w
    const my = this.opts.edgeMargin * h
    return b.x0 >= mx && b.y0 >= my && b.x1 <= w - mx && b.y1 <= h - my
  }

  /**
   * Index of the candidate to use (candidates best first), or -1 when
   * there are none. Does not change state; call `commit` with the box
   * that was used.
   */
  choose(cands: readonly PageCandidate[], frameW: number, frameH: number): number {
    if (!cands.length) return -1
    const top = cands[0]!.confidence
    const ok = cands
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.confidence >= this.opts.minRelConf * top)
    if (this.#mode === 'left') {
      const inside = ok.filter(({ c }) => this.#inside(c.box, frameW, frameH))
      const pool = inside.length ? inside : ok
      return pool.reduce((a, b) => (cx(b.c.box) < cx(a.c.box) ? b : a)).i
    }
    if (this.#mode === 'other' && this.#captured) {
      const cap = this.#captured
      const other = ok.filter(
        ({ c }) =>
          boxIou(c.box, cap) <= this.opts.sameIou &&
          this.#inside(c.box, frameW, frameH) &&
          area(c.box) >= this.opts.minAreaRatio * area(cap),
      )
      if (other.length) return other[0]!.i
    }
    const last = this.#last
    if (last) {
      let best = -1
      let bestIou = this.opts.sameIou
      for (const { c, i } of ok) {
        const v = boxIou(c.box, last)
        if (v > bestIou) {
          bestIou = v
          best = i
        }
      }
      if (best >= 0) return best
    }
    return 0
  }

  /** The box of the candidate that was used this frame. */
  commit(box: PixelBox): void {
    if (this.#mode === 'other' && this.#captured) {
      // Moved to the other page, or there is none: either way the next ✓
      // finishes the spread.
      this.#onSecond = boxIou(box, this.#captured) <= this.opts.sameIou
      if (!this.#onSecond) this.#done = true
    }
    this.#mode = 'follow'
    this.#last = box
  }

  /** A ✓ on the page being followed (its current box). */
  onCaptured(): void {
    if (this.#onSecond) {
      this.#onSecond = false
      this.#done = true
      return
    }
    if (this.#done || !this.#last) return
    this.#captured = this.#last
    this.#mode = 'other'
  }

  /** The live judge started a new hold (the picture changed). */
  onNewHold(): void {
    if (!this.#done) return
    this.#done = false
    this.#captured = null
    this.#mode = 'left'
  }

  /** Box of the page being followed (null before the first frame). */
  get current(): PixelBox | null {
    return this.#last
  }

  /** True when the next frame should run the model (a page switch). */
  get wantsModel(): boolean {
    return this.#mode !== 'follow'
  }

  reset(): void {
    this.#mode = 'left'
    this.#last = null
    this.#captured = null
    this.#onSecond = false
    this.#done = false
  }
}
