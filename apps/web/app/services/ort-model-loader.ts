/**
 * ONNX Runtime Web session loader.
 *
 * Centralizes the one-time setup of `onnxruntime-web` (ort) and provides
 * `loadOrtSession()` (WASM) and `loadFastOrtSession()` (WebGPU when the
 * browser has it, else WASM) for the models the app runs.
 *
 * WASM threads: ort runs one WASM thread per core (up to 4) when the page
 * is cross-origin isolated (`crossOriginIsolated`, from the COOP / COEP
 * headers in public/_headers), which SharedArrayBuffer needs. Without
 * isolation (an old browser, a host without the headers) it is one thread.
 *
 * WebGPU: the corner model (DocAligner, 4.8 MB) is tried on the 'webgpu'
 * execution provider first. A browser without WebGPU, or one where the
 * session cannot be created on it, gets the WASM session instead; the
 * backend actually used is returned so the screen can show it (?debug).
 *
 * WASM binaries are self-hosted under /ort/ (scripts/copy-ort-assets.mjs),
 * so the app works offline.
 */

import * as ort from 'onnxruntime-web'

let ortInitialized = false

function ensureOrtInitialized(): void {
  if (ortInitialized) return

  ort.env.wasm.numThreads = wasmThreadCount()
  ort.env.wasm.simd = true

  // Self-hosted WASM binaries (copied by scripts/copy-ort-assets.mjs into
  // public/ort/ at the exact npm package version). The previous jsdelivr
  // CDN path broke the offline-first guarantee: a fresh PWA install with
  // no network could never load the detector.
  ort.env.wasm.wasmPaths = '/ort/'

  ortInitialized = true
}

/** WASM threads ort may use: one per core up to 4 when isolated, else 1. */
export function wasmThreadCount(): number {
  const isolated =
    typeof globalThis.crossOriginIsolated === 'boolean' &&
    globalThis.crossOriginIsolated
  if (!isolated) return 1
  const cores =
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1
  return Math.max(1, Math.min(4, cores))
}

export type OrtBackend = 'webgpu' | 'wasm'

export interface FastOrtSession {
  session: ort.InferenceSession
  backend: OrtBackend
  /** WASM threads (1 on WebGPU: the model runs on the GPU). */
  threads: number
}

async function fetchModel(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ONNX model from ${url}: ${response.status} ${response.statusText}`,
    )
  }
  return response.arrayBuffer()
}

/**
 * Session on WebGPU when the browser offers a GPU adapter and the model
 * loads on it, else on WASM (threaded when isolated). `prefer: 'wasm'`
 * skips WebGPU (?backend=wasm, for measuring both).
 */
export async function loadFastOrtSession(
  url: string,
  prefer: OrtBackend = 'webgpu',
): Promise<FastOrtSession> {
  ensureOrtInitialized()
  const bytes = await fetchModel(url)
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } })
    .gpu
  if (prefer === 'webgpu' && gpu) {
    try {
      const adapter = await gpu.requestAdapter()
      if (adapter) {
        const session = await ort.InferenceSession.create(bytes.slice(0), {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        })
        return { session, backend: 'webgpu', threads: 1 }
      }
    } catch (err) {
      console.warn('[ort] WebGPU session failed, using WASM', err)
    }
  }
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  return { session, backend: 'wasm', threads: ort.env.wasm.numThreads ?? 1 }
}

/**
 * Fetch an ONNX model from `url` and return a ready-to-use
 * `InferenceSession`. The model bytes are fetched via `fetch()` and
 * handed to ort as an ArrayBuffer — this is the recommended path for
 * browser deployment (vs. passing a URL string, which has CORS issues
 * on some CDNs).
 *
 * The session uses the WASM execution provider with SIMD enabled
 * (threads: see `wasmThreadCount`).
 *
 * Throws on network errors, invalid model format, or OOM.
 */
export async function loadOrtSession(
  url: string,
): Promise<ort.InferenceSession> {
  ensureOrtInitialized()

  const modelBytes = await fetchModel(url)

  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })

  return session
}

/**
 * Helper to build a float32 NCHW tensor from an HTMLCanvasElement.
 *
 * Steps:
 * 1. Resize the canvas to `targetSize × targetSize` (square)
 * 2. Extract RGBA pixel data
 * 3. Convert to float32 in [0, 1] range, channel-first layout (NCHW)
 * 4. Optionally apply per-channel mean/std normalization
 *
 * Returns a Tensor ready for `session.run()`.
 */
export function canvasToTensor(
  source: HTMLCanvasElement,
  targetSize: number,
  normalize?: {
    mean: readonly [number, number, number]
    std: readonly [number, number, number]
  },
): ort.Tensor {
  const work = document.createElement('canvas')
  work.width = targetSize
  work.height = targetSize
  const ctx = work.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Failed to create 2D context for tensor conversion')
  ctx.drawImage(source, 0, 0, targetSize, targetSize)
  const imageData = ctx.getImageData(0, 0, targetSize, targetSize)
  const pixels = imageData.data

  const pixelCount = targetSize * targetSize
  const float32 = new Float32Array(3 * pixelCount)

  // RGBA → NCHW float32 with optional normalization
  const meanR = normalize?.mean[0] ?? 0
  const meanG = normalize?.mean[1] ?? 0
  const meanB = normalize?.mean[2] ?? 0
  const stdR = normalize?.std[0] ?? 1
  const stdG = normalize?.std[1] ?? 1
  const stdB = normalize?.std[2] ?? 1

  for (let i = 0; i < pixelCount; i += 1) {
    const r = (pixels[i * 4] ?? 0) / 255
    const g = (pixels[i * 4 + 1] ?? 0) / 255
    const b = (pixels[i * 4 + 2] ?? 0) / 255

    float32[i] = (r - meanR) / stdR // R channel
    float32[pixelCount + i] = (g - meanG) / stdG // G channel
    float32[2 * pixelCount + i] = (b - meanB) / stdB // B channel
  }

  return new ort.Tensor('float32', float32, [1, 3, targetSize, targetSize])
}

export { ort }
