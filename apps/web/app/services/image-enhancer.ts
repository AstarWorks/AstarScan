/**
 * Document image enhancement pipeline for raw (non-warped) frames.
 *
 * When edge detection fails (document fills the frame), raw video frames
 * need post-processing to become usable documents:
 * 1. Auto-crop: find the bright rectangular region (paper) and trim background
 * 2. CLAHE contrast enhancement: improve readability in dark/uneven lighting
 * 3. A4 normalization: resize to 1200×1600 (3:4 ratio) with white padding
 *
 * All operations use OpenCV.js (already loaded for edge detection).
 */

// OpenCV.js types (minimal subset needed here)
declare const cv: {
  imread(canvas: HTMLCanvasElement): CvMat
  imshow(canvas: HTMLCanvasElement, mat: CvMat): void
  cvtColor(src: CvMat, dst: CvMat, code: number): void
  threshold(
    src: CvMat,
    dst: CvMat,
    thresh: number,
    maxval: number,
    type: number,
  ): number
  morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void
  getStructuringElement(
    shape: number,
    ksize: { width: number; height: number },
  ): CvMat
  findContours(
    src: CvMat,
    contours: CvMatVector,
    hierarchy: CvMat,
    mode: number,
    method: number,
  ): void
  contourArea(contour: CvMat): number
  boundingRect(contour: CvMat): {
    x: number
    y: number
    width: number
    height: number
  }
  createCLAHE(
    clipLimit: number,
    tileGridSize: { width: number; height: number },
  ): CvCLAHE
  Mat: new () => CvMat
  MatVector: new () => CvMatVector
  Size: new (w: number, h: number) => { width: number; height: number }
  COLOR_RGBA2GRAY: number
  COLOR_RGBA2BGR: number
  COLOR_BGR2LAB: number
  COLOR_LAB2BGR: number
  COLOR_BGR2RGBA: number
  THRESH_BINARY: number
  THRESH_OTSU: number
  MORPH_CLOSE: number
  MORPH_OPEN: number
  MORPH_RECT: number
  RETR_EXTERNAL: number
  CHAIN_APPROX_SIMPLE: number
}

interface CvMat {
  rows: number
  cols: number
  data: Uint8Array
  delete(): void
}
interface CvMatVector {
  size(): number
  get(i: number): CvMat
  delete(): void
}
interface CvCLAHE {
  apply(src: CvMat, dst: CvMat): void
  delete(): void
}

const TARGET_W = 1200
const TARGET_H = 1600

/**
 * Full enhancement pipeline for raw (non-warped) frames.
 */
export function enhanceDocument(canvas: HTMLCanvasElement): HTMLCanvasElement {
  if (typeof cv === 'undefined' || !cv.imread) return canvas

  // Step 1: Auto-crop bright region
  let result = autoCropBrightRegion(canvas)

  // Step 2: CLAHE contrast enhancement
  result = applyCLAHE(result)

  // Step 3: Normalize to A4 ratio (1200×1600)
  result = normalizeToA4(result)

  return result
}

/**
 * Find the largest bright rectangular region and crop to it.
 * Returns original if no significant crop is found.
 */
function autoCropBrightRegion(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const enhanced = new cv.Mat()
  const binary = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    // CLAHE to enhance contrast before thresholding
    const clahe = cv.createCLAHE(2.0, new cv.Size(8, 8))
    clahe.apply(gray, enhanced)
    clahe.delete()

    // Otsu threshold
    cv.threshold(enhanced, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)

    // Morphology to clean noise
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15))
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel)
    cv.morphologyEx(binary, binary, cv.MORPH_OPEN, kernel)
    kernel.delete()

    cv.findContours(
      binary,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    )

    // Find largest contour
    let bestIdx = -1
    let bestArea = 0
    for (let i = 0; i < contours.size(); i++) {
      const area = cv.contourArea(contours.get(i))
      if (area > bestArea) {
        bestArea = area
        bestIdx = i
      }
    }

    if (bestIdx < 0) return canvas

    const rect = cv.boundingRect(contours.get(bestIdx))
    const frameArea = canvas.width * canvas.height
    const cropRatio = (rect.width * rect.height) / frameArea

    // Only crop if the bright region is 20-95% of frame
    // (too small = noise, too large = no benefit)
    if (cropRatio < 0.2 || cropRatio > 0.95) return canvas

    // Crop with 5% padding
    const pad = Math.round(Math.max(rect.width, rect.height) * 0.05)
    const x1 = Math.max(0, rect.x - pad)
    const y1 = Math.max(0, rect.y - pad)
    const x2 = Math.min(canvas.width, rect.x + rect.width + pad)
    const y2 = Math.min(canvas.height, rect.y + rect.height + pad)

    const out = document.createElement('canvas')
    out.width = x2 - x1
    out.height = y2 - y1
    out
      .getContext('2d')
      ?.drawImage(
        canvas,
        x1,
        y1,
        out.width,
        out.height,
        0,
        0,
        out.width,
        out.height,
      )
    return out
  } finally {
    src.delete()
    gray.delete()
    enhanced.delete()
    binary.delete()
    contours.delete()
    hierarchy.delete()
  }
}

/**
 * Apply CLAHE contrast enhancement on the L channel of LAB color space.
 * Preserves color while improving local contrast.
 */
function applyCLAHE(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const src = cv.imread(canvas)
  const bgr = new cv.Mat()
  const lab = new cv.Mat()
  const labPlanes = new cv.MatVector()
  const dst = new cv.Mat()

  try {
    cv.cvtColor(src, bgr, cv.COLOR_RGBA2BGR)
    cv.cvtColor(bgr, lab, cv.COLOR_BGR2LAB)

    // Split LAB channels
    cv.split(lab, labPlanes)
    const lChannel = labPlanes.get(0)

    // Apply CLAHE to L channel only
    const clahe = cv.createCLAHE(3.0, new cv.Size(8, 8))
    const enhanced = new cv.Mat()
    clahe.apply(lChannel, enhanced)
    clahe.delete()

    // Replace L channel and merge back
    labPlanes.set(0, enhanced)
    cv.merge(labPlanes, lab)
    cv.cvtColor(lab, dst, cv.COLOR_LAB2BGR)

    // Convert back to RGBA for canvas
    const rgba = new cv.Mat()
    cv.cvtColor(dst, rgba, cv.COLOR_BGR2RGBA)

    const out = document.createElement('canvas')
    out.width = canvas.width
    out.height = canvas.height
    cv.imshow(out, rgba)

    enhanced.delete()
    rgba.delete()
    return out
  } catch {
    return canvas // CLAHE failed — return original
  } finally {
    src.delete()
    bgr.delete()
    lab.delete()
    labPlanes.delete()
    dst.delete()
  }
}

/**
 * Normalize to A4 ratio (3:4 = 1200×1600).
 * Rotates if landscape, centers content with white padding.
 */
function normalizeToA4(canvas: HTMLCanvasElement): HTMLCanvasElement {
  let w = canvas.width
  let h = canvas.height

  // Rotate if landscape (wider than tall)
  const isLandscape = w > h
  const sourceCanvas = isLandscape ? rotateCanvas90(canvas) : canvas
  if (isLandscape) {
    ;[w, h] = [h, w]
  }

  // Scale to fit within TARGET_W × TARGET_H while maintaining aspect ratio
  const scale = Math.min(TARGET_W / w, TARGET_H / h)
  const scaledW = Math.round(w * scale)
  const scaledH = Math.round(h * scale)

  // Center on white A4 canvas
  const out = document.createElement('canvas')
  out.width = TARGET_W
  out.height = TARGET_H
  const ctx = out.getContext('2d')
  if (!ctx) return canvas

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, TARGET_W, TARGET_H)
  const offsetX = Math.round((TARGET_W - scaledW) / 2)
  const offsetY = Math.round((TARGET_H - scaledH) / 2)
  ctx.drawImage(
    sourceCanvas,
    0,
    0,
    sourceCanvas.width,
    sourceCanvas.height,
    offsetX,
    offsetY,
    scaledW,
    scaledH,
  )

  return out
}

function rotateCanvas90(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = canvas.height
  out.height = canvas.width
  const ctx = out.getContext('2d')
  if (!ctx) return canvas
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
  return out
}
