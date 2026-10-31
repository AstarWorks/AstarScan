#!/usr/bin/env bun
/**
 * Synthetic document-corner data generator → YOLOv8-pose.
 *
 * Composites a procedurally-drawn document (white/coloured page with
 * text-like content, varied aspect) onto a procedural desk background via a
 * random perspective warp, at random scale (incl. filling the frame),
 * rotation, lighting, and optional hand occlusion. Because we place the page
 * with a known homography, the 4 corner labels are EXACT.
 *
 * Targets the v1 (SmartDoc-only) domain gaps directly: portrait framing,
 * pages that fill the frame with big white margins, coloured covers, hand
 * occlusion, wood-tone desks — none well covered by SmartDoc. Free,
 * unlimited, licence-clean, perfect labels.
 *
 *   bun scripts/dataset/gen-synthetic.mjs [--n 1600] [--out <dir>] [--val-every 10] [--debug]
 *
 * Output: <out>/{images,labels}/{train,val} + data.yaml. Keypoint order
 * tl, tr, br, bl (model channel order). v=2 visible, 1 occluded.
 */

import process from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Canvas } from '@napi-rs/canvas'
import { fileURLToPath } from 'node:url'
import { _cv as cv } from '../eval/pipeline.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

const FW = 720
const FH = 1280

const args = { n: 1600, out: path.join(REPO_ROOT, 'scripts/dataset/external/synth-yolo'), valEvery: 10, debug: false }
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i]
  if (a === '--n') args.n = Number(process.argv[++i])
  else if (a === '--out') args.out = path.resolve(process.argv[++i])
  else if (a === '--val-every') args.valEvery = Number(process.argv[++i])
  else if (a === '--debug') args.debug = true
}

const rand = (a, b) => a + Math.random() * (b - a)
const ri = (a, b) => Math.floor(rand(a, b + 1))
const choice = (arr) => arr[ri(0, arr.length - 1)]

function drawBackground() {
  const c = new Canvas(FW, FH)
  const ctx = c.getContext('2d')
  const kind = choice(['wood', 'wood', 'wood', 'light', 'dark'])
  if (kind === 'wood') {
    const hue = ri(20, 38)
    const baseL = rand(45, 68)
    ctx.fillStyle = `hsl(${hue}, ${ri(35, 55)}%, ${baseL}%)`
    ctx.fillRect(0, 0, FW, FH)
    // vertical grain streaks
    for (let x = 0; x < FW; x += ri(2, 6)) {
      ctx.fillStyle = `hsla(${hue}, ${ri(30, 55)}%, ${baseL + rand(-10, 8)}%, ${rand(0.05, 0.2)})`
      ctx.fillRect(x, 0, rand(1, 4), FH)
    }
  } else if (kind === 'light') {
    ctx.fillStyle = `hsl(${ri(20, 210)}, ${ri(3, 12)}%, ${ri(78, 90)}%)`
    ctx.fillRect(0, 0, FW, FH)
  } else {
    ctx.fillStyle = `hsl(${ri(200, 230)}, ${ri(8, 25)}%, ${ri(10, 26)}%)`
    ctx.fillRect(0, 0, FW, FH)
  }
  // speckle noise
  const id = ctx.getImageData(0, 0, FW, FH)
  const d = id.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18
    d[i] += n; d[i + 1] += n; d[i + 2] += n
  }
  ctx.putImageData(id, 0, 0)
  return c
}

function drawDocument() {
  const aspect = choice([0.707, 0.707, 0.707, 0.63, 1.59, 0.45, 0.95]) // A4-ish, card(landscape), receipt, square
  const long = 1000
  const dw = aspect < 1 ? Math.round(long * aspect) : long
  const dh = aspect < 1 ? long : Math.round(long / aspect)
  const c = new Canvas(dw, dh)
  const ctx = c.getContext('2d')
  const colored = Math.random() < 0.28
  ctx.fillStyle = colored ? choice(['#f2cf3e', '#e9c0c0', '#cfe0ef', '#efe7c4', '#dfeede']) : `hsl(${ri(40, 60)}, ${ri(2, 8)}%, ${ri(94, 99)}%)`
  ctx.fillRect(0, 0, dw, dh)
  const m = dw * rand(0.06, 0.12) // margin
  // optional title block
  if (Math.random() < 0.7) {
    ctx.fillStyle = `rgba(20,20,30,${rand(0.6, 0.85)})`
    ctx.fillRect(m, m, dw - 2 * m, dh * rand(0.03, 0.06))
  }
  // text lines (one or two columns)
  const cols = Math.random() < 0.4 ? 2 : 1
  const colW = (dw - 2 * m - (cols - 1) * m) / cols
  for (let col = 0; col < cols; col += 1) {
    const x0 = m + col * (colW + m)
    let y = dh * rand(0.12, 0.2)
    while (y < dh - m) {
      const lw = colW * rand(0.4, 1)
      const lh = dh * rand(0.008, 0.016)
      ctx.fillStyle = `rgba(${ri(20, 70)},${ri(20, 70)},${ri(20, 80)},${rand(0.5, 0.8)})`
      ctx.fillRect(x0, y, lw, lh)
      y += lh + dh * rand(0.012, 0.03)
    }
  }
  // occasional logo/box
  if (Math.random() < 0.4) {
    ctx.fillStyle = `rgba(${ri(40, 200)},${ri(40, 200)},${ri(40, 200)},0.5)`
    ctx.fillRect(m + rand(0, colW), m + rand(0, dh * 0.1), dw * 0.18, dw * 0.18)
  }
  return { canvas: c, dw, dh }
}

// Build 4 dest corners for a doc of pixel size dw x dh.
function placeQuad(dw, dh) {
  const frac = rand(0.42, 0.98)
  const longpx = Math.min(FW, FH) * frac
  const r = dw / dh
  let ww
  let hh
  if (dw >= dh) { ww = longpx; hh = longpx / r } else { hh = longpx; ww = longpx * r }
  const cx = FW / 2 + rand(-0.12, 0.12) * FW
  const cy = FH / 2 + rand(-0.12, 0.12) * FH
  const theta = rand(-0.45, 0.45) // radians (~±25°)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const jx = longpx * rand(0, 0.13)
  const jy = longpx * rand(0, 0.13)
  const base = [
    [-ww / 2, -hh / 2], [ww / 2, -hh / 2], [ww / 2, hh / 2], [-ww / 2, hh / 2],
  ]
  // per-corner perspective jitter
  const jit = base.map(() => [rand(-jx, jx), rand(-jy, jy)])
  return base.map(([x, y], i) => ({
    x: cx + (x + jit[i][0]) * cos - (y + jit[i][1]) * sin,
    y: cy + (x + jit[i][0]) * sin + (y + jit[i][1]) * cos,
  }))
}

function warpDocOnto(bg, docCanvas, dw, dh, corners) {
  const src = cv.imread(docCanvas)
  const dst = new cv.Mat()
  const sp = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dw, 0, dw, dh, 0, dh])
  const dp = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners[0].x, corners[0].y, corners[1].x, corners[1].y,
    corners[2].x, corners[2].y, corners[3].x, corners[3].y,
  ])
  let M = null
  try {
    M = cv.getPerspectiveTransform(sp, dp)
    cv.warpPerspective(src, dst, M, new cv.Size(FW, FH), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0))
    const warped = new Canvas(FW, FH)
    cv.imshow(warped, dst)
    const ctx = bg.getContext('2d')
    ctx.drawImage(warped, 0, 0) // alpha-0 outside doc → composites over bg
  } finally {
    src.delete(); dst.delete(); sp.delete(); dp.delete(); M?.delete()
  }
}

function addHandAndLighting(frame, corners, vis) {
  const ctx = frame.getContext('2d')
  // optional hand: skin blob covering a region; if it covers a corner, mark occluded
  if (Math.random() < 0.3) {
    const hx = rand(0.2, 0.9) * FW
    const hy = rand(0.3, 1.0) * FH
    const hr = rand(120, 260)
    ctx.fillStyle = `hsl(${ri(18, 30)}, ${ri(35, 55)}%, ${ri(60, 78)}%)`
    ctx.beginPath()
    ctx.ellipse(hx, hy, hr * rand(0.5, 0.8), hr, rand(-0.5, 0.5), 0, Math.PI * 2)
    ctx.fill()
    for (let i = 0; i < 4; i += 1) {
      const dx = corners[i].x - hx
      const dy = corners[i].y - hy
      if ((dx * dx) / (hr * hr * 0.42) + (dy * dy) / (hr * hr) < 1) vis[i] = 1
    }
  }
  // lighting gradient
  const g = ctx.createLinearGradient(rand(0, FW), 0, rand(0, FW), FH)
  const dir = Math.random() < 0.5 ? 'rgba(255,255,255,' : 'rgba(0,0,0,'
  g.addColorStop(0, dir + rand(0, 0.18) + ')')
  g.addColorStop(1, dir + rand(0, 0.22) + ')')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, FW, FH)
}

function toLabel(corners, vis) {
  const cl = (v) => Math.min(1, Math.max(0, v))
  const xs = corners.map((c) => cl(c.x / FW))
  const ys = corners.map((c) => cl(c.y / FH))
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const w = Math.max(1e-4, Math.max(...xs) - Math.min(...xs))
  const h = Math.max(1e-4, Math.max(...ys) - Math.min(...ys))
  const kp = corners.map((c, i) => `${cl(c.x / FW).toFixed(6)} ${cl(c.y / FH).toFixed(6)} ${vis[i]}`).join(' ')
  return `0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)} ${kp}`
}

async function main() {
  await fs.rm(args.out, { recursive: true, force: true })
  for (const s of ['train', 'val']) {
    await fs.mkdir(path.join(args.out, 'images', s), { recursive: true })
    await fs.mkdir(path.join(args.out, 'labels', s), { recursive: true })
  }
  if (args.debug) await fs.mkdir(path.join(args.out, 'debug'), { recursive: true })

  let nt = 0
  let nv = 0
  for (let i = 0; i < args.n; i += 1) {
    const bg = drawBackground()
    const { canvas: docC, dw, dh } = drawDocument()
    const corners = placeQuad(dw, dh)
    warpDocOnto(bg, docC, dw, dh, corners)
    const vis = [2, 2, 2, 2]
    addHandAndLighting(bg, corners, vis)

    const split = i % args.valEvery === args.valEvery - 1 ? 'val' : 'train'
    const name = `synth_${String(i).padStart(5, '0')}`
    await fs.writeFile(path.join(args.out, 'images', split, name + '.jpg'), bg.toBuffer('image/jpeg', 88))
    await fs.writeFile(path.join(args.out, 'labels', split, name + '.txt'), toLabel(corners, vis) + '\n')
    if (split === 'val') nv += 1
    else nt += 1

    if (args.debug && i < 8) {
      const dctx = bg.getContext('2d')
      const COL = ['#ff3b30', '#34c759', '#0a84ff', '#ffd60a']
      dctx.lineWidth = 3
      dctx.strokeStyle = 'rgba(255,0,255,0.9)'
      dctx.beginPath(); dctx.moveTo(corners[0].x, corners[0].y)
      for (let k = 1; k < 4; k += 1) dctx.lineTo(corners[k].x, corners[k].y)
      dctx.closePath(); dctx.stroke()
      for (let k = 0; k < 4; k += 1) { dctx.fillStyle = COL[k]; dctx.beginPath(); dctx.arc(corners[k].x, corners[k].y, 7, 0, Math.PI * 2); dctx.fill() }
      await fs.writeFile(path.join(args.out, 'debug', name + '_ov.jpg'), bg.toBuffer('image/jpeg', 88))
    }
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${args.n}`)
  }

  await fs.writeFile(
    path.join(args.out, 'data.yaml'),
    `path: ${args.out}\ntrain: images/train\nval: images/val\nkpt_shape: [4, 3]\nflip_idx: [1, 0, 3, 2]\nnames:\n  0: document\n`,
  )
  console.log(`[synth] generated ${nt + nv} (train=${nt}, val=${nv}) → ${path.relative(REPO_ROOT, args.out)}/`)
}

main()
