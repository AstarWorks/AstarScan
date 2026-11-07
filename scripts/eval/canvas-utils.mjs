/**
 * @napi-rs/canvas utilities for the eval harness.
 *
 * The browser pipeline passes HTMLCanvasElement around. In Node we use
 * `@napi-rs/canvas`'s Canvas, which has the same `getContext('2d')` /
 * `getImageData` / `putImageData` / `toBuffer` shape, so production code
 * paths that touch a canvas (via cv.imread/imshow) need only the
 * imageData adapters in cv-shim.mjs to round-trip.
 */

import { Canvas, ImageData, loadImage } from '@napi-rs/canvas'
import fs from 'node:fs/promises'

export { ImageData }

/**
 * Load a JPEG/PNG file into a Canvas. The returned canvas's getContext
 * + getImageData round-trips through cv-shim.imageDataToMat to OpenCV.
 */
export async function jpegToCanvas(filePath) {
  const img = await loadImage(filePath)
  const canvas = new Canvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  return canvas
}

/**
 * Make a fresh Canvas with the given dimensions. Used when warp produces
 * an output canvas (1200×1600 by default).
 */
export function newCanvas(width, height) {
  return new Canvas(width, height)
}

/** Encode a Canvas to a JPEG buffer. Quality is 0..1. */
export function canvasToJpegBuffer(canvas, quality = 0.85) {
  // @napi-rs/canvas takes quality as 0..100, browser as 0..1. Match
  // the browser API at this surface.
  return canvas.toBuffer('image/jpeg', Math.round(quality * 100))
}

/** Save a canvas as JPEG. */
export async function saveJpeg(canvas, outPath, quality = 0.85) {
  const buf = canvasToJpegBuffer(canvas, quality)
  await fs.writeFile(outPath, buf)
}

// ---------------------------------------------------------------------------
// Detection overlay (diagnostic) — draw one or more detected quads on top of
// the source frame so we can SEE whether the corners track the real paper
// edge. Per-corner dots are colour-coded tl/tr/br/bl to also expose any
// corner-ordering bug. Used by the eval harness only (Stage 0 diagnosis).
// ---------------------------------------------------------------------------

// tl, tr, br, bl — fixed colours so the same corner is always the same hue.
const CORNER_COLORS = ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a']

/**
 * Return a new canvas = `src` with each quad drawn on it.
 * @param src    source HTMLCanvas-like (raw video frame)
 * @param quads  Array<{ quad, color?, lineWidth? }> where quad is
 *               { tl, tr, br, bl } with {x,y} corners in src pixel space.
 */
export function drawQuadsOverlay(src, quads) {
  const canvas = new Canvas(src.width, src.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(src, 0, 0)
  const baseLw = Math.max(2, Math.round(src.width / 400))
  for (const { quad, color = '#ff3b30', lineWidth } of quads) {
    if (!quad) continue
    const pts = [quad.tl, quad.tr, quad.br, quad.bl]
    const lw = lineWidth ?? baseLw
    ctx.strokeStyle = color
    ctx.lineWidth = lw
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < 4; i += 1) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.closePath()
    ctx.stroke()
    for (let i = 0; i < 4; i += 1) {
      ctx.fillStyle = CORNER_COLORS[i]
      ctx.beginPath()
      ctx.arc(pts[i].x, pts[i].y, lw * 2, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  return canvas
}
