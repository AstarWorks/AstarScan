/**
 * OCR service — browser-based Japanese text extraction.
 *
 * Wraps NDLOCR-Lite Web AI (CC BY 4.0, National Diet Library of Japan)
 * to run layout detection + character recognition entirely in the browser
 * via ONNX Runtime Web + Web Workers.
 *
 * Design:
 * - **Lazy loading**: The 146MB model bundle is NOT fetched on page load.
 *   It's downloaded the first time the user explicitly taps "OCR を実行",
 *   then cached in IndexedDB for subsequent visits.
 * - **Non-blocking**: Inference runs in a Web Worker so the main thread
 *   (camera, UI) stays responsive.
 * - **Japanese-first**: Handles printed Japanese (horizontal + vertical /
 *   tategumi), kanji, hiragana, katakana. Some handwriting support but
 *   accuracy varies.
 *
 * Usage from Vue:
 * ```ts
 * import { initOcr, runOcr, isOcrReady } from '~/services/ocr-service'
 *
 * // First call downloads models (~146MB). Subsequent calls use cache.
 * await initOcr((progress) => console.log(`${progress.percent}%`))
 *
 * // Run OCR on a captured page image
 * const result = await runOcr(capturedPage.dataUrl)
 * console.log(result.text)       // full text
 * console.log(result.lines)      // per-line with bounding boxes
 * ```
 *
 * Implementation note: The actual NDLOCR-Lite Web AI integration details
 * (model URLs, worker setup, ONNX session management) are filled in once
 * the research agent returns with the repo structure. The public API
 * surface below is stable regardless of the internal implementation.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OcrLine {
  /** Recognized text for this line. */
  readonly text: string
  /** Bounding box in the source image's pixel coordinates [x, y, width, height]. */
  readonly bbox: readonly [number, number, number, number]
  /** Confidence score in [0, 1]. */
  readonly confidence: number
}

export interface OcrResult {
  /** Full text, lines joined by newline. Reading order follows the
   * document layout (top-to-bottom for horizontal, right-to-left for
   * vertical / tategumi). */
  readonly text: string
  /** Per-line results with bounding boxes. */
  readonly lines: readonly OcrLine[]
  /** Processing time in milliseconds. */
  readonly durationMs: number
}

export interface OcrProgress {
  /** Current step label (e.g., "モデルダウンロード中", "レイアウト解析中"). */
  readonly stage: string
  /** Overall progress in [0, 100]. */
  readonly percent: number
}

export type OcrProgressCallback = (progress: OcrProgress) => void

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false
let initializing = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the OCR models have been loaded and the service is
 * ready to accept `runOcr()` calls.
 */
export function isOcrReady(): boolean {
  return initialized
}

/**
 * Download and initialize the OCR models. First call fetches ~146MB of
 * ONNX models from the static `/models/ocr/` path; subsequent calls on
 * the same device use the IndexedDB cache and return almost instantly.
 *
 * Call this in response to an explicit user action (e.g., "OCR を実行"
 * button tap) — do NOT call at page load.
 *
 * The `onProgress` callback fires periodically with download and
 * initialization progress so the UI can show a progress bar.
 *
 * Throws on network failure, OOM, or unsupported browser.
 */
export async function initOcr(onProgress?: OcrProgressCallback): Promise<void> {
  if (initialized) return
  if (initializing) {
    // Another initOcr() call is already in flight — wait for it.
    // Simple busy-wait with yielding. In practice this path is rarely
    // hit because the UI disables the button during init.
    while (initializing) {
      await new Promise((r) => setTimeout(r, 100))
    }
    return
  }

  initializing = true
  try {
    onProgress?.({ stage: 'OCR モデル準備中...', percent: 0 })

    // TODO: Replace this placeholder with the actual NDLOCR-Lite Web AI
    // initialization once the integration research completes. The real
    // implementation will:
    // 1. Fetch DEIMv2 layout model (~38MB) + PARSeq recognition models
    //    (~34+35+39MB) from /models/ocr/ or a CDN
    // 2. Cache them in IndexedDB
    // 3. Initialize ONNX Runtime Web sessions in a Web Worker
    // 4. Report progress via onProgress callback

    onProgress?.({ stage: 'OCR モデル準備中...', percent: 50 })

    // Placeholder: simulate initialization delay
    await new Promise((r) => setTimeout(r, 500))

    onProgress?.({ stage: 'OCR 準備完了', percent: 100 })
    initialized = true
  } finally {
    initializing = false
  }
}

/**
 * Run OCR on a single page image. The image should be a perspective-
 * corrected document page (output of `warpPerspective`), not a raw
 * camera frame.
 *
 * @param imageDataUrl - Data URL (JPEG or PNG) of the page image
 * @returns Structured OCR result with full text + per-line bounding boxes
 *
 * Throws if `initOcr()` has not been called or failed.
 */
export async function runOcr(_imageDataUrl: string): Promise<OcrResult> {
  if (!initialized) {
    throw new Error('OCR not initialized — call initOcr() first')
  }

  const startTime = performance.now()

  // TODO: Replace with actual NDLOCR-Lite Web AI inference.
  // The real implementation will:
  // 1. Convert dataUrl → ImageData or HTMLCanvasElement
  // 2. Send to Web Worker for layout detection (DEIMv2)
  // 3. For each detected text region, run character recognition (PARSeq)
  // 4. Sort lines by reading order (horizontal L→R T→B, or vertical R→L T→B)
  // 5. Return structured result

  // Placeholder: return empty result
  const durationMs = performance.now() - startTime

  return {
    text: '(OCR 統合は実装中です)',
    lines: [],
    durationMs,
  }
}

/**
 * Release all OCR resources (ONNX sessions, Web Workers, cached data).
 * Call on page teardown if the OCR service was initialized.
 */
export function disposeOcr(): void {
  // TODO: Release ONNX sessions, terminate Web Workers
  initialized = false
}
