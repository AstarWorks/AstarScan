/**
 * Post-warp refinement and content-aware false-positive filter.
 *
 * Browser-side port of `scripts/eval/lib/post-warp-refine.mjs`. Both
 * functions operate on the already-warped (1010×636 / 1200×1696 / …)
 * card canvas:
 *
 *   1. `isLikelyDocument(canvas)` — measures intensity variance and
 *      Canny edge density; rejects gray-frame / wood-texture false
 *      positives that sneak through DocAligner.
 *
 *   2. `refineCardEdges(canvas)` — scans the outer ~6 % of each side
 *      for the strongest Sobel-edge row/column and crops inward so the
 *      few-pixel background residue around DocAligner's quad is trimmed.
 *      The returned canvas is resized back to the original target dims.
 *
 * Implementation uses pure-JS image processing (Canny via simple
 * thresholding + Sobel via manual convolution) — keeps us off the
 * OpenCV.js hot path. Speeds: ~5-10 ms per call on a typical card.
 */

import { newCanvas, newCanvasLike } from './canvas-helpers'
// newCanvasLike kept available for callers needing same-dim canvases

// Phase 2d-A1: relaxed to keep low-contrast / thin-line cards.
const VARIANCE_MIN = 80
const EDGE_DENSITY_MIN = 0.002

const REFINE_MAX_STRIP_FRACTION = 0.06
const REFINE_MIN_LINE_STRENGTH = 0.35

export interface DocumentLikenessResult {
  readonly ok: boolean
  readonly reason?: 'low-variance' | 'low-edge-density'
  readonly variance: number
  readonly edgeDensity: number
}

export interface EdgeInset {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

export interface RefineResult {
  readonly canvas: HTMLCanvasElement
  readonly inset: EdgeInset
}

// ---- Helpers ---------------------------------------------------------------

interface GrayImage {
  data: Float32Array
  width: number
  height: number
}

function canvasToGray(canvas: HTMLCanvasElement): GrayImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Failed to create 2D context')
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const gray = new Float32Array(width * height)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
  }
  return { data: gray, width, height }
}

function meanAndVariance(gray: GrayImage): { mean: number; variance: number } {
  const n = gray.data.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += gray.data[i]!
  const mean = sum / n
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const d = gray.data[i]! - mean
    sumSq += d * d
  }
  return { mean, variance: sumSq / n }
}

/**
 * Approximate Canny edge density: Sobel magnitude > threshold counts.
 * Real Canny needs non-max suppression and hysteresis — for our coarse
 * "is there structure at all?" filter, raw Sobel magnitude is enough.
 */
function edgeDensity(gray: GrayImage): number {
  const { data, width, height } = gray
  const MAG_THRESHOLD = 50
  let edges = 0
  let total = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx =
        -data[i - width - 1]! + data[i - width + 1]! +
        -2 * data[i - 1]! + 2 * data[i + 1]! +
        -data[i + width - 1]! + data[i + width + 1]!
      const gy =
        -data[i - width - 1]! - 2 * data[i - width]! - data[i - width + 1]! +
        data[i + width - 1]! + 2 * data[i + width]! + data[i + width + 1]!
      const mag = Math.sqrt(gx * gx + gy * gy)
      if (mag > MAG_THRESHOLD) edges++
      total++
    }
  }
  return total > 0 ? edges / total : 0
}

export function isLikelyDocument(canvas: HTMLCanvasElement): DocumentLikenessResult {
  const gray = canvasToGray(canvas)
  const { variance } = meanAndVariance(gray)
  const density = edgeDensity(gray)
  if (variance < VARIANCE_MIN) {
    return { ok: false, reason: 'low-variance', variance, edgeDensity: density }
  }
  if (density < EDGE_DENSITY_MIN) {
    return { ok: false, reason: 'low-edge-density', variance, edgeDensity: density }
  }
  return { ok: true, variance, edgeDensity: density }
}

// ---- Edge refinement -------------------------------------------------------

function sobelHorizontal(gray: GrayImage): Float32Array {
  const { data, width, height } = gray
  const out = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gy =
        -data[i - width - 1]! - 2 * data[i - width]! - data[i - width + 1]! +
        data[i + width - 1]! + 2 * data[i + width]! + data[i + width + 1]!
      out[i] = gy
    }
  }
  return out
}

function sobelVertical(gray: GrayImage): Float32Array {
  const { data, width, height } = gray
  const out = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx =
        -data[i - width - 1]! + data[i - width + 1]! +
        -2 * data[i - 1]! + 2 * data[i + 1]! +
        -data[i + width - 1]! + data[i + width + 1]!
      out[i] = gx
    }
  }
  return out
}

function lineStrengthRow(sobelData: Float32Array, w: number, r: number): number {
  let strong = 0
  for (let c = 0; c < w; c++) {
    if (Math.abs(sobelData[r * w + c]!) > 64) strong++
  }
  return strong / w
}

function lineStrengthCol(
  sobelData: Float32Array,
  w: number,
  h: number,
  c: number,
): number {
  let strong = 0
  for (let r = 0; r < h; r++) {
    if (Math.abs(sobelData[r * w + c]!) > 64) strong++
  }
  return strong / h
}

function findEdgeInset(
  gray: GrayImage,
  side: 'top' | 'bottom' | 'left' | 'right',
): number {
  const { width: W, height: H } = gray
  const isHorizontal = side === 'top' || side === 'bottom'
  const stripMax = Math.floor((isHorizontal ? H : W) * REFINE_MAX_STRIP_FRACTION)
  if (stripMax < 2) return 0

  const sobel = isHorizontal ? sobelHorizontal(gray) : sobelVertical(gray)

  let bestInset = 0
  let bestScore = 0

  if (side === 'top') {
    for (let r = 1; r < stripMax; r++) {
      const score = lineStrengthRow(sobel, W, r)
      if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
        bestScore = score
        bestInset = r
      }
    }
  } else if (side === 'bottom') {
    for (let off = 1; off < stripMax; off++) {
      const r = H - 1 - off
      const score = lineStrengthRow(sobel, W, r)
      if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
        bestScore = score
        bestInset = off
      }
    }
  } else if (side === 'left') {
    for (let c = 1; c < stripMax; c++) {
      const score = lineStrengthCol(sobel, W, H, c)
      if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
        bestScore = score
        bestInset = c
      }
    }
  } else {
    for (let off = 1; off < stripMax; off++) {
      const c = W - 1 - off
      const score = lineStrengthCol(sobel, W, H, c)
      if (score > bestScore && score > REFINE_MIN_LINE_STRENGTH) {
        bestScore = score
        bestInset = off
      }
    }
  }
  return bestInset
}

export function refineCardEdges(canvas: HTMLCanvasElement): RefineResult {
  const gray = canvasToGray(canvas)
  const inset: EdgeInset = {
    top: findEdgeInset(gray, 'top'),
    bottom: findEdgeInset(gray, 'bottom'),
    left: findEdgeInset(gray, 'left'),
    right: findEdgeInset(gray, 'right'),
  }
  const W = canvas.width
  const H = canvas.height
  const newW = W - inset.left - inset.right
  const newH = H - inset.top - inset.bottom
  if (newW <= 0 || newH <= 0 || (inset.top === 0 && inset.bottom === 0 && inset.left === 0 && inset.right === 0)) {
    return { canvas, inset }
  }
  // CRITICAL: do NOT resize back to (W, H). Asymmetric insets would
  // stretch content non-uniformly and distort the card aspect.
  // Output at the cropped dims so the actual card proportions survive.
  const out = newCanvas(newW, newH)
  const ctx = out.getContext('2d')
  if (!ctx) return { canvas, inset }
  ctx.drawImage(canvas, inset.left, inset.top, newW, newH, 0, 0, newW, newH)
  return { canvas: out, inset }
}
