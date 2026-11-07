#!/usr/bin/env bun
/**
 * Before / after corner accuracy of the detection path on a synthetic clip
 * (synth.py), running the SAME scan-core code the browser runs:
 *
 *   before  model keypoints, frame fed as-is              (old production)
 *   rotate  model keypoints, landscape always turned cw   (案 2 alone)
 *   snap    model keypoints snapped, no turn              (案 1 alone)
 *   after   detectPageCorners: turn picked + snap         (new production)
 *
 * bun scripts/eval/corner-check/refine-eval.mjs MODEL CLIP_DIR [--turn ccw|cw] [--json OUT]
 *   --turn  rotate each frame 90° (portrait clip → sideways landscape frame)
 *
 * `--turn` with no turn gives a portrait clip unchanged; a landscape
 * clip from `synth.py --fit` has an upright page in a landscape frame.
 *
 * Per method: mean corner error (median over frames), IoU with GT
 * (median), share of the page inside the quad (median), and how many
 * frames pass the ✓ gate (quad area ≥ 0.6 × model box area).
 */

import fs from 'node:fs/promises'
import process from 'node:process'
import * as ort from 'onnxruntime-node'
import { Canvas, loadImage } from '@napi-rs/canvas'

import { cv } from '../cv-shim.mjs'
import {
  YOLO_INPUT_SIZE,
  decodeYoloOutput,
  letterboxToFloat32,
} from '../../../packages/core/src/pipeline/yolo-decode.ts'
import {
  CORNER_REFINE_DEFAULTS,
  boxAgreement,
  createCornerRefiner,
} from '../../../packages/core/src/pipeline/corner-refine.ts'
import { orderQuadCorners } from '../../../packages/core/src/pipeline/detect-otsu.ts'
import {
  OrientationPicker,
  detectPageCorners,
} from '../../../packages/core/src/pipeline/orientation.ts'

const args = process.argv.slice(2)
const [modelPath, clip] = args
const turn = args.includes('--turn') ? args[args.indexOf('--turn') + 1] : null
const jsonOut = args.includes('--json')
  ? args[args.indexOf('--json') + 1]
  : null
if (!modelPath || !clip) {
  console.error('usage: refine-eval.mjs MODEL CLIP_DIR [--turn ccw|cw]')
  process.exit(2)
}

const newCanvas = (w, h) => new Canvas(w, h)
const refiner = createCornerRefiner({ cv, createCanvas: newCanvas })
const session = await ort.InferenceSession.create(modelPath)
const gt = JSON.parse(await fs.readFile(`${clip}/gt.json`, 'utf8'))
const K = ['tl', 'tr', 'br', 'bl']

async function detect(frame, rotateLandscape) {
  const lb = letterboxToFloat32(frame, newCanvas, YOLO_INPUT_SIZE, {
    rotateLandscape,
  })
  const t = new ort.Tensor('float32', lb.data, [
    1,
    3,
    YOLO_INPUT_SIZE,
    YOLO_INPUT_SIZE,
  ])
  const out = await session.run({ images: t })
  const o = out.output0 ?? out[Object.keys(out)[0]]
  return decodeYoloOutput(
    o.data,
    Number(o.dims[1]),
    Number(o.dims[2]),
    lb.scale,
    lb.padX,
    lb.padY,
    lb.rotation,
  )
}

function turnFrame(img, dir) {
  const c = new Canvas(img.height, img.width)
  const ctx = c.getContext('2d')
  if (dir === 'ccw') {
    ctx.translate(0, img.width)
    ctx.rotate(-Math.PI / 2)
  } else {
    ctx.translate(img.height, 0)
    ctx.rotate(Math.PI / 2)
  }
  ctx.drawImage(img, 0, 0)
  return c
}
/** Point of the source frame (w×h) after `turnFrame`. */
function turnPoint(p, w, h, dir) {
  return dir === 'ccw' ? { x: p.y, y: w - p.x } : { x: h - p.y, y: p.x }
}

function pointInPoly(pts, x, y) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]
    const b = pts[j]
    if (
      a.y > y !== b.y > y &&
      x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside
  }
  return inside
}
/** IoU and share of `ref` covered by `q`, on a 4 px grid. */
function iou(q, ref, W, H) {
  const pq = K.map((k) => q[k])
  const pr = K.map((k) => ref[k])
  let inter = 0
  let uni = 0
  let refN = 0
  for (let y = -200; y < H + 200; y += 4)
    for (let x = -200; x < W + 200; x += 4) {
      const a = pointInPoly(pq, x, y)
      const b = pointInPoly(pr, x, y)
      if (a && b) inter += 1
      if (a || b) uni += 1
      if (b) refN += 1
    }
  return { iou: inter / Math.max(1, uni), cover: inter / Math.max(1, refN) }
}
const err = (q, ref) =>
  K.reduce((s, k) => s + Math.hypot(q[k].x - ref[k].x, q[k].y - ref[k].y), 0) /
  4
const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

const M = ['before', 'rotate', 'snap', 'after']
const picker = new OrientationPicker()
const turns = {}
const acc = Object.fromEntries(
  M.map((m) => [m, { err: [], iou: [], cover: [], gate: 0, n: 0 }]),
)
let refined = 0
let frames = 0
for (let i = 0; i < gt.frames.length; i += 1) {
  const g = gt.frames[i]
  if (!g.holding) continue
  const img = await loadImage(
    `${clip}/frames/${String(i).padStart(4, '0')}.png`,
  )
  let frame = new Canvas(img.width, img.height)
  frame.getContext('2d').drawImage(img, 0, 0)
  let ref = g.quad
  if (turn) {
    frame = turnFrame(frame, turn)
    ref = orderQuadCorners(
      K.map((k) => turnPoint(g.quad[k], img.width, img.height, turn)),
    )
  }
  frames += 1
  const before = await detect(frame, null)
  const rot = await detect(frame, 'cw')
  const snapOnly =
    before && refiner.refineCorners(frame, before.quad, before.box)
  const found = await detectPageCorners(
    frame,
    (t) => detect(frame, t === 'none' ? null : t),
    (q, b) => refiner.refineCorners(frame, q, b),
    picker,
  )
  if (found?.refine.refined) refined += 1
  if (found) turns[found.turn] = (turns[found.turn] ?? 0) + 1
  const res = {
    before: before && { quad: before.quad, box: before.box },
    rotate: rot && { quad: rot.quad, box: rot.box },
    snap: snapOnly && { quad: snapOnly.quad, box: before.box },
    after: found && { quad: found.refine.quad, box: found.detection.box },
  }
  for (const m of M) {
    const d = res[m]
    if (!d) continue
    const a = acc[m]
    a.n += 1
    a.err.push(err(d.quad, ref))
    const u = iou(d.quad, ref, frame.width, frame.height)
    a.iou.push(u.iou)
    a.cover.push(u.cover)
    if (boxAgreement(d.quad, d.box) >= CORNER_REFINE_DEFAULTS.minAreaOfBox)
      a.gate += 1
  }
}

const rows = M.map((m) => {
  const a = acc[m]
  return {
    method: m,
    n: a.n,
    errMedian: median(a.err),
    errMean: a.err.reduce((s, x) => s + x, 0) / Math.max(1, a.err.length),
    iouMedian: median(a.iou),
    coverMedian: median(a.cover),
    gatePass: a.gate,
  }
})
console.log(
  `clip=${clip} turn=${turn ?? 'none'} frames=${frames} snapped=${refined}/${frames} picked=${JSON.stringify(turns)}`,
)
for (const r of rows)
  console.log(
    `${r.method.padEnd(7)} n=${r.n}  err median ${r.errMedian.toFixed(1)}px mean ${r.errMean.toFixed(1)}px  IoU ${r.iouMedian.toFixed(2)}  cover ${(r.coverMedian * 100).toFixed(0)}%  gate ${r.gatePass}/${frames}`,
  )
if (jsonOut)
  await fs.writeFile(
    jsonOut,
    JSON.stringify({ clip, turn, frames, refined, turns, rows }, null, 2),
  )
