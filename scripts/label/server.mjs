#!/usr/bin/env bun
/**
 * Local click-to-label tool for the document-corner dataset.
 *
 * Serves a browser UI that walks through every JPEG in
 * `scripts/dataset/raw/`. For each frame you click the 4 corners in order
 * TL → TR → BR → BL (drag to fine-tune, toggle occlusion per corner), and
 * the server writes a YOLOv8-pose label to `scripts/dataset/labels/`.
 *
 * No Roboflow account, no export step. Annotations are also persisted to
 * `scripts/dataset/annotations.json` (normalized coords) as the editable
 * source of truth, so you can resume and re-edit; `build-dataset.mjs`
 * regenerates the Ultralytics-ready folder from it.
 *
 * Run:
 *   bun scripts/label/server.mjs        # then open http://localhost:4321
 *
 * Label line format (one instance per frame), all coords normalized 0..1:
 *   <class> <cx> <cy> <w> <h>  <x1> <y1> <v1> ... <x4> <y4> <v4>
 *   class = 0 (document); v = 2 visible, 1 occluded. Keypoint order is the
 *   model's channel order: tl, tr, br, bl.
 */

import { serve } from 'bun'
import process from 'node:process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const RAW_DIR = path.join(REPO_ROOT, 'scripts/dataset/raw')
const LABELS_DIR = path.join(REPO_ROOT, 'scripts/dataset/labels')
const ANNOT_PATH = path.join(REPO_ROOT, 'scripts/dataset/annotations.json')
const PORT = Number(process.env.PORT || 4321)

await fs.mkdir(LABELS_DIR, { recursive: true })

let annots = await loadAnnots()

async function loadAnnots() {
  try {
    return JSON.parse(await fs.readFile(ANNOT_PATH, 'utf8'))
  } catch {
    return {}
  }
}

async function listFrames() {
  const files = await fs.readdir(RAW_DIR)
  return files.filter((f) => /\.(jpe?g|png)$/i.test(f)).sort()
}

/**
 * points: [[x,y,occluded], ...4] normalized. Order tl, tr, br, bl.
 * Returns a YOLOv8-pose label line (bbox = tight box around the 4 corners).
 */
function toYoloLine(points) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v))
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const cx = clamp01((minX + maxX) / 2)
  const cy = clamp01((minY + maxY) / 2)
  const w = clamp01(Math.max(1e-4, maxX - minX))
  const h = clamp01(Math.max(1e-4, maxY - minY))
  const kp = points
    .map(
      (p) =>
        `${clamp01(p[0]).toFixed(6)} ${clamp01(p[1]).toFixed(6)} ${p[2] ? 1 : 2}`,
    )
    .join(' ')
  return `0 ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)} ${kp}`
}

function labelTxtPath(file) {
  return path.join(LABELS_DIR, file.replace(/\.[^.]+$/, '') + '.txt')
}

async function writeLabel(file, points) {
  await fs.writeFile(labelTxtPath(file), toYoloLine(points) + '\n')
}

async function removeLabel(file) {
  await fs.rm(labelTxtPath(file), { force: true })
}

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/') {
      const html = await fs.readFile(path.join(__dirname, 'index.html'))
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    if (url.pathname === '/api/state') {
      const frames = await listFrames()
      return Response.json({ frames, annots })
    }

    if (url.pathname.startsWith('/raw/')) {
      const name = path.basename(
        decodeURIComponent(url.pathname.slice('/raw/'.length)),
      )
      try {
        const buf = await fs.readFile(path.join(RAW_DIR, name))
        return new Response(buf, {
          headers: {
            'content-type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
          },
        })
      } catch {
        return new Response('not found', { status: 404 })
      }
    }

    if (url.pathname === '/api/label' && req.method === 'POST') {
      const body = await req.json()
      const { file, points, skipped } = body
      if (!file)
        return Response.json({ ok: false, error: 'no file' }, { status: 400 })
      if (skipped) {
        annots[file] = { skipped: true }
        await removeLabel(file)
      } else if (Array.isArray(points) && points.length === 4) {
        annots[file] = { points, skipped: false }
        await writeLabel(file, points)
      } else {
        delete annots[file]
        await removeLabel(file)
      }
      await fs.writeFile(ANNOT_PATH, JSON.stringify(annots))
      return Response.json({ ok: true })
    }

    return new Response('not found', { status: 404 })
  },
})

const frames = await listFrames()
console.log(
  `[label] ${frames.length} frames in ${path.relative(REPO_ROOT, RAW_DIR)}`,
)
console.log(`[label] open  http://localhost:${PORT}`)
console.log(
  `[label] labels → ${path.relative(REPO_ROOT, LABELS_DIR)}/  state → ${path.relative(REPO_ROOT, ANNOT_PATH)}`,
)
