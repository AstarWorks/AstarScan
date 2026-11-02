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

/** Axis-aligned box in source pixels (x0 < x1, y0 < y1). */
export interface PixelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface YoloDetection {
  quad: Quad
  /** The winning anchor's box (channels 0–3) in source pixels. Measured
   *  to be far closer to the page outline than the keypoints (57 px vs
   *  184 px mean corner error, docs/corner-accuracy-investigation.md), so
   *  `corner-refine.ts` searches for the paper edge around it. */
  box: PixelBox
  /** Class confidence in [0, 1] from the winning anchor. */
  confidence: number
  /** Per-corner visibility (sigmoid) in [0, 1]; ≤ 0.3 means the model
   *  thinks that corner was occluded / off-frame. */
  visibility: [number, number, number, number]
}

/**
 * The source was turned 90° before the model saw it (landscape frame fed
 * as portrait). `srcW` / `srcH` are the ORIGINAL source size, needed to
 * map rotated coordinates back.
 */
export interface YoloRotation {
  /** Direction the source was turned before the model saw it. */
  dir: 'cw' | 'ccw'
  srcW: number
  srcH: number
}

export interface LetterboxResult {
  /** NCHW float32 RGB in [0, 1], length 3 × target². */
  data: Float32Array
  scale: number
  padX: number
  padY: number
  /** Set when the source was rotated (see `LetterboxOptions`); pass it on
   *  to `decodeYoloOutput` so points come back in source pixels. */
  rotation: YoloRotation | null
}

export interface LetterboxOptions {
  /** Turn landscape sources 90° (clockwise, or counter-clockwise) so the
   *  model sees a portrait frame. The model was trained on 720×1280
   *  portrait frames only and falls apart on a sideways page in a
   *  landscape frame (573 px vs 184 px corner error). Portrait sources
   *  are never turned. */
  rotateLandscape?: 'cw' | 'ccw' | null
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
  opts: LetterboxOptions = {},
): LetterboxResult {
  const srcW = source.width
  const srcH = source.height
  const dir = srcW > srcH ? (opts.rotateLandscape ?? null) : null
  const rotate = dir !== null
  // Size as the model sees it (rotated when `rotate`).
  const viewW = rotate ? srcH : srcW
  const viewH = rotate ? srcW : srcH
  const scale = Math.min(target / viewW, target / viewH)
  const newW = Math.round(viewW * scale)
  const newH = Math.round(viewH * scale)
  const padX = Math.floor((target - newW) / 2)
  const padY = Math.floor((target - newH) / 2)
  const grey = Math.round(YOLO_PAD_VALUE * 255)
  const plane = target * target
  const data = new Float32Array(3 * plane)

  if (!rotate) {
    const work = createCanvas(target, target)
    const ctx = work.getContext('2d', { willReadFrequently: true })
    if (!ctx)
      throw new Error('scan-core: failed to get 2D context for YOLO letterbox')
    ctx.fillStyle = `rgb(${grey}, ${grey}, ${grey})`
    ctx.fillRect(0, 0, target, target)
    ctx.drawImage(source, 0, 0, srcW, srcH, padX, padY, newW, newH)
    const imageData = ctx.getImageData(0, 0, target, target).data
    for (let i = 0; i < plane; i += 1) {
      data[i] = (imageData[i * 4] ?? 0) / 255
      data[plane + i] = (imageData[i * 4 + 1] ?? 0) / 255
      data[2 * plane + i] = (imageData[i * 4 + 2] ?? 0) / 255
    }
    return { data, scale, padX, padY, rotation: null }
  }

  // Rotated: scale the source unrotated (sw × sh = newH × newW), then
  // write it turned 90° into the padded buffer. Scaled pixel (xs, ys)
  // lands at rotated (sh - 1 - ys, xs) clockwise, (ys, sw - 1 - xs)
  // counter-clockwise.
  const cw = dir === 'cw'
  const sw = newH
  const sh = newW
  const work = createCanvas(sw, sh)
  const ctx = work.getContext('2d', { willReadFrequently: true })
  if (!ctx)
    throw new Error('scan-core: failed to get 2D context for YOLO letterbox')
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, sw, sh)
  const px = ctx.getImageData(0, 0, sw, sh).data
  data.fill(grey / 255)
  for (let ys = 0; ys < sh; ys += 1) {
    for (let xs = 0; xs < sw; xs += 1) {
      const s = (ys * sw + xs) * 4
      const d = cw
        ? (padY + xs) * target + padX + sh - 1 - ys
        : (padY + sw - 1 - xs) * target + padX + ys
      data[d] = (px[s] ?? 0) / 255
      data[plane + d] = (px[s + 1] ?? 0) / 255
      data[2 * plane + d] = (px[s + 2] ?? 0) / 255
    }
  }
  return { data, scale, padX, padY, rotation: { dir, srcW, srcH } }
}

/**
 * Pure decode of the (1, channels, anchors) channel-major output into a
 * quad in SOURCE pixel space. Returns null on channel mismatch or empty
 * output. Corner order matches training labels: 0=TL, 1=TR, 2=BR, 3=BL
 * (in the source orientation, also when `rotation` is set).
 */
export function decodeYoloOutput(
  data: Float32Array | ArrayLike<number>,
  channels: number,
  anchors: number,
  scale: number,
  padX: number,
  padY: number,
  rotation: YoloRotation | null = null,
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
  return decodeAnchor(data, anchors, bestA, scale, padX, padY, rotation)
}

/**
 * Every page the model found, best first: anchors at or above `minConf`,
 * greedy NMS on the boxes (IoU above `nmsIou` = same page), at most
 * `maxDet`. On an open book the two pages come back as the top two
 * (book clips: 0.64–0.88 each), which `decodeYoloOutput` reduces to
 * whichever wins the frame — the reason a spread flickered between pages.
 */
export function decodeYoloCandidates(
  data: Float32Array | ArrayLike<number>,
  channels: number,
  anchors: number,
  scale: number,
  padX: number,
  padY: number,
  rotation: YoloRotation | null = null,
  opts: { minConf?: number; nmsIou?: number; maxDet?: number } = {},
): YoloDetection[] {
  if (channels !== YOLO_OUTPUT_CHANNELS || !anchors) return []
  const minConf = opts.minConf ?? 0.25
  const nmsIou = opts.nmsIou ?? 0.5
  const maxDet = opts.maxDet ?? 3
  const classOffset = 4 * anchors
  const idx: number[] = []
  for (let a = 0; a < anchors; a += 1)
    if ((data[classOffset + a] ?? 0) >= minConf) idx.push(a)
  idx.sort(
    (p, q) => (data[classOffset + q] ?? 0) - (data[classOffset + p] ?? 0),
  )
  const kept: YoloDetection[] = []
  for (const a of idx) {
    if (kept.length >= maxDet) break
    const d = decodeAnchor(data, anchors, a, scale, padX, padY, rotation)
    if (kept.every((k) => boxIou(k.box, d.box) <= nmsIou)) kept.push(d)
  }
  return kept
}

/** Intersection over union of two boxes (0 when either is empty). */
export function boxIou(a: PixelBox, b: PixelBox): number {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const inter = iw * ih
  const ua =
    Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0) +
    Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0) -
    inter
  return ua > 0 ? inter / ua : 0
}

function decodeAnchor(
  data: Float32Array | ArrayLike<number>,
  anchors: number,
  bestA: number,
  scale: number,
  padX: number,
  padY: number,
  rotation: YoloRotation | null,
): YoloDetection {
  const bestConf = data[4 * anchors + bestA] ?? 0
  // Input space (0..640) → model-view pixels → source pixels. When the
  // view was turned clockwise, view (xv, yv) is source (yv, srcH - xv);
  // counter-clockwise, source (srcW - yv, xv).
  const toSource = (xIn: number, yIn: number) => {
    const xv = (xIn - padX) / scale
    const yv = (yIn - padY) / scale
    if (!rotation) return { x: xv, y: yv }
    return rotation.dir === 'cw'
      ? { x: yv, y: rotation.srcH - xv }
      : { x: rotation.srcW - yv, y: xv }
  }
  const corners: Array<{ x: number; y: number }> = []
  const vis: number[] = []
  for (let k = 0; k < YOLO_NUM_KEYPOINTS; k += 1) {
    const xPx = data[(5 + k * 3) * anchors + bestA] ?? 0 // 0..640 input space
    const yPx = data[(6 + k * 3) * anchors + bestA] ?? 0
    const v = data[(7 + k * 3) * anchors + bestA] ?? 0
    corners.push(toSource(xPx, yPx))
    vis.push(v)
  }
  const cx = data[bestA] ?? 0
  const cy = data[anchors + bestA] ?? 0
  const bw = data[2 * anchors + bestA] ?? 0
  const bh = data[3 * anchors + bestA] ?? 0
  const b0 = toSource(cx - bw / 2, cy - bh / 2)
  const b1 = toSource(cx + bw / 2, cy + bh / 2)
  const box: PixelBox = {
    x0: Math.min(b0.x, b1.x),
    y0: Math.min(b0.y, b1.y),
    x1: Math.max(b0.x, b1.x),
    y1: Math.max(b0.y, b1.y),
  }
  // Clockwise view: its TL/TR/BR/BL are the source's BL/TL/TR/BR, so the
  // source TL is the view's TR (index 1). Counter-clockwise: the source
  // TL is the view's BL (index 3).
  const [i0, i1, i2, i3] = !rotation
    ? [0, 1, 2, 3]
    : rotation.dir === 'cw'
      ? [1, 2, 3, 0]
      : [3, 0, 1, 2]
  return {
    quad: {
      tl: corners[i0]!,
      tr: corners[i1]!,
      br: corners[i2]!,
      bl: corners[i3]!,
    },
    box,
    confidence: bestConf,
    visibility: [vis[i0]!, vis[i1]!, vis[i2]!, vis[i3]!],
  }
}
