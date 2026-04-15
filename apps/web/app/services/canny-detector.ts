/**
 * Canny + contour-based document edge detection.
 *
 * Last-resort fallback when both DocAligner (ML) and jscanify (CV lib)
 * fail to detect document edges. Uses raw OpenCV.js Canny + findContours
 * to find the largest quadrilateral in the frame.
 *
 * Also provides a document coverage score (how much of the frame the
 * document occupies) for best-frame ranking.
 */

import type { Quad } from '@astarworks/scan-core'

declare const cv: {
  imread(canvas: HTMLCanvasElement): OpenCvMat
  cvtColor(src: OpenCvMat, dst: OpenCvMat, code: number): void
  GaussianBlur(
    src: OpenCvMat,
    dst: OpenCvMat,
    ksize: { width: number; height: number },
    sigmaX: number,
  ): void
  Canny(
    src: OpenCvMat,
    dst: OpenCvMat,
    threshold1: number,
    threshold2: number,
  ): void
  dilate(src: OpenCvMat, dst: OpenCvMat, kernel: OpenCvMat): void
  getStructuringElement(
    shape: number,
    ksize: { width: number; height: number },
  ): OpenCvMat
  findContours(
    src: OpenCvMat,
    contours: OpenCvMatVector,
    hierarchy: OpenCvMat,
    mode: number,
    method: number,
  ): void
  arcLength(curve: OpenCvMat, closed: boolean): number
  approxPolyDP(
    curve: OpenCvMat,
    approx: OpenCvMat,
    epsilon: number,
    closed: boolean,
  ): void
  contourArea(contour: OpenCvMat): number
  threshold(
    src: OpenCvMat,
    dst: OpenCvMat,
    thresh: number,
    maxval: number,
    type: number,
  ): number
  Mat: new () => OpenCvMat
  MatVector: new () => OpenCvMatVector
  Size: new (width: number, height: number) => { width: number; height: number }
  COLOR_RGBA2GRAY: number
  MORPH_RECT: number
  RETR_EXTERNAL: number
  CHAIN_APPROX_SIMPLE: number
  THRESH_BINARY: number
  THRESH_OTSU: number
}

interface OpenCvMat {
  rows: number
  cols: number
  data32S: Int32Array
  ucharPtr(row: number, col: number): Uint8Array
  delete(): void
}

interface OpenCvMatVector {
  size(): number
  get(i: number): OpenCvMat
  delete(): void
}

/**
 * Detect the largest quadrilateral in the frame using Canny + contours.
 * Returns null if no suitable quadrilateral is found.
 */
export function cannyDetectQuad(canvas: HTMLCanvasElement): Quad | null {
  if (typeof cv === 'undefined' || !cv.imread) return null

  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const blurred = new cv.Mat()
  const edges = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
    cv.Canny(blurred, edges, 50, 150)

    // Dilate to close gaps in edges
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))
    cv.dilate(edges, edges, kernel)
    kernel.delete()

    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    )

    const frameArea = canvas.width * canvas.height
    let bestQuad: Quad | null = null
    let bestArea = 0

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i)
      const peri = cv.arcLength(cnt, true)
      const approx = new cv.Mat()
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true)

      if (approx.rows === 4) {
        const area = cv.contourArea(approx)
        // Must cover at least 10% of frame, less than 98%
        if (
          area > frameArea * 0.1 &&
          area < frameArea * 0.98 &&
          area > bestArea
        ) {
          bestArea = area
          bestQuad = matToQuad(approx, canvas.width, canvas.height)
        }
      }
      approx.delete()
    }

    return bestQuad
  } finally {
    src.delete()
    gray.delete()
    blurred.delete()
    edges.delete()
    contours.delete()
    hierarchy.delete()
  }
}

function matToQuad(approx: OpenCvMat, _frameW: number, _frameH: number): Quad {
  // approx is a 4×1 Mat of points (data32S: [x0,y0, x1,y1, x2,y2, x3,y3])
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < 4; i++) {
    pts.push({ x: approx.data32S[i * 2]!, y: approx.data32S[i * 2 + 1]! })
  }

  // Sort corners: top-left, top-right, bottom-right, bottom-left
  // Sort by Y first (top two vs bottom two), then by X
  pts.sort((a, b) => a.y - b.y)
  const top = pts.slice(0, 2).sort((a, b) => a.x - b.x)
  const bottom = pts.slice(2, 4).sort((a, b) => a.x - b.x)

  return {
    tl: { x: top[0]!.x, y: top[0]!.y },
    tr: { x: top[1]!.x, y: top[1]!.y },
    bl: { x: bottom[0]!.x, y: bottom[0]!.y },
    br: { x: bottom[1]!.x, y: bottom[1]!.y },
  }
}

/**
 * Calculate how much of the frame is covered by "document-like" content
 * (bright pixels). Returns 0-1 where 1 = entire frame is bright (document).
 * Used for best-frame scoring.
 */
export function documentCoverageScore(canvas: HTMLCanvasElement): number {
  if (typeof cv === 'undefined' || !cv.imread) return 0.5

  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const binary = new cv.Mat()

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    // Otsu's thresholding: separates bright (paper) from dark (desk)
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)

    // Count bright pixels
    let brightCount = 0
    const total = binary.rows * binary.cols
    for (let r = 0; r < binary.rows; r++) {
      for (let c = 0; c < binary.cols; c++) {
        if (binary.ucharPtr(r, c)[0]! > 128) brightCount++
      }
    }

    return brightCount / total
  } finally {
    src.delete()
    gray.delete()
    binary.delete()
  }
}
