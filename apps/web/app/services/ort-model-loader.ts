/**
 * ONNX Runtime Web session loader.
 *
 * Centralizes the one-time setup of `onnxruntime-web` (ort) and provides
 * a `loadOrtSession()` that fetches an ONNX model from a URL, creates an
 * `InferenceSession`, and returns it ready for `session.run()`.
 *
 * Callers (DocAlignerBackend, future OCR backend, etc.) each pass a
 * different model URL but share the same ort runtime initialization.
 *
 * Design notes:
 * - WASM execution provider only (no WebGPU). At 5-10 FPS detection our
 *   inference budget is ~100-200ms per frame, which WASM comfortably
 *   meets for sub-20MB models. Avoiding WebGPU keeps us free from
 *   COOP/COEP header requirements and works on all browsers.
 * - `ort.env.wasm.wasmPaths` is set to the CDN hosted by onnxruntime so
 *   we don't have to bundle the ~5MB WASM binary into the Nuxt app.
 * - The session is created with `executionProviders: ['wasm']` explicitly
 *   to avoid ort's default GPU detection (which can fail silently on
 *   some mobile browsers and fall back slowly).
 */

import * as ort from 'onnxruntime-web'

let ortInitialized = false

function ensureOrtInitialized(): void {
  if (ortInitialized) return

  ort.env.wasm.numThreads = 1
  ort.env.wasm.simd = true

  // Use the official CDN for WASM binaries so they're cached by the
  // browser's HTTP cache across sites that use ort. The version must
  // match the npm package version.
  const version = ort.env.versions.web
  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`

  ortInitialized = true
}

/**
 * Fetch an ONNX model from `url` and return a ready-to-use
 * `InferenceSession`. The model bytes are fetched via `fetch()` and
 * handed to ort as an ArrayBuffer — this is the recommended path for
 * browser deployment (vs. passing a URL string, which has CORS issues
 * on some CDNs).
 *
 * The session uses the WASM execution provider with SIMD enabled and
 * a single thread. This is the safest configuration across mobile
 * browsers as of April 2026 — multi-threaded WASM requires
 * SharedArrayBuffer which needs COOP/COEP headers.
 *
 * Throws on network errors, invalid model format, or OOM.
 */
export async function loadOrtSession(
  url: string,
): Promise<ort.InferenceSession> {
  ensureOrtInitialized()

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ONNX model from ${url}: ${response.status} ${response.statusText}`,
    )
  }
  const modelBytes = await response.arrayBuffer()

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
