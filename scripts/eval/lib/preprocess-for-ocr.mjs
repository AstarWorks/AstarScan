/**
 * Pre-OCR image enhancement.
 *
 * Some warped business cards come out with low contrast — light text on a
 * light beige/blue background, or a faded scan — and YomiToku's DBNetV2
 * text detector returns zero paragraphs. Applying CLAHE (Contrast Limited
 * Adaptive Histogram Equalization) on the luminance channel + a mild
 * unsharp-mask rescues most of these.
 *
 * Input: HTMLCanvasElement-like (from @napi-rs/canvas)
 * Output: new HTMLCanvasElement-like with the same dims
 */

// Pulling in pipeline.mjs has the side effect of patching cv.imread /
// cv.imshow with the @napi-rs/canvas ↔ cv.Mat bridge that Node needs (the
// built-in versions assume HTMLImageElement / HTMLCanvasElement).
import '../pipeline.mjs'
import { cv } from '../cv-shim.mjs'
import { newCanvas } from '../canvas-utils.mjs'

/**
 * Enhance image for OCR. Pipeline:
 *   1. RGBA → grayscale (text doesn't need color)
 *   2. equalizeHist (global contrast stretch)
 *   3. addWeighted blend with original (70/30) to preserve some texture
 *   4. unsharp mask (subtle, sigma=2)
 *   5. grayscale → RGBA back for JPG round-trip
 *
 * @techstark/opencv-js's cv.CLAHE has an odd constructor signature; using
 * global equalizeHist is good enough for the low-contrast cards in
 * practice (e.g. 中根徹也's faded blue background).
 */
export function enhanceForOcr(srcCanvas) {
  const src = cv.imread(srcCanvas)
  const gray = new cv.Mat()
  const eq = new cv.Mat()
  const blended = new cv.Mat()
  const blurred = new cv.Mat()
  const sharpened = new cv.Mat()
  const dst = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.equalizeHist(gray, eq)
    cv.addWeighted(eq, 0.7, gray, 0.3, 0, blended)
    cv.GaussianBlur(blended, blurred, new cv.Size(0, 0), 2.0, 2.0, cv.BORDER_DEFAULT)
    cv.addWeighted(blended, 1.4, blurred, -0.4, 0, sharpened)
    cv.cvtColor(sharpened, dst, cv.COLOR_GRAY2RGBA)
    const out = newCanvas(srcCanvas.width, srcCanvas.height)
    cv.imshow(out, dst)
    return out
  } finally {
    src.delete()
    gray.delete()
    eq.delete()
    blended.delete()
    blurred.delete()
    sharpened.delete()
    dst.delete()
  }
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const fs = await import('node:fs')
  const { jpegToCanvas, canvasToJpegBuffer } = await import('../canvas-utils.mjs')
  const imagePath = process.argv[2] ?? '/tmp/winner-021-test.jpg'
  const buf = fs.readFileSync(imagePath)
  const src = await jpegToCanvas(buf)
  const out = enhanceForOcr(src)
  const outPath = imagePath.replace(/\.jpg$/, '-enhanced.jpg')
  fs.writeFileSync(outPath, canvasToJpegBuffer(out, 90))
  console.log(`saved ${outPath}`)
}
