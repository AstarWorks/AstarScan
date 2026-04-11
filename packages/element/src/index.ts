/**
 * @astarworks/scan-element — Public entry point.
 *
 * Typical usage in plain HTML:
 * ```html
 * <script type="module">
 *   import { defineAstarScanElement } from 'https://scan.astarworks.com/element.js'
 *   defineAstarScanElement()
 * </script>
 * <astar-scan mode="video" lang="ja"></astar-scan>
 * ```
 *
 * Or in a build-tool pipeline:
 * ```ts
 * import { defineAstarScanElement } from '@astarworks/scan-element'
 * defineAstarScanElement('custom-tag-name')  // optional rename
 * ```
 *
 * Implementation note: the actual `customElements.define()` call is
 * intentionally not a top-level side effect — it only runs when
 * `defineAstarScanElement()` is called. This lets build tools tree-shake
 * the element when it is imported only for its types.
 */

/**
 * Register the `<astar-scan>` custom element (or the given tag name).
 * Idempotent: calling twice with the same tag name is a no-op; calling
 * twice with different tag names registers both (Vue supports multiple
 * element classes pointing at the same component).
 *
 * **Not yet implemented**: Phase 1c will wire this up to
 * `defineCustomElement(ScanCameraView)` once the Vue component exists.
 * For now this function is a typed placeholder so consumers can depend
 * on the API shape.
 */
export function defineAstarScanElement(tagName = 'astar-scan'): void {
  // Reference the argument so strict unused-param checks pass until the
  // real implementation lands. Remove when Phase 1c ships the wiring.
  void tagName
  throw new Error(
    'defineAstarScanElement is not yet implemented — ships in Phase 1c',
  )
}

// Element-specific types
export type {
  ScanElementAttributes,
  ScanElementEventDetailMap,
  ScanElementEventName,
  ScanElementMethods,
} from './types.js'

// Re-export commonly-used core + vue types so consumers only need a single
// dependency for TypeScript integration.
export type {
  CapturedPage,
  PdfExportOptions,
  PdfPageSize,
  PdfQuality,
  Point,
  Quad,
  ScanError,
  ScanErrorCode,
  ScanState,
} from '@astarworks/scan-core'
