/**
 * Browser port of `scripts/eval/lib/frame-quality.mjs`. Multi-signal
 * text-region scorer for best-frame selection.
 *
 * Replaces the whole-image Laplacian × confidence × area heuristic
 * with a text-region-aware score that correlates with OCR success.
 * See the Node version for design rationale.
 *
 * Pure-JS implementation (no OpenCV dependency in the browser hot
 * path) — uses Sobel-magnitude approximation for both Laplacian and
 * Tenengrad inside text bboxes.
 */

export interface ParagraphBbox {
  readonly box: readonly [number, number, number, number]
  readonly confidence?: number
}

export interface FrameQualityResult {
  readonly score: number
  readonly components: {
    readonly lapAvg?: number
    readonly tenAvg?: number
    readonly ocrConf?: number
    readonly glareFrac?: number
    readonly bboxCount?: number
    readonly areaFraction?: number
    readonly reason?: string
  }
}

const HIGHLIGHT_THRESHOLD = 245

interface GrayImage {
  data: Float32Array
  width: number
  height: number
}

function canvasToGray(canvas: HTMLCanvasElement): GrayImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Failed to create 2D context')
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  )
  const gray = new Float32Array(width * height)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
  }
  return { data: gray, width, height }
}

/** Laplacian variance inside [x1,y1,x2,y2] sub-window of gray. */
function lapVarianceInRegion(
  gray: GrayImage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  let sum = 0,
    sumSq = 0,
    n = 0
  const w = gray.width
  for (let y = Math.max(1, y1); y < Math.min(gray.height - 1, y2); y++) {
    for (let x = Math.max(1, x1); x < Math.min(w - 1, x2); x++) {
      const i = y * w + x
      const v =
        -4 * gray.data[i]! +
        gray.data[i - 1]! +
        gray.data[i + 1]! +
        gray.data[i - w]! +
        gray.data[i + w]!
      sum += v
      sumSq += v * v
      n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

function tenengradInRegion(
  gray: GrayImage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  let acc = 0,
    n = 0
  const w = gray.width
  for (let y = Math.max(1, y1); y < Math.min(gray.height - 1, y2); y++) {
    for (let x = Math.max(1, x1); x < Math.min(w - 1, x2); x++) {
      const i = y * w + x
      const gx =
        -gray.data[i - w - 1]! +
        gray.data[i - w + 1]! +
        -2 * gray.data[i - 1]! +
        2 * gray.data[i + 1]! +
        -gray.data[i + w - 1]! +
        gray.data[i + w + 1]!
      const gy =
        -gray.data[i - w - 1]! -
        2 * gray.data[i - w]! -
        gray.data[i - w + 1]! +
        gray.data[i + w - 1]! +
        2 * gray.data[i + w]! +
        gray.data[i + w + 1]!
      acc += gx * gx + gy * gy
      n++
    }
  }
  return n > 0 ? acc / n : 0
}

function glareCountInRegion(
  gray: GrayImage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { hits: number; total: number } {
  let hits = 0,
    total = 0
  const w = gray.width
  for (let y = Math.max(0, y1); y < Math.min(gray.height, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(w, x2); x++) {
      const v = gray.data[y * w + x]!
      if (v >= HIGHLIGHT_THRESHOLD) hits++
      total++
    }
  }
  return { hits, total }
}

export function scoreFrame(args: {
  canvas: HTMLCanvasElement
  paragraphs: readonly ParagraphBbox[]
  areaFraction?: number
}): FrameQualityResult {
  const { canvas, paragraphs, areaFraction } = args
  if (areaFraction != null && areaFraction < 0.05) {
    return { score: 0, components: { reason: 'tiny-card', areaFraction } }
  }
  if (!paragraphs || paragraphs.length === 0) {
    return { score: 0, components: { reason: 'no-text' } }
  }
  const gray = canvasToGray(canvas)
  let lapSum = 0,
    tenSum = 0,
    glareHits = 0,
    glareTotal = 0,
    bboxCount = 0
  for (const p of paragraphs) {
    const [x1, y1, x2, y2] = p.box
    const w = Math.round(x2 - x1)
    const h = Math.round(y2 - y1)
    if (w < 4 || h < 4) continue
    lapSum += lapVarianceInRegion(gray, x1, y1, x2, y2)
    tenSum += tenengradInRegion(gray, x1, y1, x2, y2)
    const g = glareCountInRegion(gray, x1, y1, x2, y2)
    glareHits += g.hits
    glareTotal += g.total
    bboxCount++
  }
  if (bboxCount === 0 || glareTotal === 0) {
    return { score: 0, components: { reason: 'no-valid-bbox' } }
  }
  const lapAvg = lapSum / bboxCount
  const tenAvg = tenSum / bboxCount
  const glareFrac = glareHits / glareTotal
  let ocrConfSum = 0,
    ocrConfCount = 0
  for (const p of paragraphs) {
    if (typeof p.confidence === 'number') {
      ocrConfSum += p.confidence
      ocrConfCount++
    }
  }
  const ocrConf = ocrConfCount > 0 ? ocrConfSum / ocrConfCount : 1.0
  const score =
    (lapAvg * 0.4 + tenAvg * 0.3) * ocrConf * Math.max(0.1, 1 - glareFrac)
  return {
    score,
    components: {
      lapAvg: Math.round(lapAvg),
      tenAvg: Math.round(tenAvg),
      ocrConf: Number(ocrConf.toFixed(3)),
      glareFrac: Number(glareFrac.toFixed(3)),
      bboxCount,
      areaFraction,
    },
  }
}
