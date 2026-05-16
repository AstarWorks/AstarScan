/**
 * Post-warp refinement and content-aware false-positive filter.
 *
 * Two passes run on the already-warped 1010×636 (or 1200×1696, …) image:
 *
 *   1. `isLikelyDocument(canvas)` — quickly rejects images that are NOT a
 *      document at all. DocAligner sometimes locks onto a gray-out frame
 *      from a video transition, or a piece of wood-grain desk that
 *      happens to have a card-like aspect. Those reach `warpPerspective`
 *      and pollute the winners. We measure:
 *        - intensity variance of the gray image (low → solid color)
 *        - Canny edge-pixel density (low → no text / no structure)
 *
 *   2. `refineCardEdges(canvas)` — DocAligner returns 4 corners with a
 *      few-pixel error margin so the warped image often has a thin strip
 *      of background pixels at the outer edges. We scan the outer 5% of
 *      each side for a strong straight edge (Sobel) and crop inward to
 *      that line, then resize back to the target dimensions.
 *
 * Both functions take and return @napi-rs/canvas Canvas (HTMLCanvasElement-
 * compatible), so they slot into the existing pipeline without changing
 * the interface.
 */

import '../pipeline.mjs' // side effect: patches cv.imread / cv.imshow for Node
import { cv } from '../cv-shim.mjs'
import { newCanvas } from '../canvas-utils.mjs'

// ---- FP filter -------------------------------------------------------------

const VARIANCE_MIN = 200    // gray solid frames sit around 50-150
const EDGE_DENSITY_MIN = 0.005 // wood texture is < 0.003; cards are 0.01-0.05

/**
 * Reject obvious non-documents. Returns
 *   { ok: boolean, reason?: string, variance: number, edgeDensity: number }
 */
export function isLikelyDocument(canvas) {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const edges = new cv.Mat()
  const mean = new cv.Mat()
  const stddev = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.meanStdDev(gray, mean, stddev)
    const sd = stddev.data64F[0] ?? 0
    const variance = sd * sd

    cv.Canny(gray, edges, 50, 150)
    let nonZero = 0
    const data = edges.data
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0) nonZero++
    }
    const edgeDensity = nonZero / data.length

    if (variance < VARIANCE_MIN) {
      return { ok: false, reason: 'low-variance', variance, edgeDensity }
    }
    if (edgeDensity < EDGE_DENSITY_MIN) {
      return { ok: false, reason: 'low-edge-density', variance, edgeDensity }
    }
    return { ok: true, variance, edgeDensity }
  } finally {
    src.delete()
    gray.delete()
    edges.delete()
    mean.delete()
    stddev.delete()
  }
}

// ---- Edge refinement -------------------------------------------------------

const REFINE_MAX_STRIP_FRACTION = 0.06 // search up to 6 % of each side
const REFINE_MIN_LINE_STRENGTH = 0.35   // fraction of strip-width pixels that must be an edge

/**
 * Find the row (for top/bottom) or column (for left/right) with the
 * strongest straight edge within an outer strip. Returns the inset (in
 * pixels) from the original border. 0 means "no clear inner edge found,
 * keep as-is".
 */
function findEdgeInset(grayMat, side) {
  const W = grayMat.cols
  const H = grayMat.rows
  const isHorizontal = side === 'top' || side === 'bottom'
  const stripMax = Math.floor(
    (isHorizontal ? H : W) * REFINE_MAX_STRIP_FRACTION,
  )
  if (stripMax < 2) return 0

  const sobel = new cv.Mat()
  try {
    if (isHorizontal) {
      cv.Sobel(grayMat, sobel, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT)
    } else {
      cv.Sobel(grayMat, sobel, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT)
    }
    const data = sobel.data32F

    let bestInset = 0
    let bestScore = 0
    if (side === 'top') {
      for (let r = 1; r < stripMax; r++) {
        const score = lineStrengthRow(data, W, r)
        if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
          bestScore = score
          bestInset = r
        }
      }
    } else if (side === 'bottom') {
      for (let off = 1; off < stripMax; off++) {
        const r = H - 1 - off
        const score = lineStrengthRow(data, W, r)
        if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
          bestScore = score
          bestInset = off
        }
      }
    } else if (side === 'left') {
      for (let c = 1; c < stripMax; c++) {
        const score = lineStrengthCol(data, W, H, c)
        if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
          bestScore = score
          bestInset = c
        }
      }
    } else {
      // right
      for (let off = 1; off < stripMax; off++) {
        const c = W - 1 - off
        const score = lineStrengthCol(data, W, H, c)
        if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
          bestScore = score
          bestInset = off
        }
      }
    }
    return bestInset
  } finally {
    sobel.delete()
  }
}

function lineStrengthRow(sobelData, w, r) {
  let strong = 0
  for (let c = 0; c < w; c++) {
    if (Math.abs(sobelData[r * w + c]) > 64) strong++
  }
  return strong / w
}

function lineStrengthCol(sobelData, w, h, c) {
  let strong = 0
  for (let r = 0; r < h; r++) {
    if (Math.abs(sobelData[r * w + c]) > 64) strong++
  }
  return strong / h
}

/**
 * Trim the outer few pixels of background from a warped card image.
 *
 * Returns an OBJECT { canvas, inset: { top, bottom, left, right } } so
 * callers can log how much was trimmed.
 */
export function refineCardEdges(canvas) {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    const inset = {
      top: findEdgeInset(gray, 'top'),
      bottom: findEdgeInset(gray, 'bottom'),
      left: findEdgeInset(gray, 'left'),
      right: findEdgeInset(gray, 'right'),
    }
    const W = src.cols
    const H = src.rows
    const newX = inset.left
    const newY = inset.top
    const newW = W - inset.left - inset.right
    const newH = H - inset.top - inset.bottom
    if (newW <= 0 || newH <= 0 || (newW === W && newH === H)) {
      return { canvas, inset }
    }
    const rect = new cv.Rect(newX, newY, newW, newH)
    const cropped = src.roi(rect)
    const resized = new cv.Mat()
    try {
      cv.resize(cropped, resized, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR)
      const out = newCanvas(W, H)
      cv.imshow(out, resized)
      return { canvas: out, inset }
    } finally {
      cropped.delete()
      resized.delete()
    }
  } finally {
    src.delete()
    gray.delete()
  }
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { jpegToCanvas, canvasToJpegBuffer } = await import('../canvas-utils.mjs')
  const imagePath = process.argv[2] ?? '/tmp/winner-021-test.jpg'
  const buf = fs.readFileSync(imagePath)
  const src = await jpegToCanvas(buf)

  const fp = isLikelyDocument(src)
  console.log('isLikelyDocument:', fp)

  const refined = refineCardEdges(src)
  console.log('refineCardEdges inset:', refined.inset)
  const outPath = imagePath.replace(/\.jpg$/, '-refined.jpg')
  fs.writeFileSync(outPath, canvasToJpegBuffer(refined.canvas, 90))
  console.log('saved', outPath)
}
