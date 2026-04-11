/**
 * Workspace dependency smoke test.
 *
 * If this file fails to type-check, the monorepo dependency chain
 * (`apps/web` → `@astarworks/scan-vue` → `@astarworks/scan-core`) is broken.
 *
 * This is a `.ts` file rather than a `<script lang="ts">` block in a `.vue`
 * file because plain `tsc --noEmit` does not parse SFCs, and we want the
 * typecheck script to have at least one real file to verify. The full
 * `.vue` type check happens implicitly during `nuxt generate` / `nuxt build`
 * via `@vitejs/plugin-vue`.
 *
 * Delete or replace this file in Phase 1a once there are real consumers of
 * the workspace types in `apps/web`.
 */

import type {
  CapturedPage,
  PdfExportOptions,
  Quad,
  ScanError,
  ScanState,
  UseScanCameraReturn,
  UseScannerReturn,
} from '@astarworks/scan-vue'

/**
 * Aggregated smoke-test type. Referencing it ensures every imported symbol
 * contributes to the type graph and cannot be silently elided.
 */
export interface WorkspaceSmoke {
  readonly scanner: UseScannerReturn
  readonly camera: UseScanCameraReturn
  readonly page: CapturedPage
  readonly quad: Quad
  readonly state: ScanState
  readonly pdfOptions: PdfExportOptions
  readonly error: ScanError | null
}
