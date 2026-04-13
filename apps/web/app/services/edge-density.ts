/**
 * Edge density measurement for document vs. background classification.
 *
 * Documents (text, diagrams, tables) have high edge density.
 * Desk surfaces, hands, and transition frames have low edge density.
 *
 * Uses a Sobel-like gradient magnitude on a downscaled grayscale frame,
 * then counts the fraction of pixels above a threshold. Pure Canvas2D,
 * no OpenCV needed.
 *
 * Calibrated on Python pipeline: EDGE_THRESHOLD = 0.03 (3% of pixels
 * have strong edges → document). Below this → desk/background.
 */

const ANALYSIS_WIDTH = 320

/**
 * Measure the fraction of pixels with strong edges in a canvas.
 * Returns a value in [0, 1] where 0 = no edges, 1 = all edges.
 */
export function measureEdgeDensity(source: HTMLCanvasElement): number {
  // Downscale to fixed width for consistent results
  const aspect = source.height / source.width
  const w = ANALYSIS_WIDTH
  const h = Math.round(ANALYSIS_WIDTH * aspect)

  const work = document.createElement('canvas')
  work.width = w
  work.height = h
  const ctx = work.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 0

  ctx.drawImage(source, 0, 0, w, h)
  const imageData = ctx.getImageData(0, 0, w, h)
  const pixels = imageData.data

  // Convert to grayscale
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(
      0.299 * pixels[i * 4]! +
        0.587 * pixels[i * 4 + 1]! +
        0.114 * pixels[i * 4 + 2]!,
    )
  }

  // Sobel gradient magnitude (simplified: horizontal + vertical)
  // Edge threshold: gradient > 50 counts as "edge pixel"
  const EDGE_PIXEL_THRESHOLD = 50
  let edgeCount = 0

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      // Horizontal gradient (Sobel Gx)
      const gx =
        -gray[(y - 1) * w + (x - 1)]! +
        gray[(y - 1) * w + (x + 1)]! +
        -2 * gray[y * w + (x - 1)]! +
        2 * gray[y * w + (x + 1)]! +
        -gray[(y + 1) * w + (x - 1)]! +
        gray[(y + 1) * w + (x + 1)]!

      // Vertical gradient (Sobel Gy)
      const gy =
        -gray[(y - 1) * w + (x - 1)]! +
        -2 * gray[(y - 1) * w + x]! +
        -gray[(y - 1) * w + (x + 1)]! +
        gray[(y + 1) * w + (x - 1)]! +
        2 * gray[(y + 1) * w + x]! +
        gray[(y + 1) * w + (x + 1)]!

      const magnitude = Math.sqrt(gx * gx + gy * gy)
      if (magnitude > EDGE_PIXEL_THRESHOLD) edgeCount++
    }
  }

  return edgeCount / ((w - 2) * (h - 2))
}
