/**
 * OCR service — browser-based Japanese text extraction via NDLOCR-Lite Web AI.
 *
 * Wraps the vendored NDLOCR-Lite worker (CC BY 4.0, National Diet Library)
 * in a promise-based API. The worker runs layout detection (DEIMv2) +
 * character recognition (PARSeq cascade) entirely in a Web Worker thread
 * via ONNX Runtime Web (WASM, single-threaded, no SharedArrayBuffer needed).
 *
 * Model files (~147MB total) are fetched from `/models/ocr/` on first use
 * and cached in IndexedDB. Subsequent OCR calls skip the download.
 *
 * Usage:
 * ```ts
 * await initOcr(progress => console.log(progress.stage))
 * const result = await runOcr(capturedPage.dataUrl)
 * ```
 */

import type {
  WorkerInMessage,
  WorkerOutMessage,
} from '~/lib/ndlocr/types/worker'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OcrLine {
  readonly text: string
  readonly bbox: readonly [number, number, number, number]
  readonly confidence: number
}

export interface OcrResult {
  readonly text: string
  readonly lines: readonly OcrLine[]
  readonly durationMs: number
}

export interface OcrProgress {
  readonly stage: string
  readonly percent: number
}

export type OcrProgressCallback = (progress: OcrProgress) => void

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let initialized = false
let initializing = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isOcrReady(): boolean {
  return initialized
}

export async function initOcr(onProgress?: OcrProgressCallback): Promise<void> {
  if (initialized) return
  if (initializing) {
    while (initializing) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return
  }

  initializing = true
  try {
    onProgress?.({ stage: 'OCR ワーカー起動中...', percent: 0 })

    // Dynamically import the worker using Vite's ?worker syntax.
    // This creates a proper Web Worker from the bundled source.
    const OcrWorkerModule =
      await import('~/lib/ndlocr/worker/ocr.worker.ts?worker')
    worker = new OcrWorkerModule.default() as Worker

    // Wait for the worker to finish initializing (model download + session creation)
    await new Promise<void>((resolve, reject) => {
      if (!worker) {
        reject(new Error('Worker creation failed'))
        return
      }

      const timeoutId = setTimeout(() => {
        reject(new Error('OCR initialization timed out (5 minutes)'))
      }, 300_000)

      worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
        const msg = e.data
        if (msg.type === 'OCR_PROGRESS') {
          const percent = Math.round((msg.progress ?? 0) * 100)
          onProgress?.({
            stage: msg.message ?? msg.stage ?? 'Loading...',
            percent,
          })
          if (msg.stage === 'initialized') {
            clearTimeout(timeoutId)
            resolve()
          }
        } else if (msg.type === 'OCR_ERROR') {
          clearTimeout(timeoutId)
          reject(new Error(msg.error ?? 'OCR initialization error'))
        }
      }

      worker.onerror = (e) => {
        clearTimeout(timeoutId)
        reject(new Error(`Worker error: ${e.message}`))
      }

      // Initialize in mobile/sequential mode (layoutOnly: true means
      // recognition models are lazy-loaded on first OCR_PROCESS, which
      // spreads the download cost more evenly).
      const initMsg: WorkerInMessage = {
        type: 'INITIALIZE',
        layoutOnly: true,
        language: 'ja',
      }
      worker.postMessage(initMsg)
    })

    initialized = true
    onProgress?.({ stage: 'OCR 準備完了', percent: 100 })
  } catch (err) {
    worker?.terminate()
    worker = null
    throw err
  } finally {
    initializing = false
  }
}

export async function runOcr(imageDataUrl: string): Promise<OcrResult> {
  if (!initialized || !worker) {
    throw new Error('OCR not initialized — call initOcr() first')
  }

  const startTime = performance.now()

  // Convert data URL → ImageData
  const imageData = await dataUrlToImageData(imageDataUrl)

  // Send to worker and wait for result
  const result = await new Promise<{
    textBlocks: Array<{
      text: string
      x: number
      y: number
      width: number
      height: number
      confidence: number
    }>
    txt: string
    processingTime: number
  }>((resolve, reject) => {
    if (!worker) {
      reject(new Error('Worker not available'))
      return
    }
    const id = `ocr-${Date.now()}`

    const handler = (e: MessageEvent<WorkerOutMessage>) => {
      const msg = e.data
      // Only handle messages for our request ID
      if ('id' in msg && msg.id !== id) return

      if (msg.type === 'OCR_COMPLETE') {
        worker?.removeEventListener('message', handler)
        resolve({
          textBlocks: msg.textBlocks ?? [],
          txt: msg.txt ?? '',
          processingTime: msg.processingTime ?? 0,
        })
      } else if (msg.type === 'OCR_ERROR') {
        worker?.removeEventListener('message', handler)
        reject(new Error(msg.error ?? 'OCR processing error'))
      }
    }

    worker.addEventListener('message', handler)

    const processMsg: WorkerInMessage = {
      type: 'OCR_PROCESS',
      id,
      imageData,
      startTime,
    }
    // Transfer the ImageData buffer for zero-copy
    worker.postMessage(processMsg, [imageData.data.buffer])
  })

  const durationMs = performance.now() - startTime

  return {
    text: result.txt,
    lines: result.textBlocks.map((block) => ({
      text: block.text,
      bbox: [block.x, block.y, block.width, block.height] as const,
      confidence: block.confidence,
    })),
    durationMs,
  }
}

export function disposeOcr(): void {
  worker?.terminate()
  worker = null
  initialized = false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Failed to load image from data URL'))
    el.src = dataUrl
  })

  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Failed to create canvas context')
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, img.width, img.height)
}
