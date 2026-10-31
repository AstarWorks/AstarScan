/**
 * Smoke test: load opencv.js in Node, warp one JPEG with a fixed quad,
 * write the result. If this passes, the cv-shim is viable for the rest
 * of the harness.
 *
 * Usage: bun run scripts/eval/smoke-test.mjs
 */

import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { cv, imageDataToMat, matToImageData } from './cv-shim.mjs'
import { ImageData, jpegToCanvas, newCanvas, saveJpeg } from './canvas-utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const INPUT = path.join(
  REPO_ROOT,
  'scripts/dataset/raw/20260412_204840_0050.jpg',
)
const OUTPUT_DIR = path.join(REPO_ROOT, 'eval-out/smoke')
const OUTPUT = path.join(OUTPUT_DIR, 'warped.jpg')

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  console.log(`[smoke] cv.warpPerspective: ${typeof cv.warpPerspective}`)
  console.log(
    `[smoke] cv.getPerspectiveTransform: ${typeof cv.getPerspectiveTransform}`,
  )
  console.log(`[smoke] cv.matFromArray: ${typeof cv.matFromArray}`)

  console.log(`[smoke] loading ${INPUT}`)
  const srcCanvas = await jpegToCanvas(INPUT)
  const ctx = srcCanvas.getContext('2d')
  const srcImageData = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height)
  console.log(
    `[smoke] image ${srcCanvas.width}x${srcCanvas.height}, ${srcImageData.data.length} bytes`,
  )

  const srcMat = imageDataToMat(cv, srcImageData)
  const dstMat = new cv.Mat()

  // Pick a plausible doc-ish quad inside the frame. Source frames are
  // 720x1280 portrait; pick an inset rectangle as a stand-in for an
  // actual detection.
  const W = srcCanvas.width
  const H = srcCanvas.height
  const m = 0.1
  const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    W * m, H * m,
    W * (1 - m), H * m,
    W * (1 - m), H * (1 - m),
    W * m, H * (1 - m),
  ])
  const OUT_W = 1200
  const OUT_H = 1600
  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    OUT_W, 0,
    OUT_W, OUT_H,
    0, OUT_H,
  ])

  const M = cv.getPerspectiveTransform(srcPoints, dstPoints)
  cv.warpPerspective(
    srcMat,
    dstMat,
    M,
    new cv.Size(OUT_W, OUT_H),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(),
  )

  const raw = matToImageData(dstMat)
  const outImageData = new ImageData(raw.data, raw.width, raw.height)
  const outCanvas = newCanvas(OUT_W, OUT_H)
  outCanvas.getContext('2d').putImageData(outImageData, 0, 0)

  await saveJpeg(outCanvas, OUTPUT, 0.85)
  console.log(`[smoke] wrote ${OUTPUT}`)

  srcMat.delete()
  dstMat.delete()
  srcPoints.delete()
  dstPoints.delete()
  M.delete()

  console.log('[smoke] OK')
}

main().catch((err) => {
  console.error('[smoke] FAILED', err)
  process.exit(1)
})
