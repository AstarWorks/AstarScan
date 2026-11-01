/**
 * `YoloPoseBackend` — ONNX-powered document corner detection via a
 * fine-tuned YOLOv8n-pose model (4 keypoints: TL, TR, BR, BL).
 *
 * The fine-tuning pipeline lives in `docs/training-doc-corners.md`. The
 * resulting `apps/web/public/models/doc-corners.onnx` (~6 MB) is
 * .gitignored — generate it once locally and ship via CDN later.
 *
 * Why YOLOv8n-pose: same problem shape as MediaPipe Hands (independent
 * keypoint regression) which is the standard architecture for landmark
 * detection on edge. Off-the-shelf 6-MB ONNX, runs at 5-15 ms in
 * onnxruntime-web (WASM-SIMD), one keypoint per corner with a per-corner
 * visibility flag for occlusion handling.
 *
 * ONNX I/O contract (Ultralytics export, imgsz=640, 1 class, 4 kpt):
 *   Input:  "images", float32 (1, 3, 640, 640), letterbox-resized [0,1]
 *   Output: tensor of shape (1, 17, 8400) where the 17 channels are:
 *     0..3   cx, cy, w, h  (pixel space, 0..640)
 *     4      class confidence (sigmoid output)
 *     5,6,7  kpt0 x, y, visibility
 *     8,9,10 kpt1
 *     11..13 kpt2
 *     14..16 kpt3
 *   8400 anchors = 80×80 + 40×40 + 20×20 (P3/P4/P5 detection heads).
 *
 * We expect one document per frame so post-processing reduces to argmax
 * over class confidence — no NMS needed.
 */

import type { Quad } from '@astarworks/scan-core'
import {
  YOLO_INPUT_SIZE,
  decodeYoloOutput,
  letterboxToFloat32,
  type CanvasLike,
  type FrameTurn,
  type PixelBox,
} from '@astarworks/scan-core/pipeline'
import type * as ort from 'onnxruntime-web'

import { loadOrtSession, ort as ortRuntime } from './ort-model-loader'
import { browserCreateCanvas } from './pipeline-ops'

const MODEL_URL = '/models/doc-corners.onnx'

export interface YoloPoseDetection {
  quad: Quad
  /** The model's box in frame pixels (closer to the page than `quad`). */
  box: PixelBox
  /** Class confidence in [0, 1] from the winning anchor. */
  confidence: number
  /** Per-corner visibility (sigmoid) in [0, 1]; ≤ 0.3 means the model
   *  thinks that corner was occluded / off-frame. Useful for downstream
   *  scoring or for refusing low-trust detections. */
  visibility: [number, number, number, number]
}

export class YoloPoseBackend {
  readonly name = 'yolo-pose'

  #session: ort.InferenceSession | null = null
  #ready = false

  get ready(): boolean {
    return this.#ready
  }

  async warmUp(): Promise<void> {
    if (this.#ready && this.#session) return
    this.#session = await loadOrtSession(MODEL_URL)
    this.#ready = true
  }

  /**
   * Run the model on `frame`, turned 90° first when `turn` is 'cw' / 'ccw'
   * and the frame is landscape (the model was trained on portrait frames
   * only; see scan-core `orientation.ts`). Points come back in `frame`
   * pixels either way.
   */
  async detect(
    frame: HTMLCanvasElement,
    turn: FrameTurn = 'none',
  ): Promise<YoloPoseDetection | null> {
    const session = this.#session
    if (!session || !this.#ready) {
      throw new Error('YoloPoseBackend.warmUp() must be called before detect()')
    }

    // Letterbox math + (1, 17, 8400) decode are shared in scan-core
    // (pipeline/yolo-decode.ts); only the onnxruntime-web Tensor wrapping
    // happens here.
    const { data, scale, padX, padY, rotation } = letterboxToFloat32(
      frame as unknown as CanvasLike,
      browserCreateCanvas,
      YOLO_INPUT_SIZE,
      { rotateLandscape: turn === 'none' ? null : turn },
    )
    const tensor = new ortRuntime.Tensor('float32', data, [
      1,
      3,
      YOLO_INPUT_SIZE,
      YOLO_INPUT_SIZE,
    ])

    const results = await session.run({ images: tensor })
    // Ultralytics names the output "output0" by default. Fall back to
    // the first tensor if the name has been customized at export time.
    const out = results['output0'] ?? results[Object.keys(results)[0] ?? '']
    if (!out) return null

    const det = decodeYoloOutput(
      out.data as Float32Array,
      Number(out.dims[1] ?? 0),
      Number(out.dims[2] ?? 0),
      scale,
      padX,
      padY,
      rotation,
    )
    if (!det) return null
    return {
      quad: det.quad as Quad,
      box: det.box,
      confidence: det.confidence,
      visibility: det.visibility,
    }
  }

  dispose(): void {
    this.#session?.release()
    this.#session = null
    this.#ready = false
  }
}
