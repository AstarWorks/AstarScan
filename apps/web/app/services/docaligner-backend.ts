/**
 * `DocAlignerBackend` — ONNX-powered document corner detection.
 *
 * Uses DocAligner (DocsaidLab, MIT License) heatmap regression models
 * via ONNX Runtime Web. Three model variants are available, all at
 * 256×256 input resolution:
 *
 *   - fastvit_sa24 (80MB) — highest accuracy, heavy
 *   - fastvit_t8   (13MB) — good accuracy/size balance ← default
 *   - lcnet100     (4.6MB) — fastest, smallest, slightly lower accuracy
 *
 * The model outputs a (1, 4, H, W) heatmap where each channel represents
 * the confidence map for one document corner. Post-processing extracts
 * the weighted centroid of the thresholded region per channel → 4 corners.
 *
 * Source code reference: DocsaidLab/DocAligner heatmap_reg/infer.py
 * Input: (1, 3, 256, 256) NCHW float32, pixel values / 255
 * Output: {'heatmap': (1, 4, H, W)} float32, sigmoid activated
 */

import type { EdgeDetectorBackend, Quad } from '@astarworks/scan-core'
import type * as ort from 'onnxruntime-web'

import { canvasToTensor, loadOrtSession } from './ort-model-loader'

const INPUT_SIZE = 256
const HEATMAP_THRESHOLD = 0.3
const MIN_FRAME_FRACTION = 0.05
const MAX_FRAME_FRACTION = 1.0

export type DocAlignerModel = 'fastvit_t8' | 'lcnet100' | 'fastvit_sa24'

const MODEL_URLS: Record<DocAlignerModel, string> = {
  fastvit_t8: '/models/docaligner-fastvit-t8.onnx',
  lcnet100: '/models/docaligner-lcnet100.onnx',
  fastvit_sa24: '/models/docaligner-fastvit-sa24.onnx',
}

export class DocAlignerBackend implements EdgeDetectorBackend {
  readonly name = 'docaligner'

  #session: ort.InferenceSession | null = null
  #ready = false
  #modelName: DocAlignerModel

  constructor(model: DocAlignerModel = 'fastvit_t8') {
    this.#modelName = model
  }

  get ready(): boolean {
    return this.#ready
  }

  async warmUp(): Promise<void> {
    if (this.#ready && this.#session) return
    const url = MODEL_URLS[this.#modelName]
    this.#session = await loadOrtSession(url)
    this.#ready = true
  }

  async detect(frame: HTMLCanvasElement): Promise<Quad | null> {
    const session = this.#session
    if (!session || !this.#ready) {
      throw new Error(
        'DocAlignerBackend.warmUp() must be called before detect()',
      )
    }

    // Preprocess: resize to 256×256, NCHW float32, / 255.0
    // DocAligner does NOT use ImageNet normalization — just simple 0-1 scaling.
    const inputTensor = canvasToTensor(frame, INPUT_SIZE)

    // Run inference
    const results = await session.run({ img: inputTensor })
    const heatmapTensor = results['heatmap']
    if (!heatmapTensor) return null

    const heatmapData = heatmapTensor.data as Float32Array
    const heatmapDims = heatmapTensor.dims
    // Output shape: (1, 4, H, W)
    const numCorners = Number(heatmapDims[1])
    const heatmapH = Number(heatmapDims[2])
    const heatmapW = Number(heatmapDims[3])

    if (numCorners !== 4 || heatmapH === 0 || heatmapW === 0) return null

    // Post-processing: extract weighted centroid from each corner's heatmap
    const channelSize = heatmapH * heatmapW
    const corners: Array<{ x: number; y: number }> = []

    for (let c = 0; c < 4; c++) {
      const offset = c * channelSize
      const point = weightedCentroid(
        heatmapData,
        offset,
        heatmapW,
        heatmapH,
        HEATMAP_THRESHOLD,
      )
      if (!point) return null
      // Scale from heatmap coordinates to source frame coordinates
      corners.push({
        x: (point.x / heatmapW) * frame.width,
        y: (point.y / heatmapH) * frame.height,
      })
    }

    if (corners.length !== 4) return null

    // DocAligner corner order: TL, TR, BR, BL (clockwise from top-left)
    const quad: Quad = {
      tl: { x: corners[0]!.x, y: corners[0]!.y },
      tr: { x: corners[1]!.x, y: corners[1]!.y },
      br: { x: corners[2]!.x, y: corners[2]!.y },
      bl: { x: corners[3]!.x, y: corners[3]!.y },
    }

    // Sanity check: reject quads that are the whole frame or tiny
    if (!isPlausibleQuad(quad, frame.width, frame.height)) return null

    return quad
  }

  dispose(): void {
    this.#session?.release()
    this.#session = null
    this.#ready = false
  }
}

/**
 * Compute the weighted centroid of all pixels above `threshold` in a
 * single heatmap channel. This is equivalent to the Python original's
 * "find contour → largest area → centroid" pipeline, but without
 * needing OpenCV contour detection in JS. For well-formed heatmaps
 * (which DocAligner's sigmoid output produces), the weighted centroid
 * gives the same result as the contour centroid.
 */
function weightedCentroid(
  data: Float32Array,
  offset: number,
  width: number,
  height: number,
  threshold: number,
): { x: number; y: number } | null {
  let sumX = 0
  let sumY = 0
  let sumW = 0

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[offset + y * width + x] ?? 0
      if (v > threshold) {
        sumX += x * v
        sumY += y * v
        sumW += v
      }
    }
  }

  if (sumW === 0) return null
  return { x: sumX / sumW, y: sumY / sumW }
}

function isPlausibleQuad(
  quad: Quad,
  frameWidth: number,
  frameHeight: number,
): boolean {
  const frameArea = frameWidth * frameHeight
  if (frameArea <= 0) return false
  const area = shoelaceArea(quad)
  const fraction = area / frameArea
  return fraction > MIN_FRAME_FRACTION && fraction < MAX_FRAME_FRACTION
}

function shoelaceArea(q: Quad): number {
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
