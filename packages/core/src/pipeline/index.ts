/**
 * @astarworks/scan-core/pipeline — shared scan-pipeline implementation.
 *
 * Pure modules (hash, score, clustering, …) are exported directly.
 * OpenCV-dependent modules are factories composed by `createPipelineOps`,
 * which takes the runtime's OpenCV instance and canvas factory — see
 * `deps.ts` for the injection contract.
 */

export * from './deps.js'
export * from './constants.js'
export * from './hash.js'
export * from './score.js'
export * from './text-similarity.js'
export * from './quad-smoother.js'
export * from './frame-collector.js'
export * from './cv-canvas.js'
export * from './sharpness.js'
export * from './warp.js'
export * from './detect-otsu.js'
export * from './orb.js'
export * from './segment-cluster.js'
export * from './cluster-repair.js'
export * from './quad-edit.js'
export * from './yolo-decode.js'

import type { PipelineDeps } from './deps.js'
import { createHashOps } from './hash.js'
import { createSharpnessOps } from './sharpness.js'
import { createWarpOps } from './warp.js'
import { createOtsuDetector } from './detect-otsu.js'
import { createOrbOps } from './orb.js'

/** Compose every cv/canvas-dependent op set in one call. */
export function createPipelineOps(deps: PipelineDeps) {
  return {
    ...createHashOps(deps.createCanvas),
    ...createSharpnessOps(deps),
    ...createWarpOps(deps),
    ...createOtsuDetector(deps),
    ...createOrbOps(deps),
  }
}

export type PipelineOps = ReturnType<typeof createPipelineOps>
