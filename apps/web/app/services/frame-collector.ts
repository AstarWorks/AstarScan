/**
 * Browser adapter for `FrameCollector` — the implementation lives in
 * `@astarworks/scan-core` (pipeline/frame-collector.ts), shared with the
 * eval harness. This shim pins the blob type to the DOM `Blob`.
 */

import { FrameCollector as CoreFrameCollector } from '@astarworks/scan-core/pipeline'
import type {
  DetectedFrame as CoreDetectedFrame,
  FrameCluster as CoreFrameCluster,
} from '@astarworks/scan-core/pipeline'

export type DetectedFrame = CoreDetectedFrame<Blob>
export type FrameCluster = CoreFrameCluster<Blob>

export class FrameCollector extends CoreFrameCollector<Blob> {}
