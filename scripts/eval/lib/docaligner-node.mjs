/**
 * DocAligner FastViT — Node-side port of
 * `apps/web/app/services/docaligner-backend.ts`.
 *
 * Uses onnxruntime-node + @napi-rs/canvas. The model file is read from disk
 * (default: apps/web/public/models/docaligner-fastvit-t8.onnx). Same I/O
 * contract as the browser version: feed a Canvas-like object, get a
 * { quad, confidence } back, with parallelogram-completion of one weak
 * corner.
 *
 * Quad order: TL, TR, BR, BL (clockwise from top-left).
 */

import process from 'node:process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import ort from 'onnxruntime-node'
import { newCanvas } from '../canvas-utils.mjs'

const INPUT_SIZE = 256
const MIN_CORNER_PEAK = 0.02
const MIN_FRAME_FRACTION = 0.05
const MAX_FRAME_FRACTION = 1.0

const MODEL_PATHS = {
  fastvit_t8: 'apps/web/public/models/docaligner-fastvit-t8.onnx',
  lcnet100: 'apps/web/public/models/docaligner-lcnet100.onnx',
  fastvit_sa24: 'apps/web/public/models/docaligner-fastvit-sa24.onnx',
}

/**
 * Resize a source canvas to INPUT_SIZE×INPUT_SIZE, lay out as
 * NCHW float32 in [0,1], no normalization (DocAligner uses raw /255).
 */
function canvasToTensor(sourceCanvas) {
  const work = newCanvas(INPUT_SIZE, INPUT_SIZE)
  const ctx = work.getContext('2d')
  ctx.drawImage(sourceCanvas, 0, 0, INPUT_SIZE, INPUT_SIZE)
  const pixels = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data

  const pixelCount = INPUT_SIZE * INPUT_SIZE
  const f32 = new Float32Array(3 * pixelCount)
  for (let i = 0; i < pixelCount; i += 1) {
    const r = pixels[i * 4] / 255
    const g = pixels[i * 4 + 1] / 255
    const b = pixels[i * 4 + 2] / 255
    f32[i] = r
    f32[pixelCount + i] = g
    f32[2 * pixelCount + i] = b
  }
  return new ort.Tensor('float32', f32, [1, 3, INPUT_SIZE, INPUT_SIZE])
}

function argmaxCorner(data, offset, width, height) {
  let peak = 0
  let bestX = 0
  let bestY = 0
  const cells = width * height
  for (let i = 0; i < cells; i += 1) {
    const v = data[offset + i] ?? 0
    if (v > peak) {
      peak = v
      bestX = i % width
      bestY = (i - bestX) / width
    }
  }
  return { x: bestX, y: bestY, peak }
}

function shoelaceArea(q) {
  return (
    Math.abs(
      q.tl.x * q.tr.y -
        q.tr.x * q.tl.y +
        (q.tr.x * q.br.y - q.br.x * q.tr.y) +
        (q.br.x * q.bl.y - q.bl.x * q.br.y) +
        (q.bl.x * q.tl.y - q.tl.x * q.bl.y),
    ) / 2
  )
}

function isPlausibleQuad(quad, w, h) {
  const f = shoelaceArea(quad) / (w * h)
  return f > MIN_FRAME_FRACTION && f < MAX_FRAME_FRACTION
}

export class DocAlignerNodeBackend {
  constructor(modelName = 'lcnet100') {
    this.modelName = modelName
    this.session = null
  }

  async warmUp() {
    if (this.session) return
    const rel = MODEL_PATHS[this.modelName]
    if (!rel) throw new Error(`Unknown DocAligner model: ${this.modelName}`)
    const abs = path.resolve(process.cwd(), rel)
    if (!fs.existsSync(abs)) {
      throw new Error(`Model file not found: ${abs}`)
    }
    this.session = await ort.InferenceSession.create(abs, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    })
  }

  async detect(canvas) {
    if (!this.session) {
      throw new Error('warmUp() must be called before detect()')
    }
    const inputTensor = canvasToTensor(canvas)
    // DocAligner expects input name "img"; verify on first run.
    const inputName = this.session.inputNames[0] ?? 'img'
    const results = await this.session.run({ [inputName]: inputTensor })
    const heatmapTensor =
      results['heatmap'] ?? results[this.session.outputNames[0]]
    if (!heatmapTensor) return null

    const data = heatmapTensor.data
    const [, numCorners, hH, hW] = heatmapTensor.dims.map(Number)
    if (numCorners !== 4 || hH === 0 || hW === 0) return null

    const channelSize = hH * hW
    const corners = []
    const peaks = []
    for (let c = 0; c < 4; c += 1) {
      const r = argmaxCorner(data, c * channelSize, hW, hH)
      peaks.push(r.peak)
      corners.push({
        x: (r.x / hW) * canvas.width,
        y: (r.y / hH) * canvas.height,
      })
    }

    const weakIdxs = peaks
      .map((p, i) => (p < MIN_CORNER_PEAK ? i : -1))
      .filter((i) => i >= 0)
    if (weakIdxs.length > 1) return null
    if (weakIdxs.length === 1) {
      const i = weakIdxs[0]
      const adj1 = corners[(i + 1) % 4]
      const adj2 = corners[(i + 3) % 4]
      const opp = corners[(i + 2) % 4]
      corners[i] = {
        x: adj1.x + adj2.x - opp.x,
        y: adj1.y + adj2.y - opp.y,
      }
      const strongMean =
        peaks.filter((_, j) => j !== i).reduce((a, b) => a + b, 0) / 3
      peaks[i] = strongMean
    }

    const quad = {
      tl: corners[0],
      tr: corners[1],
      br: corners[2],
      bl: corners[3],
    }
    if (!isPlausibleQuad(quad, canvas.width, canvas.height)) return null

    return {
      quad,
      confidence: (peaks[0] + peaks[1] + peaks[2] + peaks[3]) / 4,
    }
  }
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const { jpegToCanvas } = await import('../canvas-utils.mjs')

  const imagePath = process.argv[2] ?? '/tmp/mp4-3-sample/frame-04.jpg'
  const model = process.argv[3] ?? 'fastvit_t8'

  const backend = new DocAlignerNodeBackend(model)
  console.log(`[docaligner] loading ${model}…`)
  const t0 = Date.now()
  await backend.warmUp()
  console.log(`[docaligner] warmUp in ${Date.now() - t0} ms`)

  const buf = fs.readFileSync(imagePath)
  const canvas = await jpegToCanvas(buf)
  console.log(`[docaligner] image ${canvas.width}×${canvas.height}`)

  const t1 = Date.now()
  const result = await backend.detect(canvas)
  console.log(`[docaligner] detect in ${Date.now() - t1} ms`)
  console.log(JSON.stringify(result, null, 2))
}
