/**
 * @astarworks/scan-vue — Vue-specific type contracts
 *
 * Wraps the imperative `@astarworks/scan-core` API in reactive `Ref`s so
 * Vue components can subscribe to pipeline state via the templating system
 * without manually wiring `on('state', ...)` listeners.
 *
 * Implementation (composables + components) comes later; this file locks
 * the public shape so consumers can rely on it.
 */

import type { Ref } from 'vue'
import type {
  CapturedPage,
  PdfExportOptions,
  Quad,
  ScanError,
  ScanState,
} from '@astarworks/scan-core'

/**
 * Return shape of `useScanner(opts)`. All reactive values are `Readonly<Ref<T>>`
 * to prevent callers from mutating pipeline state directly — mutations go
 * through the exposed methods (`start`, `stop`, `capture`, etc.) which
 * forward to the underlying `ScanPipeline`.
 */
export interface UseScannerReturn {
  /** Current pipeline state, reactive. See `ScanState` for the state machine. */
  readonly state: Readonly<Ref<ScanState>>
  /**
   * All pages captured in this session, in display order. Reactive: Vue
   * components re-render when pages are added, removed, or reordered.
   */
  readonly pages: Readonly<Ref<readonly CapturedPage[]>>
  /** Latest quality score in [0, 1]. Useful for a live quality indicator UI. */
  readonly quality: Readonly<Ref<number>>
  /** The most recent error, or `null` if the pipeline is healthy. */
  readonly error: Readonly<Ref<ScanError | null>>

  /**
   * Attach the pipeline to the given video element and begin processing.
   * The caller is responsible for setting up the `<video>` element with a
   * MediaStream (via `useScanCamera` or manually via `navigator.mediaDevices`).
   */
  start(source: HTMLVideoElement): Promise<void>
  /** Halt frame processing. Safe to call when already stopped. */
  stop(): void
  /**
   * Capture a single page from the current frame. Only meaningful in
   * `manual` mode; in `video` mode pages are emitted automatically.
   */
  capture(): Promise<void>
  /** Remove a page by id. No-op if the id is unknown. */
  deletePage(id: string): void
  /**
   * Replace a page's quad (user manual correction). The pipeline will
   * re-warp the image, regenerate the thumbnail, and recompute the pHash.
   * Rejects with `invalid-quad` on geometrically invalid input.
   */
  updatePageQuad(id: string, quad: Quad): Promise<void>
  /**
   * Assemble the captured pages into a PDF Blob. Call once the session is
   * complete. `opts` may be partial — missing fields take sensible defaults
   * (`mode: 'single'`, `pageSize: 'auto'`, `quality: 0.8`).
   */
  exportPdf(opts?: Partial<PdfExportOptions>): Promise<Blob>
}

/**
 * Return shape of `useScanCamera()`. A thin reactive wrapper around
 * `navigator.mediaDevices.getUserMedia` with the iOS Safari survival kit
 * (WebKit bug #185448 workarounds) built in — see CLAUDE.md for details.
 *
 * The composable is a singleton per page: calling it twice returns the
 * same `stream` ref, preventing multiple `getUserMedia` invocations which
 * would break on iOS.
 */
export interface UseScanCameraReturn {
  /** The active MediaStream, or `null` if not yet requested / released. */
  readonly stream: Readonly<Ref<MediaStream | null>>
  /** The most recent camera error, or `null` if the camera is healthy. */
  readonly error: Readonly<Ref<ScanError | null>>
  /**
   * Request camera access. Must be called from a user-initiated event
   * handler (e.g. a button click) — iOS Safari in standalone mode will
   * reject silent auto-requests at page load.
   */
  requestCamera(): Promise<void>
  /** Stop all tracks and release the MediaStream. */
  releaseCamera(): void
}
