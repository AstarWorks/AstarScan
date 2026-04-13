/**
 * @astarworks/scan-core — Public entry point.
 *
 * Consumers should import from this module only:
 *
 * ```ts
 * import type { ScanPipeline, CapturedPage, PdfExportOptions } from '@astarworks/scan-core'
 * ```
 *
 * Deep imports (`@astarworks/scan-core/internal/...`) are not part of the
 * public API and may break in any release.
 */

export type {
  // Geometric primitives
  Point,
  Quad,
  // Pipeline state
  ScanState,
  // Errors
  ScanError,
  ScanErrorCode,
  // Captured data
  CapturedPage,
  // PDF export
  PdfExportOptions,
  PdfPageSize,
  PdfQuality,
  // Backend abstractions
  EdgeDetectorBackend,
  QualityScorerBackend,
  QualityScoreResult,
  PageChangeDetectorBackend,
  PageChangeState,
  DocumentClassifierBackend,
  DocumentClassifierResult,
  // Pipeline
  ScanPipeline,
  ScanPipelineOptions,
  // Events
  ScanEventMap,
  ScanEventName,
  ScanEventHandler,
  Unsubscribe,
} from './types.js'
