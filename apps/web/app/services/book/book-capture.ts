/**
 * Book capture engine: the browser version of the capture screen agreed
 * with the client (docs/ux/ideal-capture.html).
 *
 *   camera frame → DocAligner corners (page-detector.ts, every frame)
 *     → orange while the paper is not all in view or moving
 *     → still for STILL_MS: green line runs once round the frame (SWEEP_MS)
 *     → auto-capture: ✓ + beep + vibration at once
 *     → spread (frame wider than tall): split at the gutter (scan-core
 *       gutter.ts) into two pages, each warped on its own; single page:
 *       cut back to the gutter when the frame ran past it
 *     → page numbers read in a worker (folio.worker.ts), the ✓ banner then
 *       says "34・35 ページ 撮れた"
 *     → coverage (scan-core book-coverage.ts): a newly skipped page turns
 *       red at once (two vibrations), going back and taking it turns it
 *       green; a page taken before is not taken again ("撮影済み", grey).
 *
 * Same-page tests (has the page been turned? taken before?) compare ORB
 * features of the warped page (scan-core orb.ts on OpenCV.js), as the
 * Android screen does with PageMatch.kt.
 *
 * No Vue here: the screen (components/book/BookCamera.vue) renders `state`.
 */

import {
  applyHomography,
  bookCoverage,
  completeSpread,
  curveAt,
  facingHalfNumber,
  fitPageEdges,
  flattenGeometry,
  PAGE_FLATTEN,
  unitToQuad,
  filledGaps,
  findEdgeGutter,
  findSpreadGutter,
  newGaps,
  folioZone,
  learnedFolioZone,
  pageRangeLabel,
  paperViewChange,
  paperViewMask,
  parsePageNumberToken,
  pickPageNumbers,
  type FolioZone,
  quadAspect,
  settleBookNumbers,
  sheetWithNumbers,
  shotFrameQuad,
  splitSpreadQuad,
  SPREAD_MIN_ASPECT,
  trimQuadSides,
  type BookCoverage,
  type BookGap,
  type BookPageRead,
  type BookSheet,
  type CanvasLike,
  type GutterLine,
  type OrbResult,
  detectViews,
  ViewSearch,
  type DetectView,
} from '@astarworks/scan-core/pipeline'
import type { Point, Quad } from '@astarworks/scan-core'

import { beepCaptured, vibrateCaptured } from '../capture-feedback'
import { loadOpenCV } from '../opencv-loader'
import { getPipelineOps } from '../pipeline-ops'
import type { OrtBackend } from '../ort-model-loader'
import { MIN_PEAK, PageDetector, type PageDetection } from './page-detector'
import type { FolioIn, FolioLine, FolioOut } from './folio.worker'

// --- timing (docs/ux/ideal-capture.html: "撮れた" within 1 s of stillness) ---
/** Frame and print must hold still this long before the green sweep starts. */
export const STILL_MS = 250
/** The green line's one lap round the frame; the shot is taken at its end. */
export const SWEEP_MS = 400
/** Corners are compared with the frame this long ago. */
const STILL_WINDOW_MS = 250
/** Corner movement allowed while "still" (share of the frame's diagonal). */
const STILL_CORNER = 0.04
/** Mean grey change of the 32×24 view allowed while still (0..255). */
const STILL_VIEW = 9
/** ...and below this the picture is still whatever the corners do. */
const STILL_VIEW_CALM = 4.5
/**
 * A frame where the corner model loses the paper (weakest corner under
 * MIN_PEAK) keeps the stillness when it comes within this long of the last
 * frame that found it and the picture has not changed since by more than
 * a still frame may change (≤ STILL_VIEW): a blink of the model, not a turn. Android keeps it over
 * one analysed frame without the paper (CaptureActivity NULL_RESET 2, ~0.7 s
 * a frame). Without it, book 2's 96〜99 (1440×1080) lost every still spell:
 * the weakest corner went 0.89 → 0.06 → 0.79 on a picture changing by 1–3
 * grey levels.
 */
const BLINK_MS = 700
/**
 * The shot's frame is taken from the corner model's detections within this
 * long before the shot (the still spell), each corner from the detections
 * the model was surest of for it (scan-core shotFrameQuad). While the
 * picture is calm the spell goes on whatever the corners do
 * (STILL_VIEW_CALM), and the model can switch to another reading of a
 * corner for frames at a time: book 1's framed single-land-white p39 had
 * its top-left corner at (−2, 48) for 12 frames of the spell and at
 * (101, 318) for the 3 frames before the shot; book 3's framed single page
 * 137 at (71, 116) in 6 frames and at (93, 320) in 7 — the median of the
 * last frames took the wrong one each time and the frame covered 80–85 %
 * of the page (無表示). The model's peak for the wrong reading was lower
 * (0.42–0.69 against 0.71–0.85).
 */
const SPELL_QUAD_MS = 1000
/** The view drifted this far from the one taken: maybe a new page, judge again. */
const TURNED_VIEW = 14
/** The frame must cover this share of the picture to be a page. */
const MIN_AREA = 0.12
/** ORB inliers (400 px pages) at or above which two views are the same page. */
const SAME_PAGE_INLIERS = 14
/** Page number lines read with less confidence than this are ignored. */
const MIN_NUMBER_CONF = 0.7
/**
 * ...unless the line reads as exactly the number the facing page predicts
 * (a spread's other half ± 1; scan-core facingHalfNumber): then this much
 * confidence is enough. A chance misread landing on that one number is
 * rare; the sure half already carries the misread risk of its own.
 */
const LOW_NUMBER_CONF = 0.4
/** Numbers further than this from every number read so far are not taken. */
const FAR_NUMBER = 60
/** Number lines lower than this (page px) are not read: too few pixels. */
const MIN_NUMBER_PX = 5
/** Page-number readers (workers) running side by side. */
const NUMBER_READERS = 2
/** Long side the pages are kept at. */
const PAGE_LONG = 1600

export type FrameTone = 'none' | 'search' | 'hold' | 'sweep' | 'done' | 'dup'

export interface BookPage {
  id: string
  sheetId: string
  /** 'L' / 'R' half of a spread, or 'S' a single page. */
  side: 'L' | 'R' | 'S'
  /** The page as kept: flattened when the edges were found, else straight. */
  canvas: HTMLCanvasElement
  /** The plain four-corner warp (before the curvature correction). */
  straight: HTMLCanvasElement
  /** Curvature corrected; or why not (PageFlatten.kt wording). */
  flattened: boolean
  flattenWhy: string
  /** Frame in the camera picture. */
  quad: Quad
  read: BookPageRead
}

export interface Banner {
  tone: 'ok' | 'bad' | 'mute'
  lines: string[]
  at: number
}

export interface BookState {
  tone: FrameTone
  /** Frame to draw, in video px. */
  quad: Quad | null
  /** 0..1 of the green line's lap. */
  sweep: number
  /** Pill at the top of the view. */
  pill: string
  banner: Banner | null
  coverage: BookCoverage
  /** Short white flash after a capture (performance.now() of the shot). */
  flashAt: number
  fps: number
  inferMs: number
  backend: OrtBackend | null
  threads: number
  numberThreads: number
  ready: boolean
  error: string
}

interface Sheet extends BookSheet {
  /** As shown and counted (settleBookNumbers may hold the read back). */
  pages: BookPageRead[]
  /** As read (both halves of a spread completed), before judging. */
  readPages: BookPageRead[]
  orb: OrbResult | null
  takenAt: number
  /** Spread / single, to show "34・35" or "46". */
  spread: boolean
}

type ProbeFn = (e: Record<string, unknown>) => void
function probe(ev: Record<string, unknown>): void {
  const fn = (globalThis as { __astarProbe?: ProbeFn }).__astarProbe
  if (fn) fn(ev)
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Mean grey difference of two 32×24 views. */
function viewChange(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

function median3(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/** Per-corner median of a few quads. */
function medianQuad(qs: readonly Quad[]): Quad {
  const k = ['tl', 'tr', 'br', 'bl'] as const
  const out = {} as Record<(typeof k)[number], Point>
  for (const c of k)
    out[c] = {
      x: median3(qs.map((q) => q[c].x)),
      y: median3(qs.map((q) => q[c].y)),
    }
  return out
}

function quadArea(q: Quad): number {
  const p = [q.tl, q.tr, q.br, q.bl]
  let s = 0
  for (let i = 0; i < 4; i++) {
    const a = p[i]!
    const b = p[(i + 1) % 4]!
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

function convex(q: Quad): boolean {
  const p = [q.tl, q.tr, q.br, q.bl]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = p[i]!
    const b = p[(i + 1) % 4]!
    const c = p[(i + 2) % 4]!
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (z === 0) continue
    if (sign === 0) sign = Math.sign(z)
    else if (Math.sign(z) !== sign) return false
  }
  return true
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

export class BookCapture {
  readonly state: BookState
  readonly pages: BookPage[] = []
  readonly sheets: Sheet[] = []

  #detector = new PageDetector()
  /**
   * Which view of the picture to show the corner model (scan-core
   * view-search): the whole picture, or — when that shows it no paper, as
   * a single page taken in a landscape picture with the facing page in
   * view does — the padded picture or a window over one half of it.
   */
  #views: DetectView[] = []
  #viewSearch = new ViewSearch()
  #video: HTMLVideoElement | null = null
  #running = false
  #onChange: () => void
  #workers: Worker[] = []
  #workerReady: Promise<void> | null = null
  #readId = 0
  #reads = new Map<number, (lines: FolioLine[] | null) => void>()
  #seq = 0

  // stillness
  #history: { t: number; quad: Quad }[] = []
  #raw: Quad[] = []
  /** Detections of the still spell now (time, quad), for the shot's frame. */
  #spell: { t: number; quad: Quad; peaks: [number, number, number, number] }[] =
    []
  /** 32×24 grey view when the last page was taken. */
  #takenView: Uint8ClampedArray | null = null
  /** View cells on the paper of the page taken (scan-core paperViewMask). */
  #takenMask: Uint8Array | null = null
  #view: Uint8ClampedArray | null = null
  #viewCanvas = canvas(32, 24)
  #stillSince = 0
  /** Last frame the corner model found the paper on (time, 32×24 view). */
  #lastFound: { t: number; view: Uint8ClampedArray } | null = null
  #sweepStart = 0
  /** ORB of the page held still now (computed once per still spell). */
  #holdOrb: OrbResult | null = null
  #holdVerdict: 'new' | 'last' | 'dup' | null = null
  #frameTimes: number[] = []
  #prefer: OrtBackend
  /** Where this book prints its numbers (folioZone of confirmed reads). */
  #zones = new Map<FolioZone, number>()
  #zoneOf = new Map<string, FolioZone>()
  #zoneCounted = new Set<string>()

  constructor(onChange: () => void, prefer: OrtBackend = 'webgpu') {
    this.#onChange = onChange
    this.#prefer = prefer
    this.state = {
      tone: 'none',
      quad: null,
      sweep: 0,
      pill: '',
      banner: null,
      coverage: bookCoverage([]),
      flashAt: 0,
      fps: 0,
      inferMs: 0,
      backend: null,
      threads: 0,
      numberThreads: 0,
      ready: false,
      error: '',
    }
  }

  /** Load the models (corner model first: the screen needs it). */
  async load(): Promise<void> {
    await Promise.all([this.#detector.load(this.#prefer), loadOpenCV()])
    this.state.backend = this.#detector.backend
    this.state.threads = this.#detector.threads
    this.#startWorker()
    this.state.ready = true
    probe({
      type: 'ready',
      backend: this.state.backend,
      threads: this.state.threads,
    })
    this.#onChange()
  }

  /** Resolves once the page-number reader has its model. */
  whenNumbersReady(): Promise<void> {
    return this.#workerReady ?? Promise.resolve()
  }

  /**
   * Two readers, so the two halves of a spread are read at the same time
   * (one reader took ~0.55 s a page here: a spread's number came 1.2–1.5 s
   * after the shot, over the 1 s target).
   */
  #startWorker(): void {
    if (this.#workers.length) return
    const ready: Promise<void>[] = []
    for (let k = 0; k < NUMBER_READERS; k++) {
      const w = new Worker(new URL('./folio.worker.ts', import.meta.url), {
        type: 'module',
      })
      this.#workers.push(w)
      ready.push(
        new Promise((resolve) => {
          w.onmessage = (e: MessageEvent<FolioOut>) => {
            const m = e.data
            if (m.type === 'ready') {
              this.state.numberThreads = m.threads
              probe({
                type: 'numberReady',
                ms: Math.round(m.ms),
                threads: m.threads,
              })
              resolve()
            } else if (m.type === 'lines') {
              probe({
                type: 'numberLines',
                id: m.id,
                ms: Math.round(m.ms),
                boxes: m.boxes,
                lines: m.lines,
              })
              this.#reads.get(m.id)?.(m.lines)
              this.#reads.delete(m.id)
            } else if (m.type === 'error') {
              console.warn('[book] number reader', m.message)
              probe({
                type: 'numberError',
                id: m.id ?? null,
                message: m.message,
              })
              if (m.id === undefined) resolve()
              else {
                this.#reads.get(m.id)?.(null)
                this.#reads.delete(m.id)
              }
            }
          }
          w.onerror = (e) => {
            console.warn('[book] number reader failed to start', e.message)
            probe({ type: 'numberError', message: e.message || 'worker error' })
            resolve()
          }
        }),
      )
      w.postMessage({ type: 'init' } satisfies FolioIn)
    }
    this.#workerReady = Promise.all(ready).then(() => undefined)
  }

  async #readNumber(
    page: HTMLCanvasElement,
    zone: FolioZone | null,
    side: BookPage['side'],
  ): Promise<FolioLine[] | null> {
    if (!this.#workers.length) return null
    await this.#workerReady
    const id = ++this.#readId
    const w = this.#workers[id % this.#workers.length]!
    const bmp = await createImageBitmap(page)
    return new Promise((resolve) => {
      this.#reads.set(id, resolve)
      w.postMessage(
        {
          type: 'read',
          id,
          page: bmp,
          zone: zone ?? undefined,
          side,
        } satisfies FolioIn,
        [bmp],
      )
    })
  }

  start(video: HTMLVideoElement): void {
    this.#video = video
    this.#running = true
    const tick = () => {
      if (!this.#running) return
      void this.#frame().finally(() => {
        if (!this.#running) return
        if ('requestVideoFrameCallback' in video)
          video.requestVideoFrameCallback(() => tick())
        else requestAnimationFrame(() => tick())
      })
    }
    tick()
  }

  stop(): void {
    this.#running = false
  }

  dispose(): void {
    this.stop()
    for (const w of this.#workers) w.terminate()
    this.#workers = []
    for (const s of this.sheets) s.orb?.descriptors.delete()
  }

  // --- per frame ---------------------------------------------------------

  #greyView(video: HTMLVideoElement): Uint8ClampedArray {
    const ctx = this.#viewCanvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(video, 0, 0, 32, 24)
    const d = ctx.getImageData(0, 0, 32, 24).data
    const g = new Uint8ClampedArray(32 * 24)
    for (let i = 0; i < g.length; i++)
      g[i] = (d[i * 4]! + d[i * 4 + 1]! + d[i * 4 + 2]!) / 3
    return g
  }

  async #frame(): Promise<void> {
    const video = this.#video
    if (!video || video.readyState < 2 || !this.state.ready) return
    const now = performance.now()
    const vw = video.videoWidth
    const vh = video.videoHeight
    const det = await this.#detect(video, vw, vh)
    if (!det) return
    this.#frameTimes.push(now)
    while (this.#frameTimes.length > 0 && now - this.#frameTimes[0]! > 2000)
      this.#frameTimes.shift()
    this.state.fps =
      this.#frameTimes.length > 1
        ? ((this.#frameTimes.length - 1) * 1000) / (now - this.#frameTimes[0]!)
        : 0
    this.state.inferMs = det.inferMs

    const view = this.#greyView(video)
    let viewDiff = 255
    if (this.#view) {
      let s = 0
      for (let i = 0; i < view.length; i++)
        s += Math.abs(view[i]! - this.#view[i]!)
      viewDiff = s / view.length
    }
    this.#view = view

    const q = det.quad
    const margin = 0.004 * Math.max(vw, vh)
    const inside = [q.tl, q.tr, q.br, q.bl].every(
      (p) =>
        p.x >= -margin &&
        p.y >= -margin &&
        p.x <= vw + margin &&
        p.y <= vh + margin,
    )
    const found = this.#found(det, vw, vh)
    probe({
      type: 'frame',
      t: now,
      vd: Math.round(viewDiff * 10) / 10,
      quad: q,
      minPeak: det.minPeak,
      peaks: det.peaks.map((p) => Math.round(p * 100) / 100),
      hidden: det.hidden,
      view: det.view,
      cut: det.cut,
      ms: Math.round(det.inferMs),
      vw,
      vh,
      sig: (globalThis as { __astarProbe?: unknown }).__astarProbe
        ? Array.from(view)
        : undefined,
    })

    if (!found) {
      const lf = this.#lastFound
      if (
        this.#stillSince > 0 &&
        lf !== null &&
        now - lf.t <= BLINK_MS &&
        viewChange(view, lf.view) <= STILL_VIEW
      ) {
        // A blink: the still spell (and the green line) carries on with the
        // frame found before; the shot itself waits for a frame that finds it.
        probe({ type: 'blink', t: now, minPeak: det.minPeak })
        if (this.#sweepStart > 0)
          this.state.sweep = Math.min(1, (now - this.#sweepStart) / SWEEP_MS)
        this.#onChange()
        return
      }
      this.#lastFound = null
      this.#resetStill()
      this.state.quad = det.minPeak >= 0.1 ? q : null
      this.state.tone = this.state.quad ? 'search' : 'none'
      this.state.pill = '本全体を入れてください'
      this.state.sweep = 0
      this.#onChange()
      return
    }
    this.state.quad = q
    this.#lastFound = { t: now, view }

    // Still: corners and the picture both hold.
    const diag = Math.hypot(vw, vh)
    // Corners as the median of the last 3 detections (the model's single-
    // frame jumps — a corner on the thumb or the facing page for one frame —
    // are not movement; Android CaptureActivity does the same), compared
    // with the same median STILL_WINDOW_MS ago.
    this.#raw.push(q)
    if (this.#raw.length > 5) this.#raw.shift()
    const mq = medianQuad(this.#raw)
    this.state.quad = mq
    this.#history.push({ t: now, quad: mq })
    while (
      this.#history.length > 1 &&
      now - this.#history[0]!.t > STILL_WINDOW_MS
    )
      this.#history.shift()
    const ref = this.#history[0]!.quad
    const moved =
      Math.max(
        dist(ref.tl, mq.tl),
        dist(ref.tr, mq.tr),
        dist(ref.br, mq.br),
        dist(ref.bl, mq.bl),
      ) / diag
    // Once the green line runs, hand shake twice as large keeps it running
    // (hysteresis: book-clip spread-land-wood's 1.6 s hold was lost to it).
    const k = this.#sweepStart > 0 ? 2 : 1
    // The picture itself barely changing means the paper is still even
    // when the model's corners waver between two readings of the page
    // (single page with a strip of the facing page: framed single-land-white
    // moved 6–9 % of the diagonal at a view change of 1–3 grey levels).
    const calm = viewDiff <= STILL_VIEW_CALM
    const still =
      inside &&
      (moved <= STILL_CORNER * k || calm) &&
      viewDiff <= STILL_VIEW * k
    if (!still) {
      if (this.#stillSince > 0)
        probe({ type: 'unstill', t: now, moved, viewDiff, inside })
      this.#resetStill()
      this.state.tone = 'search'
      this.state.pill = inside ? '止めてください' : '本全体を入れてください'
      this.state.sweep = 0
      this.#onChange()
      return
    }
    if (this.#stillSince === 0) this.#stillSince = now
    this.#spell.push({ t: now, quad: q, peaks: det.peaks })
    while (now - this.#spell[0]!.t > SPELL_QUAD_MS) this.#spell.shift()

    // Once per still spell: is this the page just taken, or one taken before?
    if (
      this.#holdVerdict === null &&
      now - this.#stillSince >= STILL_MS * 0.5
    ) {
      this.#holdVerdict = this.#judgeHold(video, q)
      if (this.#holdVerdict === 'last') this.#setTaken(view, mq, vw, vh)
      probe({ type: 'hold', t: now, verdict: this.#holdVerdict })
    }
    // Waiting for the page to be turned: a turn that never broke the
    // stillness (framed spread: the frame stays put, each frame changes a
    // little) shows as the paper having drifted from the one taken; the
    // page is then judged again (ORB decides whether it is a new page, so
    // a drift on the same page costs one more look, nothing else). The
    // change is measured on the paper of the shot, not on the whole view:
    // see scan-core turn-watch.ts (an upright spread is ~40 % of the view
    // and a whole turn barely moved the whole view's mean past TURNED_VIEW).
    if (this.#holdVerdict === 'last' && this.#takenView) {
      const change = paperViewChange(view, this.#takenView, this.#takenMask)
      probe({
        type: 'turnWatch',
        t: now,
        paper: Math.round(change * 10) / 10,
        whole: Math.round(viewChange(view, this.#takenView) * 10) / 10,
      })
      if (change > TURNED_VIEW) {
        probe({
          type: 'drift',
          t: now,
          change,
          whole: viewChange(view, this.#takenView),
        })
        this.#resetStill()
        this.#stillSince = now
      }
    }
    if (this.#holdVerdict === 'last') {
      this.state.tone = 'done'
      this.state.pill = ''
      this.state.sweep = 0
      this.#onChange()
      return
    }
    if (this.#holdVerdict === 'dup') {
      this.state.tone = 'dup'
      this.state.pill = ''
      this.state.sweep = 0
      this.#onChange()
      return
    }
    if (now - this.#stillSince < STILL_MS || this.#holdVerdict === null) {
      this.state.tone = 'hold'
      this.state.pill = 'そのまま'
      this.state.sweep = 0
      this.#onChange()
      return
    }
    if (this.#sweepStart === 0) {
      this.#sweepStart = now
      probe({ type: 'sweep', t: now })
    }
    this.state.tone = 'sweep'
    this.state.pill = 'そのまま'
    this.state.sweep = Math.min(1, (now - this.#sweepStart) / SWEEP_MS)
    if (this.state.sweep >= 1) {
      // The frame of the shot: each corner from the spell's detections the
      // model was surest of for it (scan-core shotFrameQuad; see
      // SPELL_QUAD_MS).
      const sq = shotFrameQuad(this.#spell) ?? mq
      probe({
        type: 'shotQuad',
        t: now,
        last: mq,
        spell:
          this.#spell.length > 0
            ? medianQuad(this.#spell.map((x) => x.quad))
            : mq,
        shot: sq,
        n: this.#spell.length,
      })
      this.#capture(video, sq, now)
      this.#holdVerdict = 'last'
      this.#setTaken(view, sq, vw, vh)
      this.state.tone = 'done'
      this.state.sweep = 0
    }
    this.#onChange()
  }

  /** The paper is found: every corner sure, big enough, a convex frame, none on a cut edge of the view. */
  #found(det: PageDetection, vw: number, vh: number): boolean {
    return (
      det.minPeak >= MIN_PEAK &&
      quadArea(det.quad) / (vw * vh) >= MIN_AREA &&
      convex(det.quad) &&
      !det.cut
    )
  }

  /**
   * The corner model over the views of the picture (scan-core
   * detectViews): the view that showed the paper last first, then the
   * whole picture, then the others; the first that finds the paper wins.
   * When none does, the whole picture's detection is returned (its weak
   * corners draw the searching frame). The model time is the sum.
   */
  async #detect(
    video: HTMLVideoElement,
    vw: number,
    vh: number,
  ): Promise<PageDetection | null> {
    if (
      this.#views.length === 0 ||
      this.#views[0]!.w !== vw ||
      this.#views[0]!.h !== vh
    )
      this.#views = detectViews(vw, vh)
    let full: PageDetection | null = null
    let ms = 0
    for (const v of this.#viewSearch.order(this.#views)) {
      const det = await this.#detector.detect(video, v)
      if (!det) return null
      ms += det.inferMs
      if (v.name === 'full') full = det
      if (this.#found(det, vw, vh)) {
        this.#viewSearch.found(v)
        return { ...det, inferMs: ms }
      }
    }
    this.#viewSearch.found(null)
    return full ? { ...full, inferMs: ms } : null
  }

  /** The view and the paper of the page taken (or recognised as taken). */
  #setTaken(view: Uint8ClampedArray, q: Quad, vw: number, vh: number): void {
    this.#takenView = view
    this.#takenMask = paperViewMask(q, vw, vh)
  }

  #resetStill(): void {
    this.#stillSince = 0
    this.#spell = []
    this.#sweepStart = 0
    this.#holdVerdict = null
    this.#holdOrb?.descriptors.delete()
    this.#holdOrb = null
  }

  /** Small upright copy of the framed paper, for ORB. */
  #warpSmall(
    src: CanvasLike | HTMLVideoElement,
    q: Quad,
    long = 400,
  ): HTMLCanvasElement | null {
    const ops = getPipelineOps()
    if (!ops) return null
    const asp = quadAspect(q)
    const w = asp >= 1 ? long : Math.round(long * asp)
    const h = asp >= 1 ? Math.round(long / asp) : long
    let s: CanvasLike
    if (src instanceof HTMLVideoElement) {
      const c = canvas(src.videoWidth, src.videoHeight)
      c.getContext('2d')!.drawImage(src, 0, 0)
      s = c as unknown as CanvasLike
    } else s = src
    return ops.warpPerspective(
      s,
      q,
      Math.max(8, w),
      Math.max(8, h),
    ) as unknown as HTMLCanvasElement
  }

  #orbOf(c: HTMLCanvasElement | null): OrbResult | null {
    const ops = getPipelineOps()
    if (!ops || !c) return null
    try {
      return ops.computeOrbDescriptors(c as unknown as CanvasLike)
    } catch {
      return null
    }
  }

  #inliers(a: OrbResult | null, b: OrbResult | null): number {
    const ops = getPipelineOps()
    if (!ops || !a || !b) return 0
    try {
      return ops.countOrbMatches(a, b).inliers
    } catch {
      return 0
    }
  }

  #judgeHold(video: HTMLVideoElement, q: Quad): 'new' | 'last' | 'dup' {
    this.#holdOrb?.descriptors.delete()
    this.#holdOrb = this.#orbOf(this.#warpSmall(video, q))
    const last = this.sheets[this.sheets.length - 1]
    if (!last) return 'new'
    const nLast = this.#inliers(this.#holdOrb, last.orb)
    probe({ type: 'orb', with: 'last', inliers: nLast })
    if (nLast >= SAME_PAGE_INLIERS) return 'last'
    // Taken before (going back over pages already done): the last dozen.
    for (const s of this.sheets.slice(-13, -1).reverse()) {
      const n = this.#inliers(this.#holdOrb, s.orb)
      if (n >= SAME_PAGE_INLIERS) {
        probe({ type: 'orb', with: s.id, inliers: n })
        this.#say('mute', [
          `${this.#sheetLabel(s)} は撮影済みです`,
          'めくってください',
        ])
        return 'dup'
      }
    }
    return 'new'
  }

  // --- capture -------------------------------------------------------------

  #sheetLabel(s: Sheet): string {
    const nums = completeSpread(s.pages)
      .map((p) => (p.state === 'read' ? p.number : undefined))
      .filter((n): n is number => n !== undefined)
    if (nums.length === 0) return 'このページ'
    return nums.length === 2 ? `${nums[0]}・${nums[1]}` : `${nums[0]}`
  }

  #say(tone: Banner['tone'], lines: string[]): void {
    this.state.banner = { tone, lines, at: performance.now() }
  }

  #capture(video: HTMLVideoElement, q: Quad, t: number): void {
    const vw = video.videoWidth
    const vh = video.videoHeight
    const frame = canvas(vw, vh)
    frame.getContext('2d')!.drawImage(video, 0, 0)
    beepCaptured()
    vibrateCaptured()
    const spread = quadAspect(q) >= SPREAD_MIN_ASPECT
    const id = `s${++this.#seq}`
    const sheet: Sheet = {
      id,
      seq: this.#seq,
      pages: spread
        ? [{ state: 'pending' }, { state: 'pending' }]
        : [{ state: 'pending' }],
      readPages: spread
        ? [{ state: 'pending' }, { state: 'pending' }]
        : [{ state: 'pending' }],
      orb: this.#holdOrb,
      takenAt: t,
      spread,
    }
    this.#holdOrb = null // owned by the sheet now
    this.sheets.push(sheet)
    this.state.flashAt = t
    this.#say('ok', ['✓ 撮れた', spread ? 'めくってください' : '次のページへ'])
    this.state.coverage = bookCoverage(this.sheets)
    this.#onChange()
    // Split / warp after the ✓ is on screen.
    setTimeout(() => void this.#process(sheet, frame, q, t), 0)
  }

  #warpPage(frame: HTMLCanvasElement, q: Quad): HTMLCanvasElement {
    const ops = getPipelineOps()!
    const asp = quadAspect(q)
    // Keep the camera's own resolution (no upscaling past PAGE_LONG).
    const srcLong = Math.max(
      dist(q.tl, q.bl),
      dist(q.tr, q.br),
      dist(q.tl, q.tr),
      dist(q.bl, q.br),
    )
    const long = Math.min(PAGE_LONG, Math.max(400, Math.round(srcLong)))
    const w = asp >= 1 ? long : Math.round(long * asp)
    const h = asp >= 1 ? Math.round(long / asp) : long
    return ops.warpPerspective(
      frame as unknown as CanvasLike,
      q,
      w,
      h,
    ) as unknown as HTMLCanvasElement
  }

  #lum(
    c: HTMLCanvasElement,
    long = 600,
  ): { lum: Uint8ClampedArray; w: number; h: number } {
    const s = long / Math.max(c.width, c.height)
    const w = Math.max(8, Math.round(c.width * s))
    const h = Math.max(8, Math.round(c.height * s))
    const t = canvas(w, h)
    const ctx = t.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(c, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    const lum = new Uint8ClampedArray(w * h)
    for (let i = 0; i < w * h; i++)
      lum[i] =
        (d[i * 4]! * 299 + d[i * 4 + 1]! * 587 + d[i * 4 + 2]! * 114) / 1000
    return { lum, w, h }
  }

  async #process(
    sheet: Sheet,
    frame: HTMLCanvasElement,
    q: Quad,
    t: number,
  ): Promise<void> {
    const made: BookPage[] = []
    let gutter: GutterLine | null = null
    if (sheet.spread) {
      const whole = this.#warpSmall(frame as unknown as CanvasLike, q, 800)
      if (whole) {
        const { lum, w, h } = this.#lum(whole, 800)
        gutter = findSpreadGutter(lum, w, h)
      }
      const g = gutter ?? { top: 0.5, bottom: 0.5, depth: 0 }
      const { left, right } = splitSpreadQuad(q, g)
      made.push(
        this.#page(sheet, 'L', frame, left, sheet.pages[0]!),
        this.#page(sheet, 'R', frame, right, sheet.pages[1]!),
      )
    } else {
      let page = this.#warpPage(frame, q)
      let pq = q
      const { lum, w, h } = this.#lum(page)
      const cut = findEdgeGutter(lum, w, h)
      if (cut.left > 0 || cut.right > 0) {
        pq = trimQuadSides(q, cut.left, cut.right)
        page = this.#warpPage(frame, pq)
      }
      probe({
        type: 'edgeGutter',
        sheetId: sheet.id,
        left: cut.left,
        right: cut.right,
      })
      made.push(this.#page(sheet, 'S', frame, pq, sheet.pages[0]!, page))
    }
    this.pages.push(...made)
    probe({
      type: 'capture',
      t,
      sheetId: sheet.id,
      spread: sheet.spread,
      quad: q,
      gutter,
      pages: made.map((p) => ({
        id: p.id,
        side: p.side,
        quad: p.quad,
        w: p.canvas.width,
        h: p.canvas.height,
      })),
    })
    this.#onChange()

    // Numbers, both halves of a spread at once.
    const zone = learnedFolioZone(this.#zones)
    const reads = await Promise.all(
      made.map((p) => this.#readNumber(p.canvas, zone, p.side)),
    )
    const before = this.state.coverage.gaps
    const chosen: (FolioZone | null)[] = []
    /** Confidence of the line each page's number was read from. */
    const confs: number[] = []
    /** Lines of a plausible size in the book's number place, per page. */
    const placed: FolioLine[][] = []
    reads.forEach((lines, i) => {
      const p = made[i]!
      const side = p.side
      // Too small to read reliably (Android: ~5 px numbers come back wrong
      // as often as right), or outside the place this book prints numbers.
      const sized = (lines ?? []).filter(
        (l) =>
          (l.box[3] - l.box[1]) * p.straight.height >= MIN_NUMBER_PX &&
          (zone === null || folioZone(l.cx, l.cy, side) === zone),
      )
      placed.push(sized)
      const ok = sized.filter((l) => l.conf >= MIN_NUMBER_CONF)
      // A number far from every number read so far is body text (a year,
      // "1668."), once the book's numbers are known.
      const known = this.pages
        .filter((o) => o.read.state === 'read' && !o.read.inferred)
        .map((o) => o.read.number!)
      const plausible = ok.filter((l) => {
        const v = parsePageNumberToken(l.text)?.value
        return (
          v === undefined ||
          known.length < 2 ||
          known.some((k) => Math.abs(k - v) <= FAR_NUMBER)
        )
      })
      const nums = pickPageNumbers(plausible, 0.12)
      // A single page carries one number; a spread's half its own.
      const n =
        nums.length > 0
          ? side === 'R' && nums.length === 2
            ? nums[1]!
            : nums[0]!
          : undefined
      const line =
        n !== undefined
          ? plausible.find((l) => parsePageNumberToken(l.text)?.value === n)
          : undefined
      chosen.push(line ? folioZone(line.cx, line.cy, side) : null)
      confs.push(line?.conf ?? 0)
      const r: BookPageRead =
        n !== undefined && line
          ? {
              state: 'read',
              number: n,
              px:
                Math.round(
                  (line.box[3] - line.box[1]) * p.straight.height * 10,
                ) / 10,
            }
          : { state: 'none' }
      sheet.pages[i] = r
      p.read = r
    })
    // Spread halves must be consecutive; one read wrong drops both to the
    // more confident inference (left = right − 1).
    if (sheet.spread) {
      // A half read with less confidence than a number needs on its own
      // still counts when it reads as exactly the other half's number ± 1
      // (scan-core facingHalfNumber): book 2's 52 at 0.68 beside a sure 53.
      for (const [i, j] of [
        [0, 1],
        [1, 0],
      ] as const) {
        const a = sheet.pages[i]!
        const b = sheet.pages[j]!
        if (a.state !== 'read' || b.state !== 'none') continue
        const low = placed[j]!.filter((l) => l.conf >= LOW_NUMBER_CONF)
        const n = facingHalfNumber(low, a.number!, j === 0 ? 'L' : 'R')
        if (n === undefined) continue
        const line = low.find((l) => parsePageNumberToken(l.text)?.value === n)!
        const r: BookPageRead = {
          state: 'read',
          number: n,
          px:
            Math.round(
              (line.box[3] - line.box[1]) * made[j]!.straight.height * 10,
            ) / 10,
        }
        sheet.pages[j] = r
        made[j]!.read = r
        chosen[j] = folioZone(line.cx, line.cy, made[j]!.side)
        confs[j] = line.conf
        probe({
          type: 'numberFacing',
          sheetId: sheet.id,
          side: made[j]!.side,
          number: n,
          conf: line.conf,
        })
      }
      // Halves that do not follow each other: one is a misread. The one
      // read with less confidence is dropped (book 3 upright spread: the
      // left "( 314 )" read as "(4)" at 0.77 beside "315)" at 0.73 kept the
      // 4 and inferred 5); the kept half is still only a proposal until
      // another capture confirms it (settleBookNumbers).
      const [l, r] = sheet.pages as [BookPageRead, BookPageRead]
      if (
        l.state === 'read' &&
        r.state === 'read' &&
        r.number !== l.number! + 1
      ) {
        const drop = (confs[0] ?? 0) >= (confs[1] ?? 0) ? 1 : 0
        sheet.pages[drop] = { state: 'none' }
        made[drop]!.read = sheet.pages[drop]!
      }
      const full = completeSpread(sheet.pages)
      sheet.pages.splice(0, 2, ...full)
      made.forEach((p, i) => (p.read = sheet.pages[i]!))
    }
    sheet.readPages = [...sheet.pages]

    // The same page taken again (the picture differed enough to pass ORB
    // at the hold): drop it and say so. Judged on the numbers as read: a
    // capture whose number is held back still holds its page.
    const readNums = sheet.readPages
      .filter((p) => p.state === 'read')
      .map((p) => p.number!)
    const twin = sheetWithNumbers(
      this.sheets.map((s) => ({ id: s.id, seq: s.seq, pages: s.readPages })),
      readNums,
      sheet.id,
    )
    if (twin) {
      const twinSheet = this.sheets.find((s) => s.id === twin.id)
      if (
        this.#inliers(sheet.orb, twinSheet?.orb ?? null) >= SAME_PAGE_INLIERS
      ) {
        this.#removeSheet(sheet.id)
        this.state.coverage = bookCoverage(this.sheets)
        this.#say('mute', [
          `${pageRangeLabel(Math.min(...readNums), Math.max(...readNums))} は撮影済みです`,
          'めくってください',
        ])
        probe({ type: 'dupByNumber', sheetId: sheet.id, numbers: readNums })
        this.#onChange()
        return
      }
      // Same number, different picture: one of the two is a misread (book
      // clip spread-land-wood framed: 14・15 read as 4・5). Both keep their
      // pages; settleBookNumbers lets only the one in sequence with its
      // neighbours count.
      probe({
        type: 'numberConflict',
        sheetId: sheet.id,
        numbers: readNums,
        twin: twin.id,
      })
    }

    // Numbers that do not fit the order the book was taken in (below every
    // page taken before: book 2's 98・99 read as 88・89), or a spread's that
    // nothing makes sure of (one half read at 4–5 px and the other inferred:
    // book 3's 318・319 as 328・329), are not taken as read — they would
    // show "✓ 328・329" and mark those pages taken. Every capture is judged
    // again: the captures after a page judge it too (the first page 31
    // read as 40 is out of order only once 33, 35 follow it; a held spread
    // is shown once the next spread confirms it). scan-core
    // settleBookNumbers.
    this.#settleNumbers(sheet)
    const numbers = sheet.pages
      .filter((p) => p.state === 'read')
      .map((p) => p.number!)
    probe({
      type: 'number',
      t: performance.now(),
      sheetId: sheet.id,
      numbers,
      sinceShot: Math.round(performance.now() - t),
    })

    // A number another capture's number follows / precedes is right; its
    // place on the page teaches where this book prints its numbers.
    made.forEach((p, i) => {
      const z = chosen[i]
      if (z) this.#zoneOf.set(p.id, z)
    })
    for (const p of made) {
      const r = p.read
      if (r.state !== 'read' || r.inferred) continue
      const n = r.number!
      for (const o of this.pages) {
        if (
          o.sheetId === sheet.id ||
          o.read.state !== 'read' ||
          o.read.inferred
        )
          continue
        if (Math.abs(o.read.number! - n) > 2) continue
        for (const q of [p, o]) {
          const z = this.#zoneOf.get(q.id)
          if (z && !this.#zoneCounted.has(q.id)) {
            this.#zoneCounted.add(q.id)
            this.#zones.set(z, (this.#zones.get(z) ?? 0) + 1)
          }
        }
      }
    }
    this.state.coverage = bookCoverage(this.sheets)
    const after = this.state.coverage.gaps
    const fresh = newGaps(before, after)
    const filled = filledGaps(before, after)
    const label = numbers.length
      ? pageRangeLabel(Math.min(...numbers), Math.max(...numbers))
      : ''
    const latest = this.sheets[this.sheets.length - 1]?.id === sheet.id
    if (fresh.length > 0) {
      const g = fresh[fresh.length - 1]!
      this.#alertGap(g)
    } else if (filled.length > 0 && numbers.length > 0) {
      this.#say('ok', [`✓ ${label} ページを埋めました`, ...this.#nextHint()])
    } else if (latest) {
      if (numbers.length > 0)
        this.#say('ok', [
          `✓ ${label} ページ 撮れた`,
          sheet.spread ? 'めくってください' : '次のページへ',
        ])
      else
        this.#say('mute', [
          '✓ 撮れた（番号なし）',
          sheet.spread ? 'めくってください' : '次のページへ',
        ])
    }
    probe({ type: 'coverage', gaps: after, fresh, filled })
    this.#onChange()

    // Curvature correction last: the number and the ✓ come first.
    for (const p of made) {
      const r = this.#flatten(
        frame,
        p.quad,
        p.straight.width,
        p.straight.height,
      )
      if (r.canvas) {
        p.canvas = r.canvas
        p.flattened = true
      }
      p.flattenWhy = r.why
      probe({
        type: 'flatten',
        pageId: p.id,
        ok: !!r.canvas,
        why: r.why,
        bow: r.bow,
      })
    }
    this.#onChange()
  }

  #page(
    sheet: Sheet,
    side: BookPage['side'],
    frame: HTMLCanvasElement,
    q: Quad,
    read: BookPageRead,
    warped?: HTMLCanvasElement,
  ): BookPage {
    const c = warped ?? this.#warpPage(frame, q)
    return {
      id: `${sheet.id}${side}`,
      sheetId: sheet.id,
      side,
      canvas: c,
      straight: c,
      flattened: false,
      flattenWhy: '',
      quad: q,
      read,
    }
  }

  /**
   * PageFlatten.kt on the web: the page cut with a margin round its four
   * corners, its top / bottom paper edges fitted (scan-core page-flatten),
   * every column stretched between the two curves.
   */
  #flatten(
    frame: HTMLCanvasElement,
    q: Quad,
    ow: number,
    oh: number,
  ): { canvas: HTMLCanvasElement | null; why: string; bow: number[] } {
    const ops = getPipelineOps()
    if (!ops) return { canvas: null, why: 'OpenCV not loaded', bow: [] }
    const whys: string[] = []
    const H = unitToQuad(q)
    for (const [margin, robust] of [
      [PAGE_FLATTEN.margin, false],
      [PAGE_FLATTEN.marginWide, true],
    ] as const) {
      const g = flattenGeometry(ow, oh, margin)
      const fx = g.mx / ow
      const fy = g.my / oh
      const ext: Quad = {
        tl: applyHomography(H, { x: -fx, y: -fy }),
        tr: applyHomography(H, { x: 1 + fx, y: -fy }),
        br: applyHomography(H, { x: 1 + fx, y: 1 + fy }),
        bl: applyHomography(H, { x: -fx, y: 1 + fy }),
      }
      const big = ops.warpPerspective(
        frame as unknown as CanvasLike,
        ext,
        g.ew,
        g.eh,
      ) as unknown as HTMLCanvasElement
      const d = big
        .getContext('2d', { willReadFrequently: true })!
        .getImageData(0, 0, g.ew, g.eh).data
      const lum = new Uint8ClampedArray(g.ew * g.eh)
      for (let i = 0; i < lum.length; i++)
        lum[i] =
          (d[i * 4]! * 299 + d[i * 4 + 1]! * 587 + d[i * 4 + 2]! * 114) / 1000
      const r = fitPageEdges(lum, g, robust)
      if (!r.edges) {
        whys.push(r.why)
        continue
      }
      const out = canvas(ow, oh)
      const ctx = out.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      for (let x = 0; x < ow; x++) {
        const u = (x + 0.5) / ow
        const y0 = curveAt(r.edges.top, u)
        const y1 = curveAt(r.edges.bottom, u)
        ctx.drawImage(big, g.mx + x, y0, 1, Math.max(1, y1 - y0), x, 0, 1, oh)
      }
      return {
        canvas: out,
        why: robust ? `wide margin (first try: ${whys[0]})` : '',
        bow: [r.edges.topBow, r.edges.bottomBow],
      }
    }
    return { canvas: null, why: whys.join('; wide margin: '), bow: [] }
  }

  #nextHint(): string[] {
    const g = this.state.coverage.gaps[0]
    return g
      ? [`${pageRangeLabel(g.from, g.to, g.step)} ページが抜けています`]
      : []
  }

  #alertGap(g: BookGap): void {
    this.#say('bad', [
      `⚠ ${pageRangeLabel(g.from, g.to, g.step)} ページが抜けています`,
      '戻ってください',
    ])
    try {
      navigator.vibrate?.([140, 90, 140])
    } catch {
      /* unsupported */
    }
    probe({
      type: 'alert',
      t: performance.now(),
      from: g.from,
      to: g.to,
      step: g.step,
    })
  }

  /**
   * Show each capture's numbers as read, or keep the capture without them
   * (読めず) while they do not fit the order or nothing makes a spread's
   * sure (scan-core settleBookNumbers). `current` is the capture just read.
   */
  #settleNumbers(current: Sheet): void {
    const verdicts = settleBookNumbers(
      this.sheets.map((s) => ({ id: s.id, seq: s.seq, pages: s.readPages })),
    )
    const now = performance.now()
    for (const s of this.sheets) {
      if (s.readPages.some((p) => p.state === 'pending')) continue
      const verdict = verdicts.get(s.id) ?? 'ok'
      const rawNums = s.readPages.map((p) => p.number ?? null)
      const had = rawNums.some((n) => n !== null)
      const shownBefore = s.pages.some((p) => p.state === 'read')
      const next: BookPageRead[] =
        verdict === 'ok'
          ? [...s.readPages]
          : s.readPages.map(() => ({ state: 'none' }))
      s.pages.splice(0, s.pages.length, ...next)
      for (const p of this.pages)
        if (p.sheetId === s.id)
          p.read = s.pages[p.side === 'R' && s.pages.length > 1 ? 1 : 0]!
      const shownNow = verdict === 'ok' && had
      const why = verdict === 'order' ? 'numberOutOfOrder' : 'numberUnsure'
      if (s === current) {
        if (!shownNow && had)
          probe({
            type: why,
            sheetId: s.id,
            numbers: rawNums,
            px: this.#pxOf(s),
          })
      } else if (shownBefore && !shownNow) {
        probe({ type: why, sheetId: s.id, numbers: rawNums, px: this.#pxOf(s) })
      } else if (!shownBefore && shownNow) {
        // Held back until now (a later capture confirmed it).
        probe({
          type: 'number',
          t: now,
          sheetId: s.id,
          numbers: rawNums.filter((n): n is number => n !== null),
          sinceShot: Math.round(now - s.takenAt),
          late: true,
        })
      }
    }
  }

  #pxOf(s: Sheet): (number | null)[] {
    return s.readPages.map((p) => p.px ?? null)
  }

  #removeSheet(id: string): void {
    const i = this.sheets.findIndex((s) => s.id === id)
    if (i >= 0) {
      this.sheets[i]!.orb?.descriptors.delete()
      this.sheets.splice(i, 1)
    }
    for (let k = this.pages.length - 1; k >= 0; k--)
      if (this.pages[k]!.sheetId === id) this.pages.splice(k, 1)
  }

  /** Pages in page order (the list, the PDF, the Markdown). */
  orderedPages(): BookPage[] {
    const order = new Map<string, number>()
    this.state.coverage.items.forEach((it, i) => {
      if (it.kind === 'sheet') order.set(it.sheetId, i)
    })
    const sideRank = { L: 0, S: 0, R: 1 } as const
    return [...this.pages].sort(
      (a, b) =>
        (order.get(a.sheetId) ?? 1e9) - (order.get(b.sheetId) ?? 1e9) ||
        sideRank[a.side] - sideRank[b.side],
    )
  }

  /** Remove one page (the list's 削除). */
  removePage(id: string): void {
    const p = this.pages.find((x) => x.id === id)
    if (!p) return
    const s = this.sheets.find((x) => x.id === p.sheetId)
    const same = this.pages.filter((x) => x.sheetId === p.sheetId)
    if (same.length <= 1) this.#removeSheet(p.sheetId)
    else if (s) {
      const idx = p.side === 'R' ? 1 : 0
      s.pages.splice(idx, 1)
      s.readPages.splice(idx, 1)
      s.spread = false
      this.pages.splice(this.pages.indexOf(p), 1)
    }
    this.state.coverage = bookCoverage(this.sheets)
    this.#onChange()
  }
}
