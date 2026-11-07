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

import type { Quad } from '@astarworks/scan-core'
import type * as ort from 'onnxruntime-web'

import { canvasToTensor, loadOrtSession } from './ort-model-loader'

const INPUT_SIZE = 256
/**
 * Minimum peak value for a corner channel to be considered "detected".
 * LCNet on handheld phone footage peaks at 0.6-0.9 on well-localized
 * corners but can drop to 0.03-0.1 on the opposite corner when the user
 * is tilted or the page partly extends off-frame. Empirically, anything
 * above 0.02 is meaningfully above noise (no-document frames have all
 * corners < 0.01). We use argmax of the channel as the corner location
 * — sub-pixel weighted-centroid precision isn't worth losing marginal
 * frames where one peak is weak but still clearly located.
 */
const MIN_CORNER_PEAK = 0.02
const MIN_FRAME_FRACTION = 0.05
const MAX_FRAME_FRACTION = 1.0

export type DocAlignerModel = 'fastvit_t8' | 'lcnet100' | 'fastvit_sa24'

const MODEL_URLS: Record<DocAlignerModel, string> = {
  fastvit_t8: '/models/docaligner-fastvit-t8.onnx',
  lcnet100: '/models/docaligner-lcnet100.onnx',
  fastvit_sa24: '/models/docaligner-fastvit-sa24.onnx',
}

export interface DocAlignerDetection {
  quad: Quad
  /** Mean of the peak heatmap value across the 4 corners, in [0, 1].
   *  Higher = the model is more confident each corner is well localized. */
  confidence: number
}

export class DocAlignerBackend {
  readonly name = 'docaligner'

  #session: ort.InferenceSession | null = null
  #ready = false
  #modelName: DocAlignerModel

  constructor(model: DocAlignerModel = 'lcnet100') {
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

  async detect(frame: HTMLCanvasElement): Promise<DocAlignerDetection | null> {
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

    // Post-processing: argmax location per corner channel.
    const channelSize = heatmapH * heatmapW
    const corners: Array<{ x: number; y: number }> = []
    const peaks: number[] = []

    for (let c = 0; c < 4; c++) {
      const offset = c * channelSize
      const result = argmaxCorner(heatmapData, offset, heatmapW, heatmapH)
      peaks.push(result.peak)
      corners.push({
        x: (result.x / heatmapW) * frame.width,
        y: (result.y / heatmapH) * frame.height,
      })
    }

    // Parallelogram inference for a single weak corner. Handheld phone
    // footage frequently occludes the bottom corners with the hand holding
    // the paper — the model then emits a near-zero peak for (usually) BL,
    // but the other three corners are solid. A quad is overdetermined by
    // 3 points assuming a parallelogram: the 4th corner is opposite + sum
    // of adjacent vectors (D = A + C - B).
    const weakIdxs = peaks
      .map((p, i) => (p < MIN_CORNER_PEAK ? i : -1))
      .filter((i) => i >= 0)
    if (weakIdxs.length > 1) return null
    if (weakIdxs.length === 1) {
      const i = weakIdxs[0]!
      // Corner order: 0=TL, 1=TR, 2=BR, 3=BL. Opposite pairs: 0↔2, 1↔3.
      // Parallelogram: i = (i+1) + (i-1 mod 4) - ((i+2) mod 4).
      const adj1 = corners[(i + 1) % 4]!
      const adj2 = corners[(i + 3) % 4]!
      const opp = corners[(i + 2) % 4]!
      corners[i] = { x: adj1.x + adj2.x - opp.x, y: adj1.y + adj2.y - opp.y }
      // Replace the weak peak with the mean of the 3 strong ones so the
      // downstream confidence score doesn't penalize an otherwise-good
      // detection for the inferred corner.
      const strongMean =
        peaks.filter((_, j) => j !== i).reduce((a, b) => a + b, 0) / 3
      peaks[i] = strongMean
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

    // Confidence = mean peak (sigmoid output, so already in [0, 1]).
    // Each corner's peak is the model's certainty that *that* specific
    // corner is well-localized; averaging gives an overall detection
    // quality signal usable for ranking frames against each other.
    const confidence = (peaks[0]! + peaks[1]! + peaks[2]! + peaks[3]!) / 4

    return { quad, confidence }
  }

  dispose(): void {
    this.#session?.release()
    this.#session = null
    this.#ready = false
  }
}

/**
 * Argmax location + peak value of a single heatmap channel. The peak is
 * the model's confidence that this corner is localized anywhere in the
 * heatmap (sigmoid → [0, 1]); the argmax pixel is where that localization
 * sits. One pass over the 64×64 array per corner, no threshold tuning
 * needed — the caller decides if `peak` is high enough to trust.
 */
function argmaxCorner(
  data: Float32Array,
  offset: number,
  width: number,
  height: number,
): { x: number; y: number; peak: number } {
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
