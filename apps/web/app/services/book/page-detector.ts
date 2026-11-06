/**
 * Paper corners with DocAligner (DocsaidLab, Apache-2.0; lcnet100 heatmap
 * model, 256×256, 4.8 MB) — the same model and the same steps as the
 * Android capture screen (CaptureDetector.kt), chosen there by measuring
 * it against OpenCV contours and a paper-colour mask on the book clips
 * (scripts/eval/book-clips/corner-compare.py).
 *
 * Steps (as CaptureDetector.kt / corner-compare.py): the picture is padded
 * to a square (black), optionally widened by `pad` on every side with its
 * edge pixels repeated outward (desk carried on), scaled to 256×256, BGR /
 * 255, NCHW. Each corner is the arg-max of its heatmap channel, refined to
 * the weighted centroid of the 5×5 cells around it; `peaks` says how sure
 * the model is of each corner (a corner under MIN_PEAK is not taken).
 *
 * The model file comes from scripts/android/fetch-docaligner.sh (pinned
 * SHA-256), run by scripts/fetch-public-assets.sh into public/models/.
 */

import type { Quad } from '@astarworks/scan-core'

import {
  loadFastOrtSession,
  ort,
  type FastOrtSession,
  type OrtBackend,
} from '../ort-model-loader'

export const DOCALIGNER_URL = '/models/docaligner-lcnet100.onnx'
const SIZE = 256
/** A corner the model is less sure of than this is not taken (CaptureDetector.MIN_PEAK). */
export const MIN_PEAK = 0.3
/** Second try's margin when the paper fills the picture (CaptureDetector.CONTEXT_PAD). */
export const CONTEXT_PAD = 0.15

export interface PageDetection {
  /** Corners in the source picture's pixels. */
  quad: Quad
  peaks: [number, number, number, number]
  minPeak: number
  /** Model time of this call (ms). */
  inferMs: number
}

type Source = HTMLVideoElement | HTMLCanvasElement | ImageBitmap

function sourceSize(src: Source): { w: number; h: number } {
  if (src instanceof HTMLVideoElement)
    return { w: src.videoWidth, h: src.videoHeight }
  return { w: src.width, h: src.height }
}

/** Corners in clockwise order from the top-left (Quad.ordered in Kotlin). */
export function orderCorners(xs: number[], ys: number[]): Quad {
  const pts = xs.map((x, i) => ({ x, y: ys[i]! }))
  const cx = pts.reduce((a, p) => a + p.x, 0) / 4
  const cy = pts.reduce((a, p) => a + p.y, 0) / 4
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  )
  // atan2 order from −π: tl (−3π/4) tr (−π/4) br (π/4) bl (3π/4).
  let start = 0
  let best = Infinity
  sorted.forEach((p, i) => {
    const s = p.x + p.y
    if (s < best) {
      best = s
      start = i
    }
  })
  const at = (k: number) => sorted[(start + k) % 4]!
  return { tl: at(0), tr: at(1), br: at(2), bl: at(3) }
}

export class PageDetector {
  #s: FastOrtSession | null = null
  #square: HTMLCanvasElement
  #ctx: CanvasRenderingContext2D
  #input = new Float32Array(3 * SIZE * SIZE)
  #busy = false

  constructor() {
    this.#square = document.createElement('canvas')
    this.#square.width = SIZE
    this.#square.height = SIZE
    const ctx = this.#square.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('canvas 2d unavailable')
    this.#ctx = ctx
  }

  get backend(): OrtBackend | null {
    return this.#s?.backend ?? null
  }

  get threads(): number {
    return this.#s?.threads ?? 0
  }

  async load(prefer: OrtBackend = 'webgpu'): Promise<void> {
    if (this.#s) return
    this.#s = await loadFastOrtSession(DOCALIGNER_URL, prefer)
  }

  /** Corners of the paper in `src`, or null when the model is busy / not loaded. */
  async detect(src: Source, pad = 0): Promise<PageDetection | null> {
    const s = this.#s
    if (!s || this.#busy) return null
    const { w, h } = sourceSize(src)
    if (w === 0 || h === 0) return null
    this.#busy = true
    try {
      const pw = w * pad
      const ph = h * pad
      const side = Math.max(w + 2 * pw, h + 2 * ph)
      const scale = SIZE / side
      const ox = (side - w) / 2
      const oy = (side - h) / 2
      const ctx = this.#ctx
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, SIZE, SIZE)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'medium'
      const x0 = ox * scale
      const y0 = oy * scale
      const dw = w * scale
      const dh = h * scale
      ctx.drawImage(src, 0, 0, w, h, x0, y0, dw, dh)
      if (pad > 0) {
        // Edge rows / columns stretched over the margins (BORDER_REPLICATE).
        const l = (ox - pw) * scale
        const t = (oy - ph) * scale
        const r = (ox + w + pw) * scale
        const b = (oy + h + ph) * scale
        const put = (
          sx: number,
          sy: number,
          sw: number,
          sh: number,
          dx0: number,
          dy0: number,
          dx1: number,
          dy1: number,
        ) => ctx.drawImage(src, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0)
        put(0, 0, 1, h, l, y0, x0, y0 + dh)
        put(w - 1, 0, 1, h, x0 + dw, y0, r, y0 + dh)
        put(0, 0, w, 1, x0, t, x0 + dw, y0)
        put(0, h - 1, w, 1, x0, y0 + dh, x0 + dw, b)
        put(0, 0, 1, 1, l, t, x0, y0)
        put(w - 1, 0, 1, 1, x0 + dw, t, r, y0)
        put(w - 1, h - 1, 1, 1, x0 + dw, y0 + dh, r, b)
        put(0, h - 1, 1, 1, l, y0 + dh, x0, b)
      }
      const px = ctx.getImageData(0, 0, SIZE, SIZE).data
      const plane = SIZE * SIZE
      const input = this.#input
      for (let i = 0; i < plane; i++) {
        input[i] = px[i * 4 + 2]! / 255 // B
        input[plane + i] = px[i * 4 + 1]! / 255 // G
        input[2 * plane + i] = px[i * 4]! / 255 // R
      }
      const tensor = new ort.Tensor('float32', input, [1, 3, SIZE, SIZE])
      const t0 = performance.now()
      const out = await s.session.run({ [s.session.inputNames[0]!]: tensor })
      const inferMs = performance.now() - t0
      const hmT = out[s.session.outputNames[0]!]!
      const [, , gh, gw] = hmT.dims as number[]
      const hm = (await hmT.getData()) as Float32Array
      const xs: number[] = []
      const ys: number[] = []
      const peaks: number[] = []
      for (let k = 0; k < 4; k++) {
        const off = k * gh! * gw!
        let best = off
        for (let i = off; i < off + gh! * gw!; i++)
          if (hm[i]! > hm[best]!) best = i
        const by = Math.floor((best - off) / gw!)
        const bx = (best - off) % gw!
        peaks.push(hm[best]!)
        let sw = 0
        let sx = 0
        let sy = 0
        for (
          let yy = Math.max(0, by - 2);
          yy <= Math.min(gh! - 1, by + 2);
          yy++
        )
          for (
            let xx = Math.max(0, bx - 2);
            xx <= Math.min(gw! - 1, bx + 2);
            xx++
          ) {
            const v = Math.max(0, hm[off + yy * gw! + xx]!)
            sw += v
            sx += v * xx
            sy += v * yy
          }
        const cx = sw > 1e-6 ? sx / sw : bx
        const cy = sw > 1e-6 ? sy / sw : by
        xs.push(((cx + 0.5) * side) / gw! - ox)
        ys.push(((cy + 0.5) * side) / gh! - oy)
      }
      tensor.dispose()
      hmT.dispose()
      const p = peaks as [number, number, number, number]
      return {
        quad: orderCorners(xs, ys),
        peaks: p,
        minPeak: Math.min(...p),
        inferMs,
      }
    } finally {
      this.#busy = false
    }
  }
}
