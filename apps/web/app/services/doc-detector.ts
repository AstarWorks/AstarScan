/**
 * Document detector — YOLOv8n-pose primary, OpenCV load-failure fallback.
 *
 * The fine-tuned YOLOv8n-pose model at
 * `apps/web/public/models/doc-corners.onnx` (training pipeline:
 * `docs/training-doc-corners.md`) is the primary detector. The ML path
 * lazy-loads on first use; OpenCV takes over ONLY if the model fails to
 * load (`unavailable` state). Set `VITE_DISABLE_ML_DETECTOR=1` at build
 * time to force OpenCV-only (rollback switch).
 *
 * IMPORTANT — low-confidence frames are SKIPPED, not handed to OpenCV.
 * Mixing detectors mid-scan is worse than dropping a frame:
 *   - OpenCV's Otsu path has a measured whole-frame failure mode
 *     (median areaFrac 0.86 = page + desk in one quad; identity-GT
 *     recall 0.36 on mp4-1 vs YOLO's 0.64).
 *   - A single OpenCV quad in a YOLO track destroys the hash continuity
 *     the dedup layers depend on.
 *
 * Why YOLO over OpenCV:
 *   - OpenCV Otsu+minAreaRect "detects" almost every frame but routinely
 *     grabs the whole bright region, and produces no confidence signal.
 *   - YOLOv8n-pose gives accurate keypoint regression *and* a per-corner
 *     visibility flag, with confidence for gating.
 *   - DocAligner LCNet/FastViT (the prior ML attempt) hit 11-13 %
 *     because it was trained on landscape document photos, not handheld
 *     portrait phone footage. Its code is gone now; YoloPoseBackend
 *     replaces it.
 *
 * OpenCV implementation note: handheld phone footage of A4 pages on a
 * wooden desk is high contrast between paper (bright) and background
 * (dark). Edge-based detectors (Canny + approxPolyDP) choke on hand
 * occlusion, partial-page overlap, and slightly curved paper edges.
 * Brightness (Otsu threshold) + morphology + minAreaRect is what
 * survives handheld reality; it returns a rotated rectangle regardless
 * of contour irregularity, and `minAreaRect` always gives 4 vertices.
 */

import type { Quad } from '@astarworks/scan-core'

import { loadOpenCV } from './opencv-loader'
import { getPipelineOps } from './pipeline-ops'
import { YoloPoseBackend } from './yolo-pose-backend'

/** Gate for the ML primary path. On by default (trained ONNX ships at
 *  `apps/web/public/models/doc-corners.onnx`); build with
 *  `VITE_DISABLE_ML_DETECTOR=1` to roll back to OpenCV-only. */
const ENABLE_ML_DETECTOR =
  (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_DISABLE_ML_DETECTOR !== '1'

/** Skip frames whose ML detection confidence is below this (frame is
 *  dropped — NOT handed to OpenCV; see module docs). 0.25 matches YOLO's
 *  standard inference threshold. */
const ML_MIN_CONFIDENCE = 0.25

export interface DocDetection {
  quad: Quad
  /** [0, 1]. YOLOv8 (when active): class confidence. OpenCV: 1.0. */
  confidence: number
  source: 'yolo-pose' | 'opencv'
}

type MlState =
  | { kind: 'uninitialized' }
  | { kind: 'initializing'; promise: Promise<void> }
  | { kind: 'ready'; backend: YoloPoseBackend }
  | { kind: 'unavailable' } // model load failed permanently

let mlState: MlState = { kind: 'uninitialized' }

async function ensureMlBackend(): Promise<void> {
  if (!ENABLE_ML_DETECTOR) return
  if (mlState.kind === 'ready' || mlState.kind === 'unavailable') return
  if (mlState.kind === 'initializing') return mlState.promise

  const backend = new YoloPoseBackend()
  const promise = backend
    .warmUp()
    .then(() => {
      mlState = { kind: 'ready', backend }
    })
    .catch((err) => {
      console.warn(
        '[doc-detector] YOLOv8-pose model load failed, OpenCV-only',
        err,
      )
      mlState = { kind: 'unavailable' }
    })
  mlState = { kind: 'initializing', promise }
  return promise
}

/**
 * Detect the document in `frame`. Returns null if no plausible page is
 * found. When ML is enabled and the detection is confident, returns its
 * keypoints; otherwise falls back to OpenCV.
 */
export async function detectDocument(
  frame: HTMLCanvasElement,
): Promise<DocDetection | null> {
  if (ENABLE_ML_DETECTOR) {
    await ensureMlBackend()
    if (mlState.kind === 'ready') {
      try {
        const result = await mlState.backend.detect(frame)
        if (result && result.confidence >= ML_MIN_CONFIDENCE) {
          return {
            quad: result.quad,
            confidence: result.confidence,
            source: 'yolo-pose',
          }
        }
        // Low confidence or no detection: skip the frame. Falling through
        // to OpenCV here would inject whole-frame quads into a YOLO track
        // and break hash continuity (see module docs).
        return null
      } catch (err) {
        console.warn('[doc-detector] ML inference threw, skipping frame', err)
        return null
      }
    }
    // mlState 'unavailable' (model load failed) falls through to OpenCV.
  }
  const quad = detectWithOpenCV(frame)
  return quad ? { quad, confidence: 1.0, source: 'opencv' } : null
}

export function getDetectorSource(): 'yolo-pose' | 'opencv' | 'pending' {
  if (mlState.kind === 'ready') return 'yolo-pose'
  if (ENABLE_ML_DETECTOR && mlState.kind !== 'unavailable') return 'pending'
  return 'opencv'
}

// ---------------------------------------------------------------------------
// OpenCV fallback (Otsu + morphology + minAreaRect) — implementation is
// unified in @astarworks/scan-core (pipeline/detect-otsu.ts), bound to the
// browser runtime via pipeline-ops.
// ---------------------------------------------------------------------------

function detectWithOpenCV(frame: HTMLCanvasElement): Quad | null {
  const ops = getPipelineOps()
  if (!ops) return null
  return ops.detectWithOpenCV(
    frame as unknown as Parameters<typeof ops.detectWithOpenCV>[0],
  )
}

/**
 * Ensure OpenCV is available — called by index.vue before starting the
 * pipeline. OpenCV is needed for detection, warpPerspective, Laplacian
 * (sharpness) and Sobel (Tenengrad).
 */
export async function ensureDocDetector(): Promise<void> {
  await loadOpenCV()
}
