/**
 * @astarworks/scan-core — Public API type contracts
 *
 * This file is the single source of truth for the AstarScan public API.
 * All implementations (`ScanPipeline`, `JscanifyBackend`, etc.) must conform
 * to the types defined here. Framework adapters (`scan-vue`, `scan-element`)
 * re-export these types for their consumers.
 *
 * See /home/node/.claude/plans/woolly-imagining-balloon.md for design rationale.
 */

// ---------------------------------------------------------------------------
// Geometric primitives
// ---------------------------------------------------------------------------

/**
 * A point in pixel coordinates, measured from the top-left of the source
 * frame (y-axis points down, matching HTMLCanvasElement / ImageData).
 */
export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * A convex quadrilateral described by its four corners in clockwise order
 * starting from the top-left. Coordinates are in source-frame pixels
 * (see `CapturedPage.width` / `CapturedPage.height` for the reference frame).
 *
 * Consumers that need normalized [0,1] coordinates must divide by the source
 * frame dimensions themselves — the library always uses pixels internally
 * to avoid double conversions.
 */
export interface Quad {
  readonly tl: Point
  readonly tr: Point
  readonly br: Point
  readonly bl: Point
}

// ---------------------------------------------------------------------------
// Pipeline state machine
// ---------------------------------------------------------------------------

/**
 * The high-level state of a `ScanPipeline` instance.
 *
 * - `idle`: Pipeline has not started, or is stopped. In video mode this also
 *   includes the low-power monitoring phase (5 FPS sampling) where no pages
 *   are being actively captured.
 * - `active`: Pipeline is processing frames at the configured FPS. For video
 *   mode, this is entered on motion detection (up to 10-15 FPS).
 * - `capturing`: A stable frame has been detected and the capture step
 *   (quality scoring, edge detection, perspective warp) is running.
 * - `review`: The pipeline has produced one or more `CapturedPage`s and is
 *   awaiting user review / export. The user may still go back to `idle` to
 *   scan more pages.
 * - `error`: A recoverable error occurred. The pipeline is paused but may
 *   be resumed via `start()` after the caller handles the error.
 */
export type ScanState = 'idle' | 'active' | 'capturing' | 'review' | 'error'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Enumeration of all error conditions the pipeline may raise. Callers should
 * `switch` on `error.code` and display a localized message — the library
 * itself never emits human-readable strings (i18n is a caller concern).
 */
export type ScanErrorCode =
  | 'camera-permission-denied'
  | 'camera-not-ready'
  | 'camera-device-lost'
  | 'camera-not-readable'
  | 'wasm-init-failed'
  | 'edge-detector-not-ready'
  | 'pdf-export-failed'
  | 'page-limit-exceeded'
  | 'ios-standalone-camera-lost'
  | 'invalid-quad'
  | 'pipeline-not-started'
  | 'pipeline-already-started'

export interface ScanError {
  readonly code: ScanErrorCode
  /**
   * If `true`, calling the failed operation again (after the user addresses
   * the underlying condition) is expected to succeed. If `false`, the error
   * is terminal and the pipeline must be destroyed and recreated.
   */
  readonly retriable: boolean
  /** The underlying cause, when available (e.g. a caught `DOMException`). */
  readonly cause?: unknown
}

// ---------------------------------------------------------------------------
// Captured data
// ---------------------------------------------------------------------------

/**
 * A single page extracted from the camera stream. Pages are immutable once
 * created — to modify a page (e.g. adjust the quad via manual correction),
 * call `ScanPipeline.updatePageQuad()` which produces a new `CapturedPage`
 * and replaces the old one in the session.
 */
export interface CapturedPage {
  /** Stable UUID v4 assigned at capture time. */
  readonly id: string
  /**
   * The perspective-corrected page as a JPEG blob. This is the authoritative
   * image used for PDF export and thumbnail regeneration.
   */
  readonly imageBlob: Blob
  /** Small data URL (200×280) suitable for Review grid display. */
  readonly thumbnail: string
  /** The 4 corner points in the source frame's pixel coordinates. */
  readonly quad: Quad
  /** 64-bit perceptual hash as a hex string (16 characters). */
  readonly phash: string
  readonly capturedAt: Date
  /**
   * Aggregate quality score in [0, 1]. Higher is better. Combines the
   * blur, glare, and occlusion sub-scores via the `QualityScorerBackend`.
   */
  readonly qualityScore: number
  /** Source frame width in pixels (the reference for `quad` coordinates). */
  readonly width: number
  /** Source frame height in pixels. */
  readonly height: number
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

/**
 * PDF page size. `'auto'` uses each page's native aspect ratio (the page
 * size is derived from the image dimensions, preserving orientation).
 */
export type PdfPageSize = 'A4' | 'Letter' | 'auto'

/**
 * JPEG quality level for embedded page images. Three discrete values keep
 * the API small and predictable; callers needing arbitrary quality can
 * compose their own export flow using the raw `CapturedPage.imageBlob`s.
 */
export type PdfQuality = 0.6 | 0.8 | 0.95

export interface PdfExportOptions {
  /**
   * - `single`: One PDF containing all pages in order. Returns a single Blob.
   * - `split`: Each page becomes its own PDF. Returns a zipped Blob.
   * - `batch`: Pages are grouped into chunks of `batchSize`, each chunk
   *   becoming one PDF. Returns a zipped Blob.
   */
  readonly mode: 'single' | 'split' | 'batch'
  /** Required when `mode === 'batch'`. Must be ≥ 1. */
  readonly batchSize?: number
  readonly pageSize: PdfPageSize
  readonly quality: PdfQuality
}

// ---------------------------------------------------------------------------
// Backend abstractions (pluggable pipeline stages)
// ---------------------------------------------------------------------------

/**
 * Quality sub-scores for a single frame. All values are in [0, 1] where
 * higher means better. The `overall` score is a weighted combination
 * intended to feed the "best frame in stable window" selection.
 */
export interface QualityScoreResult {
  readonly overall: number
  readonly blur: number
  readonly glare: number
  readonly occlusion: number
}

/**
 * Pluggable backend for scoring frame quality (blur, glare, obstruction).
 * The default Phase 1 implementation uses classical CV (Laplacian variance
 * for blur, HSV thresholding for glare); Phase 2 may swap in an ONNX model.
 */
export interface QualityScorerBackend {
  readonly name: string
  score(frame: ImageData): Promise<QualityScoreResult>
}

/**
 * The instantaneous state of the page-change detector. The detector runs
 * on every sampled frame and drives the pipeline's low-FPS / high-FPS
 * adaptive sampling.
 */
export type PageChangeState = 'stable' | 'moving' | 'unknown'

/**
 * Pluggable backend that classifies consecutive frames as stable or moving.
 * The Phase 1 implementation uses frame-difference thresholding; Phase 2
 * may add optical flow or a tiny CNN.
 *
 * Implementations are stateful (they hold prior frame(s) for comparison).
 * Callers must call `reset()` between sessions.
 */
export interface PageChangeDetectorBackend {
  readonly name: string
  process(frame: ImageData): PageChangeState
  reset(): void
}

/**
 * Pluggable backend for document-corner detection. Phase 1 ships with
 * `JscanifyBackend` (OpenCV.js Canny + contour); Phase 2 adds
 * `DocAlignerBackend` (ONNX Runtime Web). The `EdgeDetector` composite
 * chains multiple backends for fallback behavior.
 */
export interface EdgeDetectorBackend {
  readonly name: string
  /** `true` once `warmUp()` has completed successfully. */
  readonly ready: boolean
  /**
   * Perform any one-time initialization (loading WASM, ONNX model, etc.).
   * Must be safe to call multiple times; subsequent calls should be no-ops.
   * Rejects with a `ScanError` on initialization failure.
   */
  warmUp(): Promise<void>
  /**
   * Detect a document quadrilateral in the frame. Resolves to `null` if
   * no confident detection was found (the caller should not treat this as
   * an error — it simply means the next frame should be tried).
   *
   * Takes an `HTMLCanvasElement` rather than `ImageData` so callers can
   * hand the live preview canvas directly without an extra
   * `getImageData` round-trip, and so backends that wrap OpenCV.js can
   * `cv.imread(canvas)` natively.
   */
  detect(frame: HTMLCanvasElement): Promise<Quad | null>
  /**
   * Release any held resources (WASM heap, ONNX session, etc.). The backend
   * becomes unusable after this call.
   */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Pipeline construction options
// ---------------------------------------------------------------------------

export interface ScanPipelineOptions {
  /**
   * - `manual`: Frames are captured only when the caller invokes `capture()`.
   *   Used for tap-to-capture UIs.
   * - `video`: The pipeline continuously analyzes the camera stream and
   *   emits `CapturedPage`s automatically as stable frames are detected.
   */
  readonly mode: 'manual' | 'video'
  /**
   * Target processing frame rate. In video mode the pipeline adapts:
   * idle ≈ `fps / 2`, active = `fps`, up to ~15 FPS maximum regardless.
   * Default: `10`.
   */
  readonly fps?: number
  /**
   * Hamming distance threshold for pHash duplicate detection. Two pages are
   * considered duplicates when their 64-bit pHashes differ by ≤ this many
   * bits. Default: `8`. Range: `0` (identical required) – `32` (very loose).
   */
  readonly duplicateThreshold?: number
  /**
   * Minimum Laplacian variance required to accept a frame. Frames below
   * this threshold are rejected as blurry. Default: `100`. Tune per device.
   */
  readonly blurThreshold?: number
  /**
   * Ordered list of edge-detection backends. The pipeline tries each in
   * order and uses the first non-null detection. Default: `[JscanifyBackend]`.
   */
  readonly edgeBackends?: readonly EdgeDetectorBackend[]
  /** Custom quality scorer. Default: classical CV (Laplacian + HSV). */
  readonly qualityScorer?: QualityScorerBackend
  /** Custom page-change detector. Default: frame-difference classifier. */
  readonly pageChangeDetector?: PageChangeDetectorBackend
  /**
   * Maximum pages per session. Attempting to capture beyond this count
   * raises a `page-limit-exceeded` error. Default: `200`.
   */
  readonly maxPages?: number
}

// ---------------------------------------------------------------------------
// Event system
// ---------------------------------------------------------------------------

/**
 * Mapping from event name to payload type. Used by `ScanPipeline.on()` to
 * produce typed callbacks without method overloads.
 */
export interface ScanEventMap {
  readonly state: ScanState
  readonly page: CapturedPage
  readonly quality: number
  readonly error: ScanError
}

export type ScanEventName = keyof ScanEventMap

export type ScanEventHandler<E extends ScanEventName> = (
  payload: ScanEventMap[E],
) => void

/** Returned by `ScanPipeline.on()` — call to remove the listener. */
export type Unsubscribe = () => void

// ---------------------------------------------------------------------------
// Main pipeline interface
// ---------------------------------------------------------------------------

/**
 * The top-level scanning pipeline. This is the imperative, framework-agnostic
 * API that all higher-level adapters (`scan-vue`, `scan-element`) wrap.
 *
 * Lifecycle:
 *   1. `new ScanPipeline(opts)` — constructs but does not start any work.
 *      Backends are lazily warmed up on first `start()`.
 *   2. `await pipeline.start(videoEl)` — begins frame processing.
 *   3. In `manual` mode, call `capture()` to extract a page.
 *      In `video` mode, pages are emitted via the `page` event.
 *   4. Call `exportPdf(opts)` to produce the final Blob.
 *   5. Call `destroy()` to release resources.
 *
 * `ScanPipeline` is not safe to use after `destroy()`. Create a new instance
 * for each session.
 */
export interface ScanPipeline {
  readonly state: ScanState
  readonly options: Readonly<ScanPipelineOptions>

  /**
   * Begin processing frames from the given source. Warms up backends on
   * first call. Calling `start()` while already running rejects with
   * `pipeline-already-started`.
   */
  start(source: HTMLVideoElement | MediaStream): Promise<void>
  /** Halt frame processing. Safe to call multiple times; no-op when idle. */
  stop(): void
  /**
   * Capture a single page from the current frame (manual mode).
   * In video mode this is a no-op that rejects.
   */
  capture(): Promise<CapturedPage>
  /** Snapshot of all pages captured in this session, in display order. */
  getPages(): readonly CapturedPage[]
  /** Remove a page by its id. Safe no-op if the id is unknown. */
  deletePage(id: string): void
  /**
   * Reorder pages to match the given id sequence. The sequence must contain
   * exactly the same ids as `getPages()` — any mismatch is a no-op.
   */
  reorderPages(ids: readonly string[]): void
  /**
   * Replace the quad of an existing page (user manual correction) and
   * regenerate the perspective-warped image + thumbnail + pHash.
   * Rejects with `invalid-quad` if the quad is self-intersecting, concave,
   * or has area less than 10% of the source frame.
   */
  updatePageQuad(id: string, quad: Quad): Promise<void>
  /**
   * Assemble the captured pages into a PDF (or zip of PDFs) according to
   * `opts.mode`. Does not modify or delete the underlying pages.
   */
  exportPdf(opts: PdfExportOptions): Promise<Blob>
  /** Release all resources. The pipeline becomes unusable afterwards. */
  destroy(): void

  /**
   * Subscribe to a pipeline event. Returns a function that removes the
   * listener when called. See `ScanEventMap` for the available events.
   */
  on<E extends ScanEventName>(event: E, cb: ScanEventHandler<E>): Unsubscribe
}
