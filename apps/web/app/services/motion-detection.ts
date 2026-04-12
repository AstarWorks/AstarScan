/**
 * Frame-difference motion detector.
 *
 * Used by the video capture loop to decide when the scene is "stable
 * enough" to auto-capture. The detector stores the previous sampled
 * frame (downscaled grayscale) and, on each `sample()`, computes the
 * mean absolute per-pixel difference against it. Low values mean the
 * camera and the subject have stopped moving; high values mean the
 * user is turning a page, panning, or shaking the phone.
 *
 * Two thresholds are exposed so the capture state machine can apply
 * hysteresis and avoid flip-flopping between states on marginal noise:
 *
 *   - `STABILITY_THRESHOLD` (2.5) — below this, the frame is considered
 *     stable and the "stability timer" can accumulate. Anything higher
 *     resets the timer.
 *   - `MOTION_RESET_THRESHOLD` (6.0) — above this, we treat it as
 *     definite camera motion. Used to reset the post-capture cooldown
 *     so the next stable period can arm a new auto-capture.
 *
 * Values were picked empirically against a 640×480 preview on a Pixel
 * 8 and an iPhone 14: idle camera drifts around 0.5-1.5, a steady hand
 * holding the phone stays under 2, deliberate page turns peak above 8.
 *
 * Implementation notes:
 * - Work resolution is 64×48 (3072 pixels). Small enough that a single
 *   sample runs in well under 1ms and large enough to capture enough
 *   spatial detail for reliable diffs.
 * - Grayscale via Rec. 709 luminance (matches blur-detection.ts).
 * - First sample after `reset()` returns `Infinity` ("conservative
 *   moving"), which prevents the caller from treating the initial
 *   state as stable.
 */

const WORK_WIDTH = 64
const WORK_HEIGHT = 48
const PIXEL_COUNT = WORK_WIDTH * WORK_HEIGHT

/** Mean absolute diff below this → current frame is "stable". */
export const STABILITY_THRESHOLD = 2.5

/** Mean absolute diff above this → definite motion (clears cooldown). */
export const MOTION_RESET_THRESHOLD = 6.0

export class MotionDetector {
  #previousGray: Float64Array | null = null
  #workCanvas: HTMLCanvasElement

  constructor() {
    this.#workCanvas = document.createElement('canvas')
    this.#workCanvas.width = WORK_WIDTH
    this.#workCanvas.height = WORK_HEIGHT
  }

  /**
   * Sample the current frame and return the mean absolute difference
   * against the previous sample. Higher = more motion.
   *
   * Returns `Infinity` on the first call after construction / `reset()`
   * so callers can treat "no history" as "motion happened" without a
   * special case.
   */
  sample(source: HTMLCanvasElement | HTMLVideoElement): number {
    const ctx = this.#workCanvas.getContext('2d', {
      willReadFrequently: true,
    })
    if (!ctx) return Number.POSITIVE_INFINITY

    try {
      ctx.drawImage(source, 0, 0, WORK_WIDTH, WORK_HEIGHT)
    } catch {
      // Can happen if the video element isn't ready yet — treat as motion.
      return Number.POSITIVE_INFINITY
    }
    const imageData = ctx.getImageData(0, 0, WORK_WIDTH, WORK_HEIGHT)
    const pixels = imageData.data

    const gray = new Float64Array(PIXEL_COUNT)
    for (let i = 0, j = 0; j < PIXEL_COUNT; i += 4, j += 1) {
      const r = pixels[i] ?? 0
      const g = pixels[i + 1] ?? 0
      const b = pixels[i + 2] ?? 0
      gray[j] = 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    const previous = this.#previousGray
    if (!previous) {
      this.#previousGray = gray
      return Number.POSITIVE_INFINITY
    }

    let sum = 0
    for (let i = 0; i < PIXEL_COUNT; i += 1) {
      sum += Math.abs((gray[i] ?? 0) - (previous[i] ?? 0))
    }
    this.#previousGray = gray
    return sum / PIXEL_COUNT
  }

  /** Forget the previous frame so the next `sample()` returns `Infinity`. */
  reset(): void {
    this.#previousGray = null
  }
}
