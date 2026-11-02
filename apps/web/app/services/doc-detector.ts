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
import {
  ModelCadence,
  OrientationPicker,
  SpreadPicker,
  boxIou,
  detectPageCorners,
  type CornerRefineResult,
  type PixelBox,
} from '@astarworks/scan-core/pipeline'

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
  /** YOLO only: quad area / model box area (`LiveCaptureJudge` does not
   *  ✓ a frame below `minBoxAgreement`). */
  boxAgreement?: number
  /** YOLO only: the corners were snapped onto the paper edge. */
  refined?: boolean
}

type MlState =
  | { kind: 'uninitialized' }
  | { kind: 'initializing'; promise: Promise<void> }
  | { kind: 'ready'; backend: YoloPoseBackend }
  | { kind: 'unavailable' } // model load failed permanently

let mlState: MlState = { kind: 'uninitialized' }

/** Which way landscape frames are turned for the model (kept across
 *  frames: probes every turn now and then, runs the leader otherwise). */
const picker = new OrientationPicker()

/** Model on every few frames; paper-edge snap in the last box in between
 *  (scan-core `model-cadence.ts`). */
const cadence = new ModelCadence()

/** Which page of an open book to follow (scan-core `spread-pick.ts`). */
const spread = new SpreadPicker()

/** Size of the last tracked (video) frame, to map the followed box onto
 *  a still of another resolution. */
let lastFrameSize: { w: number; h: number } | null = null

/** Candidate of a still that is the page being followed (best overlap
 *  with the followed box scaled to the still), else the best one. */
function followedIn(
  all: readonly { box: PixelBox }[],
  frame: { width: number; height: number },
): number {
  if (!all.length) return -1
  const cur = spread.current
  if (!cur || !lastFrameSize) return 0
  const sx = frame.width / lastFrameSize.w
  const sy = frame.height / lastFrameSize.h
  const want: PixelBox = {
    x0: cur.x0 * sx,
    y0: cur.y0 * sy,
    x1: cur.x1 * sx,
    y1: cur.y1 * sy,
  }
  let best = 0
  let bestIou = -1
  all.forEach((c, i) => {
    const v = boxIou(c.box, want)
    if (v > bestIou) {
      bestIou = v
      best = i
    }
  })
  return best
}

/** A ✓ on the page being followed: move to the other page of a spread. */
export function notifyPageCaptured(): void {
  spread.onCaptured()
}

/** The live judge saw a new picture: after a finished spread, go left. */
export function notifyNewHold(): void {
  spread.onNewHold()
}

/** New scan: forget the followed page. */
export function resetPageTracking(): void {
  spread.reset()
  cadence.reset()
}

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
  opts: {
    /** A still taken at a ✓: crop the page being followed, and leave the
     *  frame-to-frame tracking alone. */
    still?: boolean
  } = {},
): Promise<DocDetection | null> {
  const still = opts.still === true
  if (ENABLE_ML_DETECTOR) {
    await ensureMlBackend()
    if (mlState.kind === 'ready') {
      try {
        // Between model runs: snap onto the paper edge inside the last
        // model box. A failed snap hands the frame to the model.
        const anchor =
          still || spread.wantsModel
            ? null
            : cadence.anchorFor(frame.width, frame.height)
        if (anchor) {
          const snap = refineCorners(
            frame,
            anchor.quad,
            anchor.box,
            anchor.exclude,
          )
          if (snap?.refined) {
            cadence.snapped(snap.quad)
            return {
              quad: snap.quad,
              confidence: anchor.confidence,
              source: 'yolo-pose',
              boxAgreement: snap.boxAgreement,
              refined: true,
            }
          }
          cadence.lost()
        }
        // Model (landscape frames turned per `picker`) → snap the corners,
        // which shrink inside the page, onto the paper edge found inside
        // the model's box (scan-core corner-refine / orientation).
        const backend = mlState.backend
        // Boxes of the pages not chosen in the turn just run; `refine`
        // runs right after `run` for the same turn.
        let others: PixelBox[] = []
        const othersByBox = new Map<PixelBox, PixelBox[]>()
        const found = await detectPageCorners(
          frame,
          async (turn) => {
            const all = await backend.detectAll(frame, turn)
            const i = still
              ? followedIn(all, frame)
              : spread.choose(all, frame.width, frame.height)
            const chosen = all[i]
            if (!chosen) return null
            others = all.filter((_, k) => k !== i).map((c) => c.box)
            othersByBox.set(chosen.box, others)
            return chosen
          },
          (quad, box) => refineCorners(frame, quad, box, others),
          picker,
        )
        const result = found?.detection
        if (still) {
          return found && result && result.confidence >= ML_MIN_CONFIDENCE
            ? {
                quad: found.refine.quad,
                confidence: result.confidence,
                source: 'yolo-pose',
                boxAgreement: found.refine.boxAgreement,
                refined: found.refine.refined,
              }
            : null
        }
        if (found) lastFrameSize = { w: frame.width, h: frame.height }
        if (found && result && result.confidence >= ML_MIN_CONFIDENCE) {
          spread.commit(result.box)
          cadence.modelRan({
            box: result.box,
            quad: found.refine.quad,
            confidence: result.confidence,
            exclude: othersByBox.get(result.box) ?? [],
            frameW: frame.width,
            frameH: frame.height,
          })
          return {
            quad: found.refine.quad,
            confidence: result.confidence,
            source: 'yolo-pose',
            boxAgreement: found.refine.boxAgreement,
            refined: found.refine.refined,
          }
        }
        cadence.modelRan(null)
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

/** Corner snap (scan-core corner-refine), or null when OpenCV is not
 *  loaded or the snap throws — the model's corners are then used as-is. */
function refineCorners(
  frame: HTMLCanvasElement,
  quad: Quad,
  box: PixelBox,
  exclude: readonly PixelBox[] = [],
): CornerRefineResult | null {
  const ops = getPipelineOps()
  if (!ops) return null
  try {
    return ops.refineCorners(
      frame as unknown as Parameters<typeof ops.refineCorners>[0],
      quad,
      box,
      {},
      exclude,
    )
  } catch (err) {
    console.warn('[doc-detector] corner refine threw, using model corners', err)
    return null
  }
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
