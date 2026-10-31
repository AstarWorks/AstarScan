/**
 * YOLOv8n-pose document-corner detection — the environment-independent
 * half: Ultralytics letterbox preprocessing (to a raw NCHW float buffer)
 * and the (1, 17, 8400) channel-major decode. Session creation and
 * `ort.Tensor` wrapping stay in the environment adapters
 * (onnxruntime-web in apps/web, onnxruntime-node in scripts/eval).
 *
 * ONNX I/O contract (Ultralytics export, imgsz=640, 1 class, 4 kpt):
 *   Input:  "images", float32 (1, 3, 640, 640), letterbox-resized [0,1]
 *   Output: (1, 17, 8400); channels: 0..3 = cx,cy,w,h; 4 = class conf;
 *           5.. = 4 × (kpt x, y, visibility). 8400 anchors = P3+P4+P5.
 * One document per frame → argmax over class confidence, no NMS.
 */

import type { Quad } from '../types.js'
import type { CanvasImageSourceLike, CreateCanvas } from './deps.js'

export const YOLO_INPUT_SIZE = 640
export const YOLO_NUM_KEYPOINTS = 4
export const YOLO_OUTPUT_CHANNELS = 5 + YOLO_NUM_KEYPOINTS * 3 // 17
/** Ultralytics letterbox grey (matches training). */
export const YOLO_PAD_VALUE = 114 / 255

export interface YoloDetection {
  quad: Quad
  /** Class confidence in [0, 1] from the winning anchor. */
  confidence: number
  /** Per-corner visibility (sigmoid) in [0, 1]; ≤ 0.3 means the model
   *  thinks that corner was occluded / off-frame. */
  visibility: [number, number, number, number]
}

export interface LetterboxResult {
  /** NCHW float32 RGB in [0, 1], length 3 × target². */
  data: Float32Array
  scale: number
  padX: number
  padY: number
}

/**
 * Letterbox-resize `source` to `target × target`, preserving aspect ratio
 * with grey padding, and return the NCHW float buffer plus the transform
 * needed to map detections back to source pixels.
 */
export function letterboxToFloat32(
  source: CanvasImageSourceLike,
  createCanvas: CreateCanvas,
  target: number = YOLO_INPUT_SIZE,
): LetterboxResult {
  const srcW = source.width
  const srcH = source.height
  const scale = Math.min(target / srcW, target / srcH)
  const newW = Math.round(srcW * scale)
  const newH = Math.round(srcH * scale)
  const padX = Math.floor((target - newW) / 2)
  const padY = Math.floor((target - newH) / 2)

  const work = createCanvas(target, target)
  const ctx = work.getContext('2d', { willReadFrequently: true })
  if (!ctx)
    throw new Error('scan-core: failed to get 2D context for YOLO letterbox')
  const grey = Math.round(YOLO_PAD_VALUE * 255)
  ctx.fillStyle = `rgb(${grey}, ${grey}, ${grey})`
  ctx.fillRect(0, 0, target, target)
  ctx.drawImage(source, 0, 0, srcW, srcH, padX, padY, newW, newH)

  const imageData = ctx.getImageData(0, 0, target, target).data
  const plane = target * target
  const data = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i += 1) {
    data[i] = (imageData[i * 4] ?? 0) / 255
    data[plane + i] = (imageData[i * 4 + 1] ?? 0) / 255
    data[2 * plane + i] = (imageData[i * 4 + 2] ?? 0) / 255
  }
  return { data, scale, padX, padY }
}

/**
 * Pure decode of the (1, channels, anchors) channel-major output into a
 * quad in SOURCE pixel space. Returns null on channel mismatch or empty
 * output. Corner order matches training labels: 0=TL, 1=TR, 2=BR, 3=BL.
 */
export function decodeYoloOutput(
  data: Float32Array | ArrayLike<number>,
  channels: number,
  anchors: number,
  scale: number,
  padX: number,
  padY: number,
): YoloDetection | null {
  if (channels !== YOLO_OUTPUT_CHANNELS || !anchors) return null
  const classOffset = 4 * anchors
  let bestA = -1
  let bestConf = 0
  for (let a = 0; a < anchors; a += 1) {
    const c = data[classOffset + a] ?? 0
    if (c > bestConf) {
      bestConf = c
      bestA = a
    }
  }
  if (bestA < 0) return null
  const corners: Array<{ x: number; y: number }> = []
  const vis: number[] = []
  for (let k = 0; k < YOLO_NUM_KEYPOINTS; k += 1) {
    const xPx = data[(5 + k * 3) * anchors + bestA] ?? 0 // 0..640 input space
    const yPx = data[(6 + k * 3) * anchors + bestA] ?? 0
    const v = data[(7 + k * 3) * anchors + bestA] ?? 0
    corners.push({ x: (xPx - padX) / scale, y: (yPx - padY) / scale })
    vis.push(v)
  }
  return {
    quad: {
      tl: corners[0]!,
      tr: corners[1]!,
      br: corners[2]!,
      bl: corners[3]!,
    },
    confidence: bestConf,
    visibility: [vis[0]!, vis[1]!, vis[2]!, vis[3]!],
  }
}
