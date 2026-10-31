#!/usr/bin/env bun
/**
 * Collapse the raw frames into distinct "scenes" by perceptual-hash
 * grouping (consecutive video frames are near-identical). Used to bound
 * auto-labeling work: label one representative per scene, then propagate
 * its corners to the whole group as a seed the human can fine-tune.
 *
 *   bun scripts/label/scene-reps.mjs
 *
 * Writes scripts/dataset/scene-reps.json:
 *   { groups: [ { rep, members: [...] }, ... ] }
 * and prints a spread of representative filenames to eyeball.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Canvas, loadImage } from '@napi-rs/canvas'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const RAW_DIR = path.join(REPO_ROOT, 'scripts/dataset/raw')
const OUT = path.join(REPO_ROOT, 'scripts/dataset/scene-reps.json')

const DUP_HAMMING = 8
const PHASH_SIZE = 8

async function phash(file) {
  const img = await loadImage(path.join(RAW_DIR, file))
  const c = new Canvas(PHASH_SIZE, PHASH_SIZE)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0, PHASH_SIZE, PHASH_SIZE)
  const d = ctx.getImageData(0, 0, PHASH_SIZE, PHASH_SIZE).data
  const n = PHASH_SIZE * PHASH_SIZE
  const g = new Float64Array(n)
  let sum = 0
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    g[j] = v
    sum += v
  }
  const mean = sum / n
  let h = 0n
  for (let j = 0; j < n; j += 1) if (g[j] > mean) h |= 1n << BigInt(j)
  return h
}

function hamming(a, b) {
  let x = a ^ b
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

const files = (await fs.readdir(RAW_DIR)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort()
const hashes = await Promise.all(files.map(phash))

// Union-find by Hamming ≤ DUP_HAMMING.
const parent = files.map((_, i) => i)
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
for (let i = 0; i < files.length; i += 1) {
  for (let j = i + 1; j < files.length; j += 1) {
    if (hamming(hashes[i], hashes[j]) <= DUP_HAMMING) {
      const a = find(i)
      const b = find(j)
      if (a !== b) parent[a] = b
    }
  }
}
const byRoot = new Map()
for (let i = 0; i < files.length; i += 1) {
  const r = find(i)
  if (!byRoot.has(r)) byRoot.set(r, [])
  byRoot.get(r).push(files[i])
}
const groups = [...byRoot.values()]
  .map((members) => ({ rep: members[Math.floor(members.length / 2)], members }))
  .sort((a, b) => a.rep.localeCompare(b.rep))

await fs.writeFile(OUT, JSON.stringify({ groups }, null, 0))

console.log(`frames=${files.length}  distinct scenes=${groups.length}`)
console.log(`group sizes: min=${Math.min(...groups.map((g) => g.members.length))} max=${Math.max(...groups.map((g) => g.members.length))} median=${groups.map((g) => g.members.length).sort((a, b) => a - b)[Math.floor(groups.length / 2)]}`)
console.log('representatives (one per scene):')
for (const g of groups) console.log(`  ${g.rep}  (x${g.members.length})`)
