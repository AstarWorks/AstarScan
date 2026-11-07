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
 * PARSeq read these isolated numbers badly (at most 4 of 36 on the book clips).
 */

import * as ort from 'onnxruntime-web/wasm'
import { folioZone, type FolioZone } from '@astarworks/scan-core/pipeline'

const MODEL_URL = '/models/ppocr-rec.onnx'
const KEYS_URL = '/models/ppocr-keys.txt'
const IN_H = 48
const MAX_W = 640

/** Outer band of the page searched for the number (share of its height). */
const BAND = 0.12
/** Width the page is read at. */
const PAGE_W = 1000
/**
 * Ink is this much darker than the paper round it. The paper's level is
 * taken per cell of a grid (INK_CELL of the page's height a side, its 70th
 * percentile from dark, interpolated between cell centres), so the
 * threshold follows the glare, the gutter's shade and the hand's shadow.
 * Before, ink was 28 % darker than one level for the whole band: thin
 * print 8–10 px tall is blurred to a lighter grey than the body, and book
 * 4's "Page 64" (Inter, under glare) bottomed out at 73 % of the paper —
 * not one of its pixels counted, the number was never a candidate. The
 * body text on the same page reached 55 %; paper noise and show-through
 * stay within 5 %.
 */
const INK_DARKER = 0.15
/**
 * A stroke this much darker than the paper is not ink on its own, but joins
 * a line of ink beside it. A thin stroke blurs to a light grey: the kanji
 * 一 of a positional folio 「一二四」 (book 5, IPA P Gothic, 11 px) was
 * lighter than INK_DARKER, the line began at 二, and every page read 100
 * low ("二四" at 0.83). With the 一 in the crop the reader gives 一二四.
 */
const INK_FAINT = 0.07
const INK_CELL = 0.05
/**
 * A cell darker than this share of the band's level is not paper (a thumb,
 * the desk beyond the page's edge): it takes the band's level instead.
 */
const INK_NOT_PAPER = 0.6

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
  | {
      type: 'read'
      id: number
      page: ImageBitmap
      /**
       * Where this book prints its numbers, once learned (scan-core
       * `learnedFolioZone`), and which page this is: lines there are read
       * first. Only a few lines are read per page (time), and the running
       * head's fragments — short and as near the edge — can fill them
       * before the number (book 2's top-outer "217" behind six pieces of
       * "NOTES ON THE WHALE FISHERY").
       */
      zone?: FolioZone
      side?: 'L' | 'R' | 'S'
    }

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
  /** Padding round the crop on the left / right (share of the line's height; default PAD). */
  padL?: number
  padR?: number
}

/** A character of a line: its box, pixels, and whether it is ink on its own (not faint). */
interface Char extends Box {
  n: number
  strong: boolean
}

interface Line extends Box {
  chars: Char[]
}

const PAD = 0.35

/** Grey level under which 70 % of `n` counted pixels lie. */
function percentile70(hist: Uint32Array, n: number): number {
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!
    if (acc >= n * 0.7) return v
  }
  return 255
}

/**
 * Ink mask of rows [y0, y1) of the page: 2 where a pixel is INK_DARKER
 * darker than the paper's level round it (per cell, interpolated; see
 * INK_DARKER), 1 where it is INK_FAINT darker (a faint stroke), 0 paper.
 */
function inkMask(
  g: Uint8ClampedArray,
  w: number,
  h: number,
  y0: number,
  y1: number,
): Uint8Array {
  const bh = y1 - y0
  const bandHist = new Uint32Array(256)
  for (let i = y0 * w; i < y1 * w; i++) bandHist[g[i]!]!++
  const bandPaper = percentile70(bandHist, bh * w)
  const cell = Math.max(16, Math.round(h * INK_CELL))
  const cols = Math.max(1, Math.ceil(w / cell))
  const rows = Math.max(1, Math.ceil(bh / cell))
  const level = new Float32Array(cols * rows)
  const hist = new Uint32Array(256)
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      hist.fill(0)
      let n = 0
      const yEnd = Math.min(bh, (r + 1) * cell)
      const xEnd = Math.min(w, (c + 1) * cell)
      for (let y = r * cell; y < yEnd; y++)
        for (let x = c * cell; x < xEnd; x++) {
          hist[g[(y + y0) * w + x]!]!++
          n++
        }
      const p = percentile70(hist, n)
      level[r * cols + c] = p < INK_NOT_PAPER * bandPaper ? bandPaper : p
    }
  const ink = new Uint8Array(w * bh)
  for (let y = 0; y < bh; y++) {
    const fy = Math.min(rows - 1, Math.max(0, (y + 0.5) / cell - 0.5))
    const r0 = Math.floor(fy)
    const r1 = Math.min(rows - 1, r0 + 1)
    const ty = fy - r0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cols - 1, Math.max(0, (x + 0.5) / cell - 0.5))
      const c0 = Math.floor(fx)
      const c1 = Math.min(cols - 1, c0 + 1)
      const tx = fx - c0
      const paper =
        (level[r0 * cols + c0]! * (1 - tx) + level[r0 * cols + c1]! * tx) *
          (1 - ty) +
        (level[r1 * cols + c0]! * (1 - tx) + level[r1 * cols + c1]! * tx) * ty
      const v = g[(y + y0) * w + x]!
      if (v < paper * (1 - INK_DARKER)) ink[y * w + x] = 2
      else if (v < paper * (1 - INK_FAINT)) ink[y * w + x] = 1
    }
  }
  return ink
}

/** Whether `c` sits beside line `l` (rows overlapping, a small gap). */
function beside(l: Box, c: Box): boolean {
  const ov = Math.min(l.y1, c.y1) - Math.max(l.y0, c.y0)
  const hh = Math.max(l.y1 - l.y0, c.y1 - c.y0) + 1
  return (
    ov >= 0.4 * Math.min(l.y1 - l.y0 + 1, c.y1 - c.y0 + 1) &&
    c.x0 - l.x1 <= 0.9 * hh &&
    l.x0 - c.x1 <= 0.9 * hh
  )
}

function grow(l: Line, c: Char): void {
  l.x0 = Math.min(l.x0, c.x0)
  l.y0 = Math.min(l.y0, c.y0)
  l.x1 = Math.max(l.x1, c.x1)
  l.y1 = Math.max(l.y1, c.y1)
  l.chars.push(c)
}

function lineBox(chars: readonly Char[]): Line {
  const l: Line = {
    x0: Infinity,
    y0: Infinity,
    x1: -Infinity,
    y1: -Infinity,
    chars: [],
  }
  for (const c of chars) grow(l, c)
  return l
}

/**
 * A rule at one end of a line — "17 |", a vertical bar after the number —
 * is not part of the number: the reader reads it as a 1 ("171", "191",
 * "211" … at 0.8–0.97 on every page of a book whose folio was "17 |"; 20
 * apart, the order rule did not catch them). A bar stands out from the
 * digits beside it: taller than every other character of the line by a
 * fifth or more (it runs from the ascender to the descender), thin (its
 * width a third of its height or less — a 2 px stroke blurs to 8 px at the
 * 1000 px read width, 28 tall), and a space away. A digit 1 is as tall as
 * the other digits, and twice as wide as the bar.
 * The line is cut back to the other characters, and the crop's padding on
 * that side stops short of the bar.
 */
function withoutBars(l: Line): Line {
  const chars = [...l.chars].sort((a, b) => a.x0 - b.x0)
  if (chars.length < 2) return l
  const ends = [chars[0]!, chars[chars.length - 1]!]
  const drop = new Set<Char>()
  for (const c of ends) {
    const others = chars.filter((o) => o !== c)
    const oh = Math.max(...others.map((o) => o.y1 - o.y0 + 1))
    const ch = c.y1 - c.y0 + 1
    const cw = c.x1 - c.x0 + 1
    const nearest = Math.min(
      ...others.map((o) => Math.max(o.x0 - c.x1, c.x0 - o.x1)),
    )
    if (ch >= 1.2 * oh && cw <= 0.35 * ch && nearest >= 0.3 * ch) drop.add(c)
  }
  if (drop.size === 0 || drop.size === chars.length) return l
  const kept = chars.filter((c) => !drop.has(c))
  const out = lineBox(kept)
  const bh = out.y1 - out.y0 + 1
  for (const c of drop) {
    const gap = c.x0 > out.x1 ? c.x0 - out.x1 : out.x0 - c.x1
    const padEnd = Math.min(PAD, Math.max(0, gap / 2) / bh)
    if (c.x0 > out.x1) out.padR = padEnd
    else out.padL = padEnd
  }
  return out
}

/**
 * Lines of isolated print in rows [y0, y1) of the page. Ink: darker than
 * the paper round it (inkMask). Characters are the ink's connected
 * components (8-neighbour, faint pixels included) of a plausible size and
 * neutral colour; characters side by side (overlapping rows, gap under
 * ~0.9 × their height) form a line. A faint character (few of its pixels
 * ink on its own) does not start a line, but joins one beside it (the 一
 * of 一二四; see INK_FAINT). A bar at one end is left out (withoutBars).
 */
function lineBoxes(
  g: Uint8ClampedArray,
  sat: Uint8ClampedArray,
  w: number,
  h: number,
  y0: number,
  y1: number,
): Line[] {
  const bh = y1 - y0
  const ink = inkMask(g, w, h, y0, y1)
  // Colour of the paper (its pixels' median saturation): under warm or
  // cool light the print takes the paper's tint, so skin (a thumb) is
  // told from print by being much more coloured than the paper, not by a
  // fixed saturation (another-book check: warm light put print at 45–55).
  const satHist = new Uint32Array(256)
  let paperPx = 0
  for (let i = 0; i < w * bh; i++)
    if (!ink[i]) {
      satHist[sat[i + y0 * w]!]!++
      paperPx++
    }
  let paperSat = 0
  for (let v = 0, c = 0; v < 256; v++) {
    c += satHist[v]!
    if (c >= paperPx / 2) {
      paperSat = v
      break
    }
  }
  const minH = h * 0.005
  const maxH = h * 0.035
  const label = new Int32Array(w * bh).fill(-1)
  const stack: number[] = []
  const chars: Char[] = []
  for (let i = 0; i < w * bh; i++) {
    if (label[i]! >= 0 || !ink[i]) continue
    let x0 = w
    let x1 = 0
    let yy0 = bh
    let yy1 = 0
    let n = 0
    let strongN = 0
    let satSum = 0
    label[i] = 1
    stack.push(i)
    while (stack.length) {
      const j = stack.pop()!
      const x = j % w
      const y = (j - x) / w
      n++
      if (ink[j] === 2) strongN++
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
          if (label[k]! < 0 && ink[k]) {
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
    if (satSum / n > paperSat + 35) continue
    chars.push({
      x0,
      y0: yy0 + y0,
      x1,
      y1: yy1 + y0,
      n,
      strong: strongN >= Math.max(3, 0.25 * n),
    })
  }
  chars.sort((a, b) => a.x0 - b.x0)
  const lines: Line[] = []
  for (const c of chars) {
    if (!c.strong) continue
    const line = lines.find((l) => beside(l, c))
    if (line) grow(line, c)
    else lines.push(lineBox([c]))
  }
  // Faint characters join a line beside them (either side), never start one.
  const faint = chars.filter((c) => !c.strong)
  for (const c of faint) {
    const line = lines.find((l) => beside(l, c))
    if (line) grow(line, c)
  }
  for (const c of [...faint].reverse()) {
    const line = lines.find((l) => !l.chars.includes(c) && beside(l, c))
    if (line) grow(line, c)
  }
  return lines.map(withoutBars)
}

/** Candidate number lines: short lines nearest the page's top / bottom edge. */
function candidates(
  g: Uint8ClampedArray,
  sat: Uint8ClampedArray,
  w: number,
  h: number,
  zone?: FolioZone,
  side: 'L' | 'R' | 'S' = 'S',
): Box[] {
  const band = Math.round(h * BAND)
  const all = [
    ...lineBoxes(g, sat, w, h, 0, band),
    ...lineBoxes(g, sat, w, h, h - band, h),
  ]
  const ok = all.filter(
    (b) => b.x1 - b.x0 + 1 <= w * 0.5 && b.y1 - b.y0 + 1 >= h * 0.006,
  )
  // Lines where this book prints its numbers first (once that is known),
  // then short lines (a number alone), then nearest the page edge; a
  // running head with the number at its end comes after them.
  const inZone = (b: Box) =>
    zone &&
    folioZone((b.x0 + b.x1 + 1) / 2 / w, (b.y0 + b.y1 + 1) / 2 / h, side) ===
      zone
      ? 0
      : 1
  const short = (b: Box) => (b.x1 - b.x0 + 1 <= w * 0.15 ? 0 : 1)
  ok.sort(
    (a, b) =>
      inZone(a) - inZone(b) ||
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
  const pad = Math.round(bh * PAD)
  const padL = Math.round(bh * (b.padL ?? PAD))
  const padR = Math.round(bh * (b.padR ?? PAD))
  const sx = Math.max(0, b.x0 - padL)
  const sy = Math.max(0, b.y0 - pad)
  const sw = Math.min(w - sx, b.x1 - b.x0 + 1 + padL + padR)
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

async function read(
  id: number,
  page: ImageBitmap,
  zone?: FolioZone,
  side?: 'L' | 'R' | 'S',
): Promise<void> {
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
  const boxes = candidates(g, sat, w, h, zone, side)
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
    read(m.id, m.page, m.zone, m.side).catch((err: unknown) =>
      post({ type: 'error', id: m.id, message: String(err) }),
    )
}
