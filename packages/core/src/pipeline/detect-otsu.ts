/**
 * Classical OpenCV document detection: Otsu threshold → morphology →
 * largest contour → minAreaRect. FALLBACK ONLY — used when the YOLO model
 * fails to load. Known failure mode: grabs the whole frame / desk instead
 * of the page on busy backgrounds (measured 50 % full-frame quads on
 * mp4-2), which is why YOLO-pose is the primary detector.
 */

import type { Point, Quad } from '../types.js'
import type { CanvasLike, CvRotatedRect, PipelineDeps } from './deps.js'
import { matFromCanvas } from './cv-canvas.js'
import {
  MAX_FRAME_FRACTION,
  MIN_FRAME_FRACTION,
  MORPH_KERNEL,
} from './constants.js'

export function rotatedRectCorners(rect: CvRotatedRect): Point[] {
  const cx = rect.center.x
  const cy = rect.center.y
  const halfW = rect.size.width / 2
  const halfH = rect.size.height / 2
  const rad = (rect.angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const local: Array<[number, number]> = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ]
  return local.map(([dx, dy]) => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  }))
}

export function orderQuadCorners(pts: readonly Point[]): Quad {
  let tl = pts[0]!
  let tr = pts[0]!
  let br = pts[0]!
  let bl = pts[0]!
  let minSum = Infinity
  let maxSum = -Infinity
  let minDiff = Infinity
  let maxDiff = -Infinity
  for (const p of pts) {
    const s = p.x + p.y
    const d = p.y - p.x
    if (s < minSum) {
      minSum = s
      tl = p
    }
    if (s > maxSum) {
      maxSum = s
      br = p
    }
    if (d < minDiff) {
      minDiff = d
      tr = p
    }
    if (d > maxDiff) {
      maxDiff = d
      bl = p
    }
  }
  return { tl, tr, br, bl }
}

export interface OtsuDetectorOps {
  /** Largest plausible document quad, or null. Confidence is always 1.0
   *  for this detector — it has no learned score. */
  detectWithOpenCV(frame: CanvasLike): Quad | null
}

export function createOtsuDetector({ cv }: PipelineDeps): OtsuDetectorOps {
  return {
    detectWithOpenCV(frame) {
      const src = matFromCanvas(cv, frame)
      const gray = new cv.Mat()
      const binary = new cv.Mat()
      const contours = new cv.MatVector()
      const hierarchy = new cv.Mat()
      const kernel = cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(MORPH_KERNEL, MORPH_KERNEL),
      )
      try {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
        cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)
        cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel)
        cv.morphologyEx(binary, binary, cv.MORPH_OPEN, kernel)
        cv.findContours(
          binary,
          contours,
          hierarchy,
          cv.RETR_EXTERNAL,
          cv.CHAIN_APPROX_SIMPLE,
        )
        const frameArea = frame.width * frame.height
        const minArea = frameArea * MIN_FRAME_FRACTION
        const maxArea = frameArea * MAX_FRAME_FRACTION
        let bestIdx = -1
        let bestArea = 0
        for (let i = 0; i < contours.size(); i += 1) {
          const c = contours.get(i)
          const area = cv.contourArea(c)
          if (area > bestArea && area >= minArea && area <= maxArea) {
            bestArea = area
            bestIdx = i
          }
          c.delete()
        }
        if (bestIdx < 0) return null
        const bestContour = contours.get(bestIdx)
        const rect = cv.minAreaRect(bestContour)
        bestContour.delete()
        return orderQuadCorners(rotatedRectCorners(rect))
      } finally {
        src.delete()
        gray.delete()
        binary.delete()
        contours.delete()
        hierarchy.delete()
        kernel.delete()
      }
    },
  }
}
