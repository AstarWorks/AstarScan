// @ts-nocheck — OpenCV.js global has no types in our globals.d.ts
/**
 * Paper-brightness document detector.
 *
 * The video this is calibrated against is handheld phone footage of white
 * A4 pages on a wooden desk — high contrast between paper (bright) and
 * background (dark). Edge-based detectors (Canny + approxPolyDP) choke on
 * hand occlusion of a paper corner, on the next page peeking in from the
 * edge of the frame, and on slightly curved paper edges: approxPolyDP
 * then reports 5, 6, or 7 vertices and we reject the frame.
 *
 * Brightness-based detection instead:
 *   1. Grayscale → Otsu threshold (paper becomes the "bright" class)
 *   2. Morphological close to fill hand / shadow gaps in the paper mask
 *   3. Pick the largest external contour
 *   4. `minAreaRect` → guaranteed rotated rectangle → 4 corners
 *
 * `minAreaRect` always returns a 4-vertex rotated rectangle regardless of
 * how irregular the contour is, which is what we want: even when the user's
 * finger occludes a corner, the rotated rectangle still approximates the
 * paper bounds closely enough for perspective warping.
 */

import type { Quad } from '@astarworks/scan-core'

const MIN_FRAME_FRACTION = 0.15
const MAX_FRAME_FRACTION = 0.97
const MORPH_KERNEL = 15

/**
 * Detect the 4 corners of the largest paper-like (bright) region in `frame`.
 * Returns null when the paper mask is too small, too large, or missing.
 */
export function detectDocumentQuad(frame: HTMLCanvasElement): Quad | null {
  const cv = (window as unknown as { cv?: unknown }).cv as any
  if (!cv?.imread) return null

  const src = cv.imread(frame)
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
}

/**
 * Compute the 4 corners of an OpenCV RotatedRect. We implement this by hand
 * because the OpenCV.js build shipped with AstarScan does not expose
 * `cv.boxPoints` (it is gated behind a build flag that's off by default on
 * the `/opencv.js` we serve).
 *
 * RotatedRect fields: `center {x, y}`, `size {width, height}`, `angle` (deg).
 * The corners are the 4 points of the axis-aligned (w, h) rectangle
 * centered at origin, rotated by `angle` around the origin, then translated
 * to `center`.
 */
function rotatedRectCorners(
  rect: {
    center: { x: number; y: number }
    size: { width: number; height: number }
    angle: number
  },
): Array<{ x: number; y: number }> {
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

/**
 * Sort 4 raw rectangle vertices into tl / tr / br / bl.
 * Top-left has the smallest x+y, bottom-right the largest;
 * top-right has the smallest y-x, bottom-left the largest.
 */
function orderQuadCorners(pts: Array<{ x: number; y: number }>): Quad {
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
