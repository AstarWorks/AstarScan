#!/usr/bin/env bun
/**
 * Smart training-frame extractor: pull frames from a video, drop the dead
 * ones (empty desk / motion blur / no document), and thin near-duplicates
 * so a few static seconds don't dominate the dataset.
 *
 *   bun scripts/dataset/extract-frames.mjs <video.mp4> [more.mp4 ...] [opts]
 *
 * Options (defaults tuned on the eval footage, see calibration below):
 *   --interval 0.2     sample every N seconds (5 fps)
 *   --out <dir>        output dir (default scripts/dataset/frames)
 *   --lap 40           keep frames with Laplacian variance ≥ this (texture
 *                      → has a printed document; empty desk ≈ 4, blur ≈ 3,
 *                      real documents 50-170)
 *   --ten 25           keep frames with Tenengrad ≥ this (sharp, not motion
 *                      blur; dead frames ≈ 11, sharp documents 29-48)
 *   --dup 12           tile-pHash distance ≤ this → same scene (near-dup)
 *   --per-scene 6      keep at most this many (sharpest) frames per scene
 *
 * Reuses the eval harness's metrics so the gate matches the live pipeline.
 * Output names: <videobase>_<frameIdx>.jpg, ready for scripts/label.
 */

import process from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { jpegToCanvas } from '../eval/canvas-utils.mjs'
import {
  computeLaplacian,
  computeTenengrad,
  computeTilePHash,
  tileDistance,
} from '../eval/pipeline.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

function parseArgs(argv) {
  const a = { videos: [], interval: 0.2, out: path.join(REPO_ROOT, 'scripts/dataset/raw'), lap: 40, ten: 25, dup: 12, perScene: 6 }
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i]
    const next = () => argv[++i]
    switch (t) {
      case '--interval': a.interval = Number(next()); break
      case '--out': a.out = path.resolve(next()); break
      case '--lap': a.lap = Number(next()); break
      case '--ten': a.ten = Number(next()); break
      case '--dup': a.dup = Number(next()); break
      case '--per-scene': a.perScene = Number(next()); break
      default: a.videos.push(path.resolve(t))
    }
  }
  if (!a.videos.length) {
    console.error('usage: bun scripts/dataset/extract-frames.mjs <video.mp4> [...] [--out dir --lap 40 --ten 25 --dup 12 --per-scene 6]')
    process.exit(2)
  }
  return a
}

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (b) => (err += b))
    p.on('error', reject)
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}: ${err.slice(-300)}`))))
  })
}

async function processVideo(video, a) {
  const base = path.basename(video, path.extname(video))
  const tmp = path.join(a.out, `.tmp_${base}`)
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  await ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', video, '-vf', `fps=${1 / a.interval}`, '-q:v', '3', path.join(tmp, 'f-%05d.jpg')])
  const files = (await fs.readdir(tmp)).filter((f) => f.endsWith('.jpg')).sort()

  // Pass 1: dead-frame gate (blur / empty / no document).
  const kept = []
  let blur = 0
  let empty = 0
  for (let i = 0; i < files.length; i += 1) {
    const canvas = await jpegToCanvas(path.join(tmp, files[i]))
    const ten = computeTenengrad(canvas)
    const lap = computeLaplacian(canvas)
    if (ten < a.ten) { blur += 1; continue }
    if (lap < a.lap) { empty += 1; continue }
    kept.push({ idx: i, file: files[i], lap, tile: computeTilePHash(canvas) })
  }

  // Pass 2: thin near-duplicates (online tile-pHash clustering), keep the
  // sharpest `perScene` per scene so static stretches don't dominate.
  const scenes = []
  for (const f of kept) {
    let hit = null
    for (const s of scenes) {
      if (tileDistance(f.tile, s.rep) <= a.dup) { hit = s; break }
    }
    if (hit) hit.members.push(f)
    else scenes.push({ rep: f.tile, members: [f] })
  }
  const out = []
  for (const s of scenes) {
    s.members.sort((x, y) => y.lap - x.lap)
    out.push(...s.members.slice(0, a.perScene))
  }
  out.sort((x, y) => x.idx - y.idx)

  for (const f of out) {
    const name = `${base}_${String(f.idx).padStart(5, '0')}.jpg`
    await fs.copyFile(path.join(tmp, f.file), path.join(a.out, name))
  }
  await fs.rm(tmp, { recursive: true, force: true })
  return { base, sampled: files.length, blur, empty, passed: kept.length, scenes: scenes.length, kept: out.length }
}

const a = parseArgs(process.argv.slice(2))
await fs.mkdir(a.out, { recursive: true })
console.log(`[extract] interval=${a.interval}s gate(lap≥${a.lap}, ten≥${a.ten}) dedup(tile≤${a.dup}, ≤${a.perScene}/scene) → ${path.relative(REPO_ROOT, a.out)}/`)
let total = 0
for (const v of a.videos) {
  const r = await processVideo(v, a)
  console.log(`  ${r.base}: sampled=${r.sampled} → drop blur=${r.blur} empty=${r.empty} → passed=${r.passed} → ${r.scenes} scenes → kept=${r.kept}`)
  total += r.kept
}
console.log(`[extract] kept ${total} frames total in ${path.relative(REPO_ROOT, a.out)}/ → label with: bun scripts/label/server.mjs`)
