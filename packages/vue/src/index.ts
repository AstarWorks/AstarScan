/**
 * @astarworks/scan-vue — Public entry point.
 *
 * ```ts
 * import { useScanner } from '@astarworks/scan-vue'
 * import type { UseScannerReturn, CapturedPage } from '@astarworks/scan-vue'
 * ```
 *
 * For convenience, the commonly-used types from `@astarworks/scan-core`
 * are re-exported here so consumers only need a single dependency.
 *
 * Deep imports (`@astarworks/scan-vue/internal/...`) are not part of the
 * public API.
 */

// Vue-specific types
export type { UseScannerReturn, UseScanCameraReturn } from './types.js'

// Re-export core types for consumer convenience — avoids the need to
// install @astarworks/scan-core separately for type imports.
export type {
  CapturedPage,
  EdgeDetectorBackend,
  PageChangeDetectorBackend,
  PageChangeState,
  PdfExportOptions,
  PdfPageSize,
  PdfQuality,
  Point,
  Quad,
  QualityScorerBackend,
  QualityScoreResult,
  ScanError,
  ScanErrorCode,
  ScanEventHandler,
  ScanEventMap,
  ScanEventName,
  ScanPipeline,
  ScanPipelineOptions,
  ScanState,
  Unsubscribe,
} from '@astarworks/scan-core'
