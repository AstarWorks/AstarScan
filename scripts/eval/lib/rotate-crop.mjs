/**
 * Rotate-then-bbox card crop (no perspective correction).
 *
 * Replaces `warpPerspective` for the batch pipeline. The reason:
 * warpPerspective forces the (often-trapezoidal) detected quad into a
 * fixed (W, H) rectangle, and the (W, H) we ask for comes from a
 * heuristic aspect estimate (avg of edge lengths). For steeply-angled
 * cards that estimate can be off by 5-15 %, stretching the content
 * horizontally or vertically. Text OCR is sensitive to that stretch
 * (kanji radicals look mis-placed).
 *
 * This function:
 *   1. Picks the top edge (tl→tr) of the quad and computes its angle.
 *   2. Rotates the FULL source frame so the top edge is horizontal.
 *   3. Transforms the quad's corners through the same rotation matrix.
 *   4. Computes an axis-aligned bbox over the rotated corners, with a
 *      small margin (default 5 %) so the card edges don't touch the
 *      output border.
 *   5. Crops + uniform-scales (preserving aspect) to make the long side
 *      equal `longSide` pixels (mode-dependent for visual consistency).
 *
 * Result: NO pixel-level distortion (only uniform rotation + crop), the
 * card sits axis-aligned ready for OCR, and the output's aspect ratio
 * is whatever the card actually had in the source frame.
 */

import '../pipeline.mjs' // patches cv.imread / cv.imshow for @napi-rs/canvas
import { cv } from '../cv-shim.mjs'
import { newCanvas } from '../canvas-utils.mjs'

const DEFAULT_MARGIN_RATIO = 0.05

/**
 * @param {HTMLCanvasElement-like} canvas — source frame
 * @param {{tl,tr,br,bl}} quad — detected corners in source-frame coords
 * @param {number} longSide — output long-side pixel target (e.g. 1010)
 * @param {number} marginRatio — extra margin around the quad (0.05 = 5 %)
 * @returns {HTMLCanvasElement-like} new canvas with the cropped card,
 *   long side ≤ `longSide` pixels, aspect = quad's true aspect.
 */
export function rotateAndCropQuad(
  canvas,
  quad,
  longSide,
  marginRatio = DEFAULT_MARGIN_RATIO,
) {
  // 1. Angle of top edge (tl → tr)
  const dx = quad.tr.x - quad.tl.x
  const dy = quad.tr.y - quad.tl.y
  // atan2 in OpenCV's y-down image coords. To make the top edge align
  // with the +x axis, rotate by `-atan2(dy, dx)` degrees. (positive
  // angle in cv.getRotationMatrix2D rotates CCW in math coords → CW in
  // image coords visually; -atan2 cancels image-y inversion.)
  const angleDeg = -(Math.atan2(dy, dx) * 180) / Math.PI

  const cx = (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4
  const cy = (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4
  const srcW = canvas.width
  const srcH = canvas.height

  const src = cv.imread(canvas)
  const rotated = new cv.Mat()
  const M = cv.getRotationMatrix2D(new cv.Point(cx, cy), angleDeg, 1.0)
  try {
    cv.warpAffine(
      src,
      rotated,
      M,
      new cv.Size(srcW, srcH),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    )

    // Push rotated Mat to a temp canvas (used as drawImage source).
    const rotatedCanvas = newCanvas(srcW, srcH)
    cv.imshow(rotatedCanvas, rotated)

    // 2. Apply M to the quad corners. M is a 2×3 affine matrix:
    //   [a b tx]
    //   [c d ty]
    const a = M.doubleAt(0, 0)
    const b = M.doubleAt(0, 1)
    const tx = M.doubleAt(0, 2)
    const c2 = M.doubleAt(1, 0)
    const d2 = M.doubleAt(1, 1)
    const ty = M.doubleAt(1, 2)
    const rotPt = (p) => ({
      x: a * p.x + b * p.y + tx,
      y: c2 * p.x + d2 * p.y + ty,
    })
    const rotCorners = [quad.tl, quad.tr, quad.br, quad.bl].map(rotPt)

    // 3. Bbox with margin.
    const xs = rotCorners.map((p) => p.x)
    const ys = rotCorners.map((p) => p.y)
    let x1 = Math.min(...xs)
    let y1 = Math.min(...ys)
    let x2 = Math.max(...xs)
    let y2 = Math.max(...ys)
    const w = x2 - x1
    const h = y2 - y1
    x1 = Math.max(0, x1 - w * marginRatio)
    y1 = Math.max(0, y1 - h * marginRatio)
    x2 = Math.min(srcW, x2 + w * marginRatio)
    y2 = Math.min(srcH, y2 + h * marginRatio)
    const cropW = Math.round(x2 - x1)
    const cropH = Math.round(y2 - y1)
    if (cropW < 10 || cropH < 10) {
      // Degenerate quad — return the rotated canvas as-is rather than crash.
      return rotatedCanvas
    }

    // 4. Uniform scale so the long side = `longSide`. This preserves the
    //    cropped region's aspect EXACTLY.
    const scale = longSide / Math.max(cropW, cropH)
    const outW = Math.max(1, Math.round(cropW * scale))
    const outH = Math.max(1, Math.round(cropH * scale))

    const out = newCanvas(outW, outH)
    const ctx = out.getContext('2d')
    ctx.drawImage(rotatedCanvas, x1, y1, cropW, cropH, 0, 0, outW, outH)
    return out
  } finally {
    src.delete()
    rotated.delete()
    M.delete()
  }
}
