/// <reference lib="webworker" />
/**
 * Page-number ("ノンブル") reader, in a Web Worker so the capture screen's
 * corner model keeps its frame rate while a page is read.
 *
 * A page number is a short, isolated piece of print in the top or bottom
 * margin. This finds those pieces itself (the Android capture screen's
 * "folio pass"): dark, neutral-coloured ink components in the outer bands
 * of the warped page, a thumb or its shadow left out (too big, or skin
 * coloured), grouped into lines. Each line is read with PaddleOCR's
 * PP-OCRv4 recogniser (scripts/fetch-folio-model.sh, 10.8 MB, served by
 * the app). The caller picks the number with scan-core's `pickPageNumbers`.
 *
 * NDLOCR-Lite's whole-page path (1024² layout + three PARSeq recognisers,
 * ~147 MB) is far too slow for "the number within a second", and its
 * PARSeq read these isolated numbers badly (6 of 36 on the book clips).
 */

import * as ort from 'onnxruntime-web/wasm'

const MODEL_URL = '/models/ppocr-rec.onnx'
const KEYS_URL = '/models/ppocr-keys.txt'
const IN_H = 48
const MAX_W = 640

/** Outer band of the page searched for the number (share of its height). */
const BAND = 0.12
/** Width the page is read at. */
const PAGE_W = 1000

export interface FolioLine {
  text: string
  /** Centre, 0..1 of the page. */
  cx: number
  cy: number
  conf: number
  /** Box in the page (0..1): x0, y0, x1, y1. */
  box: [number, number, number, number]
}

export type FolioIn =
  | { type: 'init' }
  | { type: 'read'; id: number; page: ImageBitmap }

export type FolioOut =
  | { type: 'ready'; threads: number; ms: number }
  | { type: 'error'; id?: number; message: string }
  | { type: 'lines'; id: number; lines: FolioLine[]; ms: number; boxes: number }

let session: ort.InferenceSession | null = null
let keys: string[] = []

async function init(): Promise<void> {
  const t0 = performance.now()
  ort.env.wasm.wasmPaths = '/ort/'
  const isolated =
    (self as unknown as { crossOriginIsolated?: boolean })
      .crossOriginIsolated === true
  ort.env.wasm.numThreads = isolated
    ? Math.max(1, Math.min(2, navigator.hardwareConcurrency || 1))
    : 1
  ort.env.logLevel = 'error'
  const [model, keyText] = await Promise.all([
    fetch(MODEL_URL).then((r) => {
      if (!r.ok) throw new Error(`${MODEL_URL}: ${r.status}`)
      return r.arrayBuffer()
    }),
    fetch(KEYS_URL).then((r) => {
      if (!r.ok) throw new Error(`${KEYS_URL}: ${r.status}`)
      return r.text()
    }),
  ])
  // CTC classes: 0 = blank, then the key file's lines, then a space.
  keys = [
    '',
    ...keyText
      .replace(/\r/g, '')
      .split('\n')
      .filter((l, i, a) => i < a.length - 1 || l !== ''),
    ' ',
  ]
  session = await ort.InferenceSession.create(model, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  post({
    type: 'ready',
    threads: ort.env.wasm.numThreads ?? 1,
    ms: performance.now() - t0,
  })
}

function post(m: FolioOut): void {
  ;(self as unknown as Worker).postMessage(m)
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Lines of isolated print in rows [y0, y1) of the page. Ink: darker than
 * 0.72 × the band's paper. Characters are the ink's connected components
 * (8-neighbour) of a plausible size and neutral colour; characters side by
 * side (overlapping rows, gap under ~0.9 × their height) form a line.
 */
function lineBoxes(
  g: Uint8ClampedArray,
  sat: Uint8ClampedArray,
  w: number,
  h: number,
  y0: number,
  y1: number,
): Box[] {
  const bh = y1 - y0
  const hist = new Uint32Array(256)
  for (let i = y0 * w; i < y1 * w; i++) hist[g[i]!]!++
  let acc = 0
  let paper = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!
    if (acc >= bh * w * 0.7) {
      paper = v
      break
    }
  }
  const thr = paper * 0.72
  const minH = h * 0.005
  const maxH = h * 0.035
  const label = new Int32Array(w * bh).fill(-1)
  const stack: number[] = []
  const chars: (Box & { n: number })[] = []
  for (let i = 0; i < w * bh; i++) {
    if (label[i]! >= 0 || g[i + y0 * w]! >= thr) continue
    let x0 = w
    let x1 = 0
    let yy0 = bh
    let yy1 = 0
    let n = 0
    let satSum = 0
    label[i] = 1
    stack.push(i)
    while (stack.length) {
      const j = stack.pop()!
      const x = j % w
      const y = (j - x) / w
      n++
      satSum += sat[j + y0 * w]!
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < yy0) yy0 = y
      if (y > yy1) yy1 = y
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= bh) continue
          const k = ny * w + nx
          if (label[k]! < 0 && g[k + y0 * w]! < thr) {
            label[k] = 1
            stack.push(k)
          }
        }
    }
    const cw = x1 - x0 + 1
    const ch = yy1 - yy0 + 1
    if (ch > maxH || cw > maxH * 3) continue
    if (ch < minH && cw < minH) continue
    if (x0 <= 0 || x1 >= w - 1) continue
    if (satSum / n > 40) continue
    chars.push({ x0, y0: yy0 + y0, x1, y1: yy1 + y0, n })
  }
  chars.sort((a, b) => a.x0 - b.x0)
  const lines: Box[] = []
  for (const c of chars) {
    const line = lines.find((l) => {
      const ov = Math.min(l.y1, c.y1) - Math.max(l.y0, c.y0)
      const hh = Math.max(l.y1 - l.y0, c.y1 - c.y0) + 1
      return (
        ov >= 0.4 * Math.min(l.y1 - l.y0 + 1, c.y1 - c.y0 + 1) &&
        c.x0 - l.x1 <= 0.9 * hh
      )
    })
    if (line) {
      line.x0 = Math.min(line.x0, c.x0)
      line.y0 = Math.min(line.y0, c.y0)
      line.x1 = Math.max(line.x1, c.x1)
      line.y1 = Math.max(line.y1, c.y1)
    } else lines.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 })
  }
  return lines
}

/** Candidate number lines: short lines nearest the page's top / bottom edge. */
function candidates(
  g: Uint8ClampedArray,
  sat: Uint8ClampedArray,
  w: number,
  h: number,
): Box[] {
  const band = Math.round(h * BAND)
  const all = [
    ...lineBoxes(g, sat, w, h, 0, band),
    ...lineBoxes(g, sat, w, h, h - band, h),
  ]
  const ok = all.filter(
    (b) => b.x1 - b.x0 + 1 <= w * 0.5 && b.y1 - b.y0 + 1 >= h * 0.006,
  )
  // Short lines (a number alone) first, then nearest the page edge; a
  // running head with the number at its end comes after them.
  const short = (b: Box) => (b.x1 - b.x0 + 1 <= w * 0.15 ? 0 : 1)
  ok.sort(
    (a, b) =>
      short(a) - short(b) ||
      Math.min(a.y0, h - a.y1) - Math.min(b.y0, h - b.y1),
  )
  return ok.slice(0, 6)
}

/** The line (padded) at 48 px high, RGB normalised to [−1, 1]. */
function toTensor(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  b: Box,
  work: OffscreenCanvas,
  src: OffscreenCanvas,
): ort.Tensor {
  void rgba
  void h
  const bh = b.y1 - b.y0 + 1
  const pad = Math.round(bh * 0.35)
  const sx = Math.max(0, b.x0 - pad)
  const sy = Math.max(0, b.y0 - pad)
  const sw = Math.min(w - sx, b.x1 - b.x0 + 1 + 2 * pad)
  const sh = Math.min(src.height - sy, bh + 2 * pad)
  const tw = Math.max(16, Math.min(MAX_W, Math.round((sw * IN_H) / sh)))
  work.width = tw
  work.height = IN_H
  const ctx = work.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, tw, IN_H)
  const px = ctx.getImageData(0, 0, tw, IN_H).data
  const n = tw * IN_H
  const data = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    data[i] = (px[i * 4]! / 255 - 0.5) / 0.5
    data[n + i] = (px[i * 4 + 1]! / 255 - 0.5) / 0.5
    data[2 * n + i] = (px[i * 4 + 2]! / 255 - 0.5) / 0.5
  }
  return new ort.Tensor('float32', data, [1, 3, IN_H, tw])
}

/** Greedy CTC decode: text and the mean probability of its characters. */
function decode(t: ort.Tensor): { text: string; conf: number } {
  const [, steps, classes] = t.dims as number[]
  const d = t.data as Float32Array
  let text = ''
  let sum = 0
  let n = 0
  let prev = 0
  for (let i = 0; i < steps!; i++) {
    const off = i * classes!
    let best = 0
    for (let j = 1; j < classes!; j++)
      if (d[off + j]! > d[off + best]!) best = j
    if (best !== 0 && best !== prev) {
      text += keys[best] ?? ''
      sum += d[off + best]!
      n++
    }
    prev = best
  }
  return { text, conf: n ? sum / n : 0 }
}

async function read(id: number, page: ImageBitmap): Promise<void> {
  const t0 = performance.now()
  if (!session) throw new Error('not ready')
  const w = PAGE_W
  const h = Math.round((page.height / page.width) * PAGE_W)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(page, 0, 0, w, h)
  page.close()
  const rgba = ctx.getImageData(0, 0, w, h).data
  const g = new Uint8ClampedArray(w * h)
  const sat = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4]!
    const gg = rgba[i * 4 + 1]!
    const b = rgba[i * 4 + 2]!
    g[i] = (r * 299 + gg * 587 + b * 114) / 1000
    sat[i] = Math.max(r, gg, b) - Math.min(r, gg, b)
  }
  const boxes = candidates(g, sat, w, h)
  const work = new OffscreenCanvas(16, IN_H)
  const lines: FolioLine[] = []
  for (const b of boxes) {
    const tensor = toTensor(rgba, w, h, b, work, canvas)
    const out = await session.run({ [session.inputNames[0]!]: tensor })
    const r = decode(out[session.outputNames[0]!]!)
    tensor.dispose()
    if (r.text)
      lines.push({
        text: r.text,
        cx: (b.x0 + b.x1) / 2 / w,
        cy: (b.y0 + b.y1) / 2 / h,
        conf: r.conf,
        box: [b.x0 / w, b.y0 / h, (b.x1 + 1) / w, (b.y1 + 1) / h],
      })
  }
  post({
    type: 'lines',
    id,
    lines,
    ms: performance.now() - t0,
    boxes: boxes.length,
  })
}

self.onmessage = (e: MessageEvent<FolioIn>) => {
  const m = e.data
  if (m.type === 'init')
    init().catch((err: unknown) =>
      post({ type: 'error', message: String(err) }),
    )
  else if (m.type === 'read')
    read(m.id, m.page).catch((err: unknown) =>
      post({ type: 'error', id: m.id, message: String(err) }),
    )
}
