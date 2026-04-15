/**
 * Deskew: correct residual rotation in a perspective-warped document image.
 *
 * Uses OpenCV.js minAreaRect on Canny edges to detect the dominant text
 * line angle, then rotates to make text horizontal.
 */

declare const cv: {
  imread(canvas: HTMLCanvasElement): OpenCvMat
  cvtColor(src: OpenCvMat, dst: OpenCvMat, code: number): void
  Canny(src: OpenCvMat, dst: OpenCvMat, t1: number, t2: number): void
  findNonZero(src: OpenCvMat, dst: OpenCvMat): void
  minAreaRect(points: OpenCvMat): {
    angle: number
    size: { width: number; height: number }
  }
  getRotationMatrix2D(
    center: { x: number; y: number },
    angle: number,
    scale: number,
  ): OpenCvMat
  warpAffine(
    src: OpenCvMat,
    dst: OpenCvMat,
    M: OpenCvMat,
    dsize: { width: number; height: number },
  ): void
  imshow(canvas: HTMLCanvasElement, mat: OpenCvMat): void
  Mat: new () => OpenCvMat
  COLOR_RGBA2GRAY: number
}

interface OpenCvMat {
  rows: number
  cols: number
  delete(): void
}

/**
 * Detect and correct the skew angle of a document image.
 * Returns a new canvas with the corrected image, or the original if
 * no significant skew is detected.
 *
 * @param canvas - The perspective-warped document image
 * @param maxAngle - Maximum angle to correct (default 15°). Beyond this
 *   the image might need 90° rotation instead of deskew.
 */
export function deskewDocument(
  canvas: HTMLCanvasElement,
  maxAngle = 15,
): HTMLCanvasElement {
  if (typeof cv === 'undefined' || !cv.imread) return canvas

  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const edges = new cv.Mat()
  const points = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.Canny(gray, edges, 50, 150)

    // Get coordinates of all edge pixels
    cv.findNonZero(edges, points)
    if (points.rows < 100) return canvas // not enough edges

    // minAreaRect gives the angle of the minimum bounding rectangle
    const rect = cv.minAreaRect(points)
    let angle = rect.angle

    // OpenCV minAreaRect returns angle in [-90, 0).
    // If width < height, the rect is rotated and angle needs adjustment.
    if (rect.size.width < rect.size.height) {
      angle = angle + 90
    }

    // Small angles only — big angles suggest the document is sideways
    if (Math.abs(angle) > maxAngle || Math.abs(angle) < 0.5) {
      return canvas // no correction needed or too large
    }

    // Rotate
    const center = { x: canvas.width / 2, y: canvas.height / 2 }
    const M = cv.getRotationMatrix2D(center, angle, 1.0)
    const dst = new cv.Mat()
    cv.warpAffine(src, dst, M, {
      width: canvas.width,
      height: canvas.height,
    })

    // Output to new canvas
    const out = document.createElement('canvas')
    out.width = canvas.width
    out.height = canvas.height
    cv.imshow(out, dst)

    dst.delete()
    M.delete()
    return out
  } catch {
    return canvas // any error → return original
  } finally {
    src.delete()
    gray.delete()
    edges.delete()
    points.delete()
  }
}
