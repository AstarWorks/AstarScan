/**
 * YomiToku OCR via Python subprocess.
 *
 * YomiToku (kotaro-kinoshita/yomitoku) is the strongest open-source
 * Japanese OCR as of May 2026 (NLS 0.770, beats PaddleOCR / NDLOCR).
 * It runs on CPU comfortably, no GPU required.
 *
 * Strategy:
 *   - Spawn `yomitoku <imageDir> -f json -o <outDir> -d cpu --reading_order auto`
 *   - YomiToku reads the dir, writes one JSON per image:
 *       `<basename>_<image>_p1.json`
 *   - We parse the JSON and return paragraph + figure arrays plus the
 *     concatenated raw_text.
 *
 * Models are downloaded from HuggingFace Hub on first use (~150 MB total,
 * cached in ~/.cache/huggingface). Subsequent runs skip the download.
 *
 * Per-image runtime: ~5-8s warm on a 16-core CPU.
 */

import { spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'

const YOMITOKU_BIN = process.env.YOMITOKU_BIN ??
  path.resolve(process.cwd(), '.venv-yomitoku/bin/yomitoku')

/**
 * @param {string} imagePath  — absolute path to JPG/PNG
 * @returns {Promise<{
 *   paragraphs: Array<{contents:string, box:number[], direction:string, order?:number}>,
 *   figures: Array<{box:number[]}>,
 *   raw_text: string,
 *   duration_ms: number,
 * }>}
 */
export async function runYomiToku(imagePath) {
  if (!fs.existsSync(YOMITOKU_BIN)) {
    throw new Error(
      `yomitoku binary not found at ${YOMITOKU_BIN}. Install with:\n` +
      `python3 -m venv .venv-yomitoku && ` +
      `.venv-yomitoku/bin/pip install yomitoku`,
    )
  }

  // YomiToku writes <basename of image>_<image-stem>_p1.json to outDir.
  // To make output filenames predictable we work in a temp subdir per call.
  const outDir = await fsp.mkdtemp(path.join('/tmp', 'yomitoku-'))
  const t0 = Date.now()
  await runProcess(YOMITOKU_BIN, [
    '-f', 'json',
    '-o', outDir,
    '-d', 'cpu',
    '--reading_order', 'auto',
    imagePath,
  ])
  const duration_ms = Date.now() - t0

  // Locate the produced JSON (yomitoku names it after the image's path).
  const entries = await fsp.readdir(outDir)
  const jsonName = entries.find((n) => n.endsWith('.json'))
  if (!jsonName) {
    throw new Error(`YomiToku produced no JSON in ${outDir}: ${entries.join(',')}`)
  }
  const raw = await fsp.readFile(path.join(outDir, jsonName), 'utf8')
  const data = JSON.parse(raw)

  await fsp.rm(outDir, { recursive: true, force: true })

  const paragraphs = (data.paragraphs ?? []).map((p) => ({
    contents: p.contents ?? '',
    box: p.box,
    direction: p.direction ?? 'horizontal',
    order: p.order,
  }))
  const figures = (data.figures ?? []).map((f) => ({ box: f.box }))
  const raw_text = paragraphs.map((p) => p.contents).join('\n')

  return { paragraphs, figures, raw_text, duration_ms }
}

function runProcess(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (b) => { err += b.toString() })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))
    })
  })
}

/**
 * Batch OCR: feed a whole directory of images at once so YomiToku amortizes
 * model load across N images. Much faster than calling runYomiToku() per file.
 *
 * @param {string} imageDir  — directory containing JPGs
 * @returns {Promise<Map<string, {paragraphs, figures, raw_text}>>}
 *   keyed by image basename (without extension)
 */
export async function runYomiTokuBatch(imageDir) {
  if (!fs.existsSync(YOMITOKU_BIN)) {
    throw new Error(`yomitoku binary not found at ${YOMITOKU_BIN}`)
  }
  const outDir = await fsp.mkdtemp(path.join('/tmp', 'yomitoku-batch-'))
  await runProcess(YOMITOKU_BIN, [
    '-f', 'json',
    '-o', outDir,
    '-d', 'cpu',
    '--reading_order', 'auto',
    imageDir,
  ])

  const entries = (await fsp.readdir(outDir)).filter((n) => n.endsWith('.json'))
  // YomiToku names output as <imageDirBasename>_<image-stem>_p1.json
  const prefix = path.basename(imageDir) + '_'

  const out = new Map()
  for (const e of entries) {
    let stem = e
    if (e.startsWith(prefix)) stem = e.slice(prefix.length)
    stem = stem.replace(/_p\d+\.json$/, '').replace(/\.json$/, '')
    const data = JSON.parse(await fsp.readFile(path.join(outDir, e), 'utf8'))
    const paragraphs = (data.paragraphs ?? []).map((p) => ({
      contents: p.contents ?? '',
      box: p.box,
      direction: p.direction ?? 'horizontal',
      order: p.order,
    }))
    const figures = (data.figures ?? []).map((f) => ({ box: f.box }))
    const raw_text = paragraphs.map((p) => p.contents).join('\n')
    out.set(stem, { paragraphs, figures, raw_text })
  }
  await fsp.rm(outDir, { recursive: true, force: true })
  return out
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const imagePath = process.argv[2] ?? '/tmp/mp4-3-sample/frame-04.jpg'
  console.log(`[ocr-yomitoku] image=${imagePath}`)
  const result = await runYomiToku(imagePath)
  console.log(`[ocr-yomitoku] ${result.duration_ms} ms, ${result.paragraphs.length} paragraphs`)
  for (const p of result.paragraphs) {
    console.log(`  [${p.order}] ${p.direction} ${JSON.stringify(p.box)}`)
    for (const line of p.contents.split('\n')) {
      console.log(`      ${line}`)
    }
  }
}
