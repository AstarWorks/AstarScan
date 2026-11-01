#!/usr/bin/env bun
/**
 * Convert the SmartDoc 2015 Challenge 1 dataset (smartphone-captured
 * document video frames + per-frame quadrilateral corner ground truth,
 * CC BY 4.0) into a YOLOv8-pose dataset matching our model contract.
 *
 *   bun scripts/dataset/import-smartdoc.mjs [--per-video 12] [--val-every 8]
 *
 * Prereq: frames + metadata extracted under
 *   scripts/dataset/external/smartdoc/  (frames.tar.gz contents)
 *
 * SmartDoc corner order in metadata.csv is tl, bl, br, tr. Our model's
 * keypoint channel order is tl, tr, br, bl — we reorder on write. All
 * corners are visible (v=2); SmartDoc documents are never hand-occluded.
 *
 * Split is by VIDEO (bg_name/model_name) so val frames come from videos
 * the model never trained on — no near-duplicate leakage.
 *
 * Output: scripts/dataset/external/smartdoc-yolo/{images,labels}/{train,val}
 *         + data.yaml
 */

import process from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { loadImage } from '@napi-rs/canvas'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const SD = path.join(REPO_ROOT, 'scripts/dataset/external/smartdoc')
const OUT = path.join(REPO_ROOT, 'scripts/dataset/external/smartdoc-yolo')

function parseArgs(argv) {
  const a = { perVideo: 12, valEvery: 8 }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--per-video') a.perVideo = Number(argv[++i])
    else if (argv[i] === '--val-every') a.valEvery = Number(argv[++i])
  }
  return a
}

const DATA_YAML = `# SmartDoc 2015 Ch1 → YOLOv8-pose (CC BY 4.0; cite ICDAR2015 SmartDoc).
# In Colab set 'path' to the extracted absolute dir, then yolo train.
path: .
train: images/train
val: images/val
kpt_shape: [4, 3]
flip_idx: [1, 0, 3, 2]
names:
  0: document
`

function toYoloLine(corners, W, H) {
  // corners in our order: [tl, tr, br, bl], each {x,y} in frame pixels.
  const nx = (v) => Math.min(1, Math.max(0, v / W))
  const ny = (v) => Math.min(1, Math.max(0, v / H))
  const xs = corners.map((c) => nx(c.x))
  const ys = corners.map((c) => ny(c.y))
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const w = Math.max(1e-4, maxX - minX)
  const h = Math.max(1e-4, maxY - minY)
  const kp = corners
    .map((c) => `${nx(c.x).toFixed(6)} ${ny(c.y).toFixed(6)} 2`)
    .join(' ')
  return `0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)} ${kp}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const metaPath = path.join(SD, 'metadata.csv.gz')
  let csv
  try {
    csv = zlib.gunzipSync(await fs.readFile(metaPath)).toString('utf8')
  } catch {
    console.error(
      `[smartdoc] missing ${path.relative(REPO_ROOT, metaPath)} — extract frames.tar.gz first.`,
    )
    process.exit(1)
  }
  const lines = csv.trim().split('\n')
  const header = lines[0].split(',')
  const idx = Object.fromEntries(header.map((h, i) => [h, i]))
  const need = [
    'image_path',
    'bg_name',
    'model_name',
    'tl_x',
    'tl_y',
    'bl_x',
    'bl_y',
    'br_x',
    'br_y',
    'tr_x',
    'tr_y',
  ]
  for (const n of need)
    if (idx[n] === undefined) {
      console.error(`[smartdoc] column ${n} missing`)
      process.exit(1)
    }

  // Group rows by video = bg_name/model_name.
  const videos = new Map()
  for (let i = 1; i < lines.length; i += 1) {
    const f = lines[i].split(',')
    if (f.length < header.length) continue
    const key = `${f[idx.bg_name]}/${f[idx.model_name]}`
    if (!videos.has(key)) videos.set(key, [])
    videos.get(key).push(f)
  }
  const videoKeys = [...videos.keys()].sort()
  console.log(
    `[smartdoc] ${lines.length - 1} frames across ${videoKeys.length} videos`,
  )

  // Verify frame resolution is the documented 1920×1080 (sample a few).
  let W = 1920
  let H = 1080
  for (const k of videoKeys.slice(0, 5)) {
    const f = videos.get(k)[0]
    const img = await loadImage(path.join(SD, f[idx.image_path]))
    if (img.width !== 1920 || img.height !== 1080) {
      W = img.width
      H = img.height
      console.warn(
        `[smartdoc] non-1080p frame ${img.width}x${img.height} — reading per-image dims`,
      )
    }
  }
  const perImageDims = W !== 1920 || H !== 1080

  await fs.rm(OUT, { recursive: true, force: true })
  for (const s of ['train', 'val']) {
    await fs.mkdir(path.join(OUT, 'images', s), { recursive: true })
    await fs.mkdir(path.join(OUT, 'labels', s), { recursive: true })
  }

  let nTrain = 0
  let nVal = 0
  for (let v = 0; v < videoKeys.length; v += 1) {
    const key = videoKeys[v]
    const rows = videos.get(key)
    const split = v % args.valEvery === args.valEvery - 1 ? 'val' : 'train'
    // Evenly sample perVideo frames spread across the video.
    const step = Math.max(1, Math.floor(rows.length / args.perVideo))
    for (let r = 0; r < rows.length; r += step) {
      const f = rows[r]
      const src = path.join(SD, f[idx.image_path])
      let w = W
      let h = H
      if (perImageDims) {
        try {
          const im = await loadImage(src)
          w = im.width
          h = im.height
        } catch {
          continue
        }
      }
      const corners = [
        { x: +f[idx.tl_x], y: +f[idx.tl_y] }, // tl
        { x: +f[idx.tr_x], y: +f[idx.tr_y] }, // tr
        { x: +f[idx.br_x], y: +f[idx.br_y] }, // br
        { x: +f[idx.bl_x], y: +f[idx.bl_y] }, // bl
      ]
      const flat = f[idx.image_path]
        .replace(/\//g, '_')
        .replace(/\.jpe?g$/i, '')
      try {
        await fs.copyFile(src, path.join(OUT, 'images', split, flat + '.jpg'))
      } catch {
        continue
      }
      await fs.writeFile(
        path.join(OUT, 'labels', split, flat + '.txt'),
        toYoloLine(corners, w, h) + '\n',
      )
      if (split === 'val') nVal += 1
      else nTrain += 1
    }
  }

  await fs.writeFile(path.join(OUT, 'data.yaml'), DATA_YAML)
  console.log(
    `[smartdoc] wrote ${nTrain + nVal} frames (train=${nTrain}, val=${nVal}) → ${path.relative(REPO_ROOT, OUT)}/`,
  )
  console.log(
    '[smartdoc] note: landscape 1080p, patterned backgrounds, NO hand occlusion — domain-shifted from our portrait/desk/hands footage. Good v1 base; measure on held-out real video.',
  )
}

main()
