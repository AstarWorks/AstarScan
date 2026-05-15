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
