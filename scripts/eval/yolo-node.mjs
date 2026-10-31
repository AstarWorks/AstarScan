#!/usr/bin/env bun
/**
 * Headless YOLOv8n-pose document-corner detector for the eval harness.
 *
 * Node-side mirror of `apps/web/app/services/yolo-pose-backend.ts`: same
 * letterbox preprocessing and the same (1, 17, 8400) channel-major decode,
 * but using `onnxruntime-node` + `@napi-rs/canvas` instead of
 * onnxruntime-web + a DOM canvas. Lets `run.mjs --detector yolo` measure
 * the trained model's corner accuracy on the eval MP4s before we ever wire
 * it into the browser app.
 *
 * Self-test (verifies the decode against a synthetic tensor, no model):
 *   bun scripts/eval/yolo-node.mjs --selftest
 */

import process from 'node:process'
import * as ort from 'onnxruntime-node'
import { newCanvas } from './canvas-utils.mjs'
import {
  YOLO_INPUT_SIZE,
  YOLO_NUM_KEYPOINTS,
  YOLO_OUTPUT_CHANNELS,
  decodeYoloOutput,
  letterboxToFloat32,
} from '../../packages/core/src/pipeline/yolo-decode.ts'

export { decodeYoloOutput }

export async function createYoloSession(modelPath) {
  return ort.InferenceSession.create(modelPath, { graphOptimizationLevel: 'all' })
}

/**
 * Letterbox-resize a canvas to target×target, return NCHW float32 [0,1]
 * plus the transform needed to map detections back to source pixels.
 * The math is shared in scan-core (pipeline/yolo-decode.ts); only the
 * onnxruntime-node Tensor wrapping happens here.
 */
export function letterboxToTensor(source, target = YOLO_INPUT_SIZE) {
  const { data, scale, padX, padY } = letterboxToFloat32(source, newCanvas, target)
  const tensor = new ort.Tensor('float32', data, [1, 3, target, target])
  return { tensor, scale, padX, padY }
}

/**
 * Detect the document in `source` (a Canvas). Returns
 * `{ quad, confidence, visibility }` in source pixel space, or null when
 * no anchor clears `minConf`. Pass minConf=0 to let the caller gate.
 */
export async function detectWithYolo(source, session, minConf = 0) {
  const { tensor, scale, padX, padY } = letterboxToTensor(source)
  const out = await session.run({ images: tensor })
  const o = out.output0 ?? out[Object.keys(out)[0]]
  if (!o) return null
  const det = decodeYoloOutput(o.data, Number(o.dims[1]), Number(o.dims[2]), scale, padX, padY)
  if (!det || det.confidence < minConf) return null
  return det
}

// ---------------------------------------------------------------------------
// Self-test — verify decode + letterbox-reverse without a real model.
// ---------------------------------------------------------------------------

function runSelfTest() {
  const anchors = 3
  const channels = YOLO_OUTPUT_CHANNELS
  const data = new Float32Array(channels * anchors)
  const set = (c, a, v) => {
    data[c * anchors + a] = v
  }
  // class confidence per anchor: a1 wins.
  set(4, 0, 0.1)
  set(4, 1, 0.9)
  set(4, 2, 0.2)
  // For the winning anchor (a=1), keypoints in 640-input space:
  //   tl(110,120) tr(530,118) br(528,520) bl(112,510)
  const kp = [
    [110, 120, 0.95],
    [530, 118, 0.92],
    [528, 520, 0.4],
    [112, 510, 0.88],
  ]
  for (let k = 0; k < YOLO_NUM_KEYPOINTS; k += 1) {
    set(5 + k * 3, 1, kp[k][0])
    set(6 + k * 3, 1, kp[k][1])
    set(7 + k * 3, 1, kp[k][2])
  }
  // Transform: scale 0.5, padX 10, padY 20  →  src = (in - pad)/scale
  const scale = 0.5
  const padX = 10
  const padY = 20
  const det = decodeYoloOutput(data, channels, anchors, scale, padX, padY)

  const approx = (a, b) => Math.abs(a - b) < 1e-6
  const expect = {
    tl: { x: (110 - padX) / scale, y: (120 - padY) / scale },
    tr: { x: (530 - padX) / scale, y: (118 - padY) / scale },
    br: { x: (528 - padX) / scale, y: (520 - padY) / scale },
    bl: { x: (112 - padX) / scale, y: (510 - padY) / scale },
  }
  const checks = [
    ['picks max-conf anchor', approx(det.confidence, 0.9)],
    ['tl.x', approx(det.quad.tl.x, expect.tl.x)],
    ['tl.y', approx(det.quad.tl.y, expect.tl.y)],
    ['tr.x', approx(det.quad.tr.x, expect.tr.x)],
    ['br.y', approx(det.quad.br.y, expect.br.y)],
    ['bl.x', approx(det.quad.bl.x, expect.bl.x)],
    ['visibility order', approx(det.visibility[2], 0.4) && approx(det.visibility[0], 0.95)],
    ['rejects on channel mismatch', decodeYoloOutput(data, 16, anchors, scale, padX, padY) === null],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✗ FAIL'}  ${name}`)
    if (!pass) ok = false
  }
  console.log(ok ? '[yolo-node] self-test PASSED' : '[yolo-node] self-test FAILED')
  console.log('  decoded quad:', JSON.stringify(det.quad))
  process.exit(ok ? 0 : 1)
}

if (import.meta.main) runSelfTest()
