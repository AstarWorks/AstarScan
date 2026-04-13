/**
 * SSIM-based page deduplication.
 *
 * Computes the Structural Similarity Index (SSIM) between two page images
 * using 128×128 grayscale thumbnails. Pure Canvas2D — no OpenCV or WASM.
 *
 * Used as a real-time gate during auto-capture: if a newly captured page
 * is too similar to any existing page, it's silently dropped as a duplicate.
 *
 * The SSIM formula:
 *   SSIM(x,y) = (2·μx·μy + C1)(2·σxy + C2) / ((μx² + μy²+ C1)(σx² + σy² + C2))
 *
 * where C1 = (0.01·255)² = 6.5025, C2 = (0.03·255)² = 58.5225
 *
 * Threshold: SSIM > 0.81 (distance < 0.19) → duplicate.
 * Calibrated on the AstarScan eval set (2 videos, 21 pages, total error 0-1).
 */

/** Compare two images at this resolution. Low enough to be fast (~1ms),
 *  high enough to distinguish different document pages. */
const THUMB_SIZE = 128

/** SSIM above this means "same page". Calibrated on eval set:
 *  0.70 at 1s sampling = 11/11 on test video (43s, 11 pages). */
export const SSIM_DUPLICATE_THRESHOLD = 0.7

// SSIM constants (Wang et al., 2004)
const C1 = 6.5025 // (0.01 * 255)²
const C2 = 58.5225 // (0.03 * 255)²

/**
 * Extract a 128×128 grayscale Uint8Array from an image source.
 * Reuses a single off-screen canvas to avoid GC churn during capture bursts.
 */
let thumbCanvas: HTMLCanvasElement | null = null

function getThumbCanvas(): { ctx: CanvasRenderingContext2D } {
  if (!thumbCanvas) {
    thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = THUMB_SIZE
    thumbCanvas.height = THUMB_SIZE
  }
  const ctx = thumbCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Failed to create thumb canvas context')
  return { ctx }
}

export function extractGrayscale(
  source: HTMLCanvasElement | HTMLImageElement | string,
): Float64Array {
  const { ctx } = getThumbCanvas()
  ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE)

  if (typeof source === 'string') {
    // dataUrl — need to load synchronously via already-cached image
    // For real-time use, prefer passing canvas/image directly.
    // Fallback: create a temp canvas from data URL. This path is only
    // used for comparing against already-captured pages from IndexedDB.
    throw new Error(
      'extractGrayscale from dataUrl is async — use extractGrayscaleFromUrl instead',
    )
  }

  ctx.drawImage(source, 0, 0, THUMB_SIZE, THUMB_SIZE)
  const rgba = ctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data
  const gray = new Float64Array(THUMB_SIZE * THUMB_SIZE)
  for (let i = 0; i < gray.length; i++) {
    // ITU-R BT.601 luminance
    gray[i] =
      0.299 * (rgba[i * 4] ?? 0) +
      0.587 * (rgba[i * 4 + 1] ?? 0) +
      0.114 * (rgba[i * 4 + 2] ?? 0)
  }
  return gray
}

/**
 * Async version: load a data URL into an Image, then extract grayscale.
 * Used for comparing against already-captured pages whose only representation
 * is a JPEG data URL.
 */
export async function extractGrayscaleFromUrl(
  dataUrl: string,
): Promise<Float64Array> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Failed to load image for SSIM'))
    el.src = dataUrl
  })
  const { ctx } = getThumbCanvas()
  ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE)
  ctx.drawImage(img, 0, 0, THUMB_SIZE, THUMB_SIZE)
  const rgba = ctx.getImageData(0, 0, THUMB_SIZE, THUMB_SIZE).data
  const gray = new Float64Array(THUMB_SIZE * THUMB_SIZE)
  for (let i = 0; i < gray.length; i++) {
    gray[i] =
      0.299 * (rgba[i * 4] ?? 0) +
      0.587 * (rgba[i * 4 + 1] ?? 0) +
      0.114 * (rgba[i * 4 + 2] ?? 0)
  }
  return gray
}

/**
 * Compute SSIM between two grayscale thumbnails (both Float64Array of
 * length THUMB_SIZE²). Returns a value in [-1, 1] where 1 = identical.
 *
 * ~0.3ms for 128×128 on a modern phone — negligible compared to detection.
 */
export function computeSsim(g1: Float64Array, g2: Float64Array): number {
  const n = g1.length

  let sum1 = 0
  let sum2 = 0
  for (let i = 0; i < n; i++) {
    sum1 += g1[i]!
    sum2 += g2[i]!
  }
  const mu1 = sum1 / n
  const mu2 = sum2 / n

  let var1 = 0
  let var2 = 0
  let cov = 0
  for (let i = 0; i < n; i++) {
    const d1 = g1[i]! - mu1
    const d2 = g2[i]! - mu2
    var1 += d1 * d1
    var2 += d2 * d2
    cov += d1 * d2
  }
  var1 /= n
  var2 /= n
  cov /= n

  const numerator = (2 * mu1 * mu2 + C1) * (2 * cov + C2)
  const denominator = (mu1 * mu1 + mu2 * mu2 + C1) * (var1 + var2 + C2)

  return numerator / denominator
}

/**
 * Dedup manager: maintains grayscale thumbnails for all captured pages and
 * provides O(n) duplicate checking for each new capture.
 */
export class SsimDedupManager {
  /** Grayscale thumbnails of all accepted pages, in capture order. */
  private readonly thumbnails: Float64Array[] = []
  /** Page IDs, parallel to thumbnails. */
  private readonly pageIds: string[] = []

  /**
   * Check if a newly captured page is a duplicate of any existing page.
   * Returns the matching page ID and SSIM score if duplicate, null otherwise.
   */
  isDuplicate(
    newGray: Float64Array,
    threshold = SSIM_DUPLICATE_THRESHOLD,
  ): { pageId: string; ssim: number } | null {
    let bestSsim = -1
    let bestId: string | null = null

    for (let i = 0; i < this.thumbnails.length; i++) {
      const ssim = computeSsim(newGray, this.thumbnails[i]!)
      if (ssim > bestSsim) {
        bestSsim = ssim
        bestId = this.pageIds[i]!
      }
    }

    return bestSsim > threshold && bestId
      ? { pageId: bestId, ssim: bestSsim }
      : null
  }

  /** Register a newly accepted page. */
  addPage(id: string, gray: Float64Array): void {
    this.pageIds.push(id)
    this.thumbnails.push(gray)
  }

  /** Update the grayscale thumbnail for a page (best-frame replacement). */
  updatePage(id: string, gray: Float64Array): void {
    const idx = this.pageIds.indexOf(id)
    if (idx >= 0) this.thumbnails[idx] = gray
  }

  /** Remove a page (when user deletes it). */
  removePage(id: string): void {
    const idx = this.pageIds.indexOf(id)
    if (idx >= 0) {
      this.pageIds.splice(idx, 1)
      this.thumbnails.splice(idx, 1)
    }
  }

  /** Reset (session clear). */
  clear(): void {
    this.pageIds.length = 0
    this.thumbnails.length = 0
  }

  get size(): number {
    return this.pageIds.length
  }
}
