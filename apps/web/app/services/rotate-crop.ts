/**
 * Rotate-then-bbox card crop. Browser port of
 * `scripts/eval/lib/rotate-crop.mjs`.
 *
 * Replaces `warpPerspective` for the batch pipeline. Why:
 * warpPerspective stretches content to match an estimated aspect ratio,
 * and that estimate (avg of edge lengths on a possibly-trapezoidal
 * quad) can be off by 5-15 %, distorting text. This function instead:
 *   1. Rotates the source so the quad's top edge is horizontal.
 *   2. Computes the axis-aligned bbox of the rotated quad + margin.
 *   3. Crops + uniform-scales so long-side = `longSide` pixels.
 *
 * Result: zero pixel-level distortion, card axis-aligned, aspect = the
 * card's actual aspect.
 */

import type { Quad } from '@astarworks/scan-core'
import { newCanvas } from './canvas-helpers'

const DEFAULT_MARGIN_RATIO = 0.05

export function rotateAndCropQuad(
  canvas: HTMLCanvasElement,
  quad: Quad,
  longSide: number,
  marginRatio: number = DEFAULT_MARGIN_RATIO,
): HTMLCanvasElement {
  const dx = quad.tr.x - quad.tl.x
  const dy = quad.tr.y - quad.tl.y
  // Angle to apply to canvas so the top edge aligns with +x axis.
  // canvas.rotate uses CCW radians in default coord system; image y is
  // flipped, so we negate atan2 to cancel.
  const angleRad = -Math.atan2(dy, dx)

  const cx = (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4
  const cy = (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4

  const srcW = canvas.width
  const srcH = canvas.height

  // 1. Rotate the source frame around its centroid.
  // We draw the source into a same-size temp canvas with rotation applied.
  // Rotation around (cx, cy) is implemented by:
  //   translate(cx, cy); rotate(angle); translate(-cx, -cy); drawImage(0,0)
  const rotated = newCanvas(srcW, srcH)
  const rctx = rotated.getContext('2d')
  if (!rctx) throw new Error('Failed to create 2D context')
  rctx.translate(cx, cy)
  rctx.rotate(angleRad)
  rctx.translate(-cx, -cy)
  rctx.drawImage(canvas, 0, 0)

  // 2. Transform quad corners using the same rotation.
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const rotPt = (p: { x: number; y: number }) => ({
    x: cos * (p.x - cx) - sin * (p.y - cy) + cx,
    y: sin * (p.x - cx) + cos * (p.y - cy) + cy,
  })
  const rc = [quad.tl, quad.tr, quad.br, quad.bl].map(rotPt)

  const xs = rc.map((p) => p.x)
  const ys = rc.map((p) => p.y)
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
    return rotated
  }

  // 3. Uniform scale so long side = `longSide`.
  const scale = longSide / Math.max(cropW, cropH)
  const outW = Math.max(1, Math.round(cropW * scale))
  const outH = Math.max(1, Math.round(cropH * scale))

  const out = newCanvas(outW, outH)
  const octx = out.getContext('2d')
  if (!octx) return rotated
  octx.drawImage(rotated, x1, y1, cropW, cropH, 0, 0, outW, outH)
  return out
}
