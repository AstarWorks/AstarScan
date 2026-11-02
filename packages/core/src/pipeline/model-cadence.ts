/**
 * When to run the corner model, and what to reuse in between.
 *
 * The YOLOv8n-pose model costs ~500 ms per frame in single-thread WASM
 * (measured in headless Chromium, ~75 % of a frame), which held the live
 * scan at 1.1–1.4 sampled frames per second — far below the 5–10 fps the
 * live-capture timings (`holdS`, `changeS`, `leaveS`) assume, so a page
 * held for 1.5 s got two samples and a page turn often none.
 *
 * Between model runs the page barely moves, so the corners are found by
 * the paper-edge snap alone (`corner-refine.ts`, ~5× cheaper) inside the
 * last model box. The model runs again every `modelEvery` frames, when
 * the snap fails, or when the frame size changes.
 *
 * Pure: no DOM, no OpenCV, no model.
 */

import type { Quad } from '../types.js'
import type { PixelBox } from './yolo-decode.js'

export const MODEL_CADENCE_DEFAULTS = {
  /** Run the model on at least every this-many-th frame. */
  modelEvery: 4,
} as const

export type ModelCadenceOptions = {
  -readonly [K in keyof typeof MODEL_CADENCE_DEFAULTS]: number
}

/** What the last model run found, reused by the frames in between. */
export interface ModelAnchor {
  /** Model box in frame pixels (the snap searches around it). */
  box: PixelBox
  /** Corners used for the snap's plausibility check (its centre). */
  quad: Quad
  /** Model class confidence, carried over to the snapped frames. */
  confidence: number
  frameW: number
  frameH: number
}

export class ModelCadence {
  readonly opts: ModelCadenceOptions
  #anchor: ModelAnchor | null = null
  #sinceModel = 0

  constructor(opts: Partial<ModelCadenceOptions> = {}) {
    this.opts = { ...MODEL_CADENCE_DEFAULTS, ...opts }
  }

  /**
   * The anchor to snap this frame against, or null when the model must
   * run (no anchor, frame size changed, or `modelEvery` reached).
   */
  anchorFor(frameW: number, frameH: number): ModelAnchor | null {
    const a = this.#anchor
    if (!a || a.frameW !== frameW || a.frameH !== frameH) return null
    if (this.#sinceModel + 1 >= Math.max(1, this.opts.modelEvery)) return null
    return a
  }

  /** The model ran: keep its result (null = nothing found). */
  modelRan(anchor: ModelAnchor | null): void {
    this.#anchor = anchor
    this.#sinceModel = 0
  }

  /** A frame was handled by the snap alone. */
  snapped(quad: Quad): void {
    this.#sinceModel += 1
    // The plausibility check wants the page centre inside the snapped
    // quad; follow the page so slow drift between model runs is kept.
    if (this.#anchor) this.#anchor = { ...this.#anchor, quad }
  }

  /** The snap failed on an anchored frame: the model must run next. */
  lost(): void {
    this.#anchor = null
  }

  reset(): void {
    this.#anchor = null
    this.#sinceModel = 0
  }
}
