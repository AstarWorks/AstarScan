/**
 * `JscanifyBackend` — concrete `EdgeDetectorBackend` backed by the jscanify
 * library (classical CV: OpenCV Canny + largest-quadrilateral contour).
 *
 * This is the only file in the monorepo that is allowed to `import` from
 * the `jscanify` package. Every other caller (page, services, tests) must
 * go through the `EdgeDetectorBackend` interface from `@astarworks/scan-core`,
 * which keeps the door open for `DocAlignerBackend` (ONNX Runtime Web) and
 * `MlKitBackend` (native Tauri) without touching the app code.
 *
 * Detection boundary contract: `detect()` takes the live preview canvas
 * directly and returns a plain-object `Quad`. OpenCV `cv.Mat` objects are
 * allocated and freed inside this file — nothing OpenCV-typed crosses the
 * public surface.
 *
 * `perspective-warper.ts` has been rewritten to use OpenCV.js directly
 * (no jscanify dependency), so this file now only exports the
 * `JscanifyBackend` class — no warp function.
 */

import type { EdgeDetectorBackend, Quad } from '@astarworks/scan-core'
import type { default as JscanifyCtor, JscanifyCornerPoints } from 'jscanify'

import { loadOpenCV } from './opencv-loader'

type JscanifyInstance = InstanceType<typeof JscanifyCtor>

/**
 * Filters jscanify's fallback behavior: if the "detected" quad covers
 * almost the entire frame, it's almost certainly the image bounds returned
 * as a miss, not a real paper contour. Similarly, detections covering
 * less than a few percent of the frame are almost certainly noise.
 */
const MAX_FRAME_FRACTION = 0.98
const MIN_FRAME_FRACTION = 0.05

export class JscanifyBackend implements EdgeDetectorBackend {
  readonly name = 'jscanify'

  #scanner: JscanifyInstance | null = null
  #ready = false

  get ready(): boolean {
    return this.#ready
  }

  async warmUp(): Promise<void> {
    if (this.#ready && this.#scanner) return
    await loadOpenCV()
    // Dynamic import so the jscanify bundle is only fetched once the
    // user actually tries to scan, not on every page load.
    const mod = await import('jscanify')
    this.#scanner = new mod.default()
    this.#ready = true
  }

  async detect(frame: HTMLCanvasElement): Promise<Quad | null> {
    const scanner = this.#scanner
    if (!scanner || !this.#ready) {
      throw new Error('JscanifyBackend.warmUp() must be called before detect()')
    }
    const cv = window.cv
    if (!cv?.imread) {
      throw new Error('OpenCV.js runtime is not initialized')
    }

    let img: OpenCvMat | null = null
    let contour: OpenCvMat | null = null
    try {
      img = cv.imread(frame)
      contour = scanner.findPaperContour(img)
      if (!contour) return null

      const corners = scanner.getCornerPoints(contour, img)
      if (!isPlausibleQuad(corners, frame.width, frame.height)) {
        return null
      }
      return cornerPointsToQuad(corners)
    } catch {
      // Any thrown error from jscanify / OpenCV is treated as "no
      // detection this frame" — the caller retries on the next tick.
      return null
    } finally {
      safeDelete(img)
      safeDelete(contour)
    }
  }

  dispose(): void {
    this.#scanner = null
    this.#ready = false
  }
}

function safeDelete(mat: OpenCvMat | null): void {
  if (mat && typeof mat.delete === 'function') {
    try {
      mat.delete()
    } catch {
      // `delete()` throwing during cleanup is not recoverable and
      // not actionable by the caller — swallow and move on.
    }
  }
}

function cornerPointsToQuad(corners: JscanifyCornerPoints): Quad {
  return {
    tl: { x: corners.topLeftCorner.x, y: corners.topLeftCorner.y },
    tr: { x: corners.topRightCorner.x, y: corners.topRightCorner.y },
    br: { x: corners.bottomRightCorner.x, y: corners.bottomRightCorner.y },
    bl: { x: corners.bottomLeftCorner.x, y: corners.bottomLeftCorner.y },
  }
}

/**
 * Sanity check against jscanify's "return image bounds on detection miss"
 * behavior. Rejects detections that are either the whole frame or
 * impossibly small.
 */
function isPlausibleQuad(
  corners: JscanifyCornerPoints,
  frameWidth: number,
  frameHeight: number,
): boolean {
  const frameArea = frameWidth * frameHeight
  if (frameArea <= 0) return false
  const area = shoelaceArea(corners)
  const fraction = area / frameArea
  return fraction > MIN_FRAME_FRACTION && fraction < MAX_FRAME_FRACTION
}

function shoelaceArea(corners: JscanifyCornerPoints): number {
  const a = corners.topLeftCorner
  const b = corners.topRightCorner
  const c = corners.bottomRightCorner
  const d = corners.bottomLeftCorner
  return (
    Math.abs(
      a.x * b.y -
        b.x * a.y +
        (b.x * c.y - c.x * b.y) +
        (c.x * d.y - d.x * c.y) +
        (d.x * a.y - a.x * d.y),
    ) / 2
  )
}
