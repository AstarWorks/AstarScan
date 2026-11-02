<script setup lang="ts">
/**
 * AstarScan — two-stage document scanner.
 *
 * Stage 1 (during scan):
 *   - Sample every SAMPLE_INTERVAL_S of video/camera
 *   - `detectDocument` returns `{quad, confidence}` using YOLOv8n-pose
 *     (primary) or OpenCV Otsu+minAreaRect (fallback on load failure).
 *   - Warp, compute pHash + tile-pHash + sharpness + score
 *   - Accepted frames go to `acceptedRecords`; sharp-but-low-texture
 *     frames that fail the blur gate go to `candidateRecords` (the gap-
 *     rescue pool — the blur gate is content-biased and silently drops
 *     illustration-heavy pages otherwise).
 *
 * Stage 2 (on video end / stop): `clusterBySegments` from scan-core —
 * the SAME segment-first algorithm the eval harness froze at identity
 * recall 1.0 on both GT videos:
 *   L1  temporal runs (acceptance gap > 1 s = page turn; hash spikes at
 *       gap < 0.5 s are NEVER cuts — crop jitter, not page swaps)
 *   →   gap rescue (> 2.5 s gaps hide blur-gated sparse pages)
 *   →   L2 merge cascade: tile ≤ 18 → ORB+grid → OCR 3-gram Jaccard
 *       (NDLOCR-Lite here; YomiToku in the eval harness — judgment is
 *       shared in scan-core text-similarity)
 * One frame per cluster wins by composite score → `captured[]` pages.
 */

import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import jsPDF from 'jspdf'
import type { Quad } from '@astarworks/scan-core'
import {
  RESCUE_MIN_AREA_FRAC,
  RESCUE_MIN_CONFIDENCE,
  RESCUE_MIN_TENENGRAD,
  LiveCaptureJudge,
  buildCaptureReport,
  clusterBySegments,
  combinedScore,
  mergeClusters,
  quadArea,
  removeCluster,
  scaleQuad,
  setClusterWinner,
  splitCluster,
  updateClusterCrop,
  verifySameText,
  type CanvasLike,
  type CaptureRow,
  type LiveCaptureEvent,
  type LiveFrame,
  type LivePageSpan,
  type OrbResult,
  type SegmentCluster,
  type SegmentHooks,
} from '@astarworks/scan-core/pipeline'

import {
  detectDocument,
  ensureDocDetector,
  getDetectorSource,
  notifyNewHold,
  notifyPageCaptured,
  resetPageTracking,
} from '~/services/doc-detector'
import { rotateAndCropQuad } from '~/services/rotate-crop'
import { downscaleToLongSide } from '~/services/canvas-helpers'
import { classifyQuad } from '~/services/quad-classify'
import { computePHash, computeTilePHash } from '~/services/phash-dedup'
import { type DetectedFrame } from '~/services/frame-collector'
import { getPipelineOps } from '~/services/pipeline-ops'
import { initOcr, runOcr } from '~/services/ocr-service'
import {
  validateFrame,
  type ValidationResult,
} from '~/services/llm-frame-validator'
import { pickBestFrameByLlm, type PickResult } from '~/services/llm-best-frame'
import { arePairSameCard } from '~/services/llm-card-pair'
import {
  beepCaptured,
  blobToImageCanvas,
  createStillCapturer,
  vibrateCaptured,
  type StillCapturer,
} from '~/services/capture-feedback'
import type { ReportViewRow } from '~/components/CaptureReport.vue'
import {
  clearSession,
  loadSession,
  saveSession,
  type StoredPage,
} from '~/services/session-store'

interface PairDebug {
  readonly otherPageId: string
  readonly same: boolean
  readonly confidence: number
  readonly reasoning: string
  readonly raw: string
}

interface LlmDebug {
  validator?: ValidationResult
  bestFramePick?: PickResult
  pairResults?: PairDebug[]
}

interface Page {
  id: string
  dataUrl: string
  width: number
  height: number
  capturedAt: number
  /** In-memory debug data from the LLM pipeline. Not persisted to
   *  session-store — survives until page reload only. */
  llmDebug?: LlmDebug
  /** Winner frame index of the cluster this page came from — the handle
   *  the repair controls address it by. Absent on pages restored from a
   *  previous session (their clusters are long gone), which is exactly
   *  the set that cannot be merged, split, or re-picked. */
  clusterKey?: number
  /** Candidate frames behind this page. 1 means nothing to split or
   *  re-pick from. */
  memberCount?: number
  /** Live page number (✓ order during the scan) behind this page. */
  livePageNo?: number
  /** Start of the miss this page was retaken for. */
  retakeOf?: number
}

const LONG_SIDE_DEFAULT = 1200 // mode 別: card 1010 / a4 1696 / receipt 1500
/** Dense sampling — a handheld page turn only gives 2-4 genuinely sharp
 *  frames per page (the moments when the hand pauses). Sampling at 0.5 s
 *  routinely missed them; 0.1 s (10 FPS) puts ~5× more candidates per
 *  page into the collector, so there's almost always a sharp one per
 *  cluster. OpenCV detection is ~5 ms so we stay well within budget. */
const SAMPLE_INTERVAL_S = 0.1
/** Minimum detector confidence to accept a frame. Matches the frozen
 *  eval config (`--min-conf 0.25`, regress.mjs PROD_PARAMS) so browser
 *  results track the eval baselines. OpenCV fallback returns 1.0. */
const MIN_CONFIDENCE = 0.25
/** Pre-cluster blur floor. Empirically the handheld MP4s peak around
 *  ten=60-80 on the sharpest frames (the whole video is moderately
 *  blurry); a gate at 30 keeps the worst transitions out without
 *  nuking entire page clusters. Frames failing this gate but clearing
 *  the rescue floors land in `candidateRecords` instead of vanishing. */
const MIN_TENENGRAD = 30
/** Memory caps. Accepted frames: same valve FrameCollector used.
 *  Candidates: full-res JPEGs are kept because a rescued candidate
 *  becomes a real output page; lowest-score eviction keeps the pool
 *  bounded (~200 × ~250 KB worst case). */
const ACCEPTED_MAX = 400
const CANDIDATE_POOL_MAX = 200
/** Retained source frames (for manual corner correction). Sized down
 *  before encoding for two reasons: a full-resolution JPEG encode at 10
 *  FPS eats the per-frame budget, and every accepted AND candidate frame
 *  carries one, so the constant sets the memory ceiling.
 *
 *  1280 covers the re-warp output sizes classifyQuad asks for (card 1010,
 *  a4 1696 — a4 corrections come out slightly softer than the original
 *  capture, which is the accepted cost of being able to fix them at all).
 *  Measured warped crops average ~85 KB, so the pair of buffers already
 *  holds ~50 MB; these roughly double that. `?debug=1` reports the live
 *  totals — shrink these two if a real device says to. */
const SRC_LONG_SIDE = 1280
const SRC_JPEG_Q = 0.6

type Phase = 'idle' | 'loading' | 'scanning' | 'done' | 'error'
const phase = ref<Phase>('idle')
const statusText = ref('')
const errorText = ref('')
const captured = ref<Page[]>([])
const pdfExporting = ref(false)
const stripOpen = ref(false)
const selectedPage = ref<Page | null>(null)

// ---- LLM observability state ----
/** WebGPU adapter probe result. False = LLM disabled regardless of toggle. */
const llmAvailable = ref(false)
/** User toggle. Defaults ON when WebGPU is available; only honored for the
 *  startFromFile path. The live-camera loop skips LLM unconditionally
 *  because per-frame Gemma 4 inference is 5-10 s on WebGPU. */
const useLlm = ref(true)
/** Progress bar for the LLM phases of finalizeScan. */
interface LlmProgressInfo {
  done: number
  total: number
  phase: string
}
const llmProgress = ref<LlmProgressInfo | null>(null)
/** Side map: each `DetectedFrame` that survived the validator carries
 *  its result here, looked up at finalize time to attach to the resulting
 *  Page.llmDebug. WeakMap so clearing the record arrays drops entries. */
const validatorByFrame = new WeakMap<DetectedFrame, ValidationResult>()

function openPageDetail(p: Page) {
  console.log('[index] openPageDetail', p.id)
  selectedPage.value = p
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function closePageDetail() {
  selectedPage.value = null
}

// ---------------------------------------------------------------------------
// Repair state
//
// The clustering output is kept alive after finalizeScan so the review
// screen can act on it. Residual pipeline error on the frozen eval config
// is duplicates and junk (docs/eval-results.md) — fixable in one tap, but
// only if the clusters still exist. Holding them also holds every accepted
// frame's warped JPEG in memory until the next scan or clearAll.
//
// Repairs rebuild the page list from clusters, so pages land back in scan
// order (winner index ascending). Manual reordering is best done after the
// repairs, not before.
// ---------------------------------------------------------------------------

/** Clustering output of the current scan, mutated only via cluster-repair. */
const repairClusters = ref<SegmentCluster<ScanRecord>[]>([])
/** Pages that predate the current scan (restored session). Not repairable. */
const preScanPages = ref<Page[]>([])
/** Cluster keys ticked for merging. */
const mergeSelection = ref<number[]>([])
/** Cluster whose candidate frames are open in the filmstrip. */
const detailKey = ref<number | null>(null)
const membersLoading = ref(false)
/** True once the accepted-frame ring buffer evicted anything: the early
 *  pages of a long scan then have no candidates left to split or re-pick. */
const bufferTruncated = ref(false)

interface MemberView {
  idx: number
  t_s: number
  dataUrl: string
  isWinner: boolean
}
const detailMembers = ref<MemberView[]>([])

/** LLM best-frame picks, keyed by frame so a repair rebuild keeps them. */
const bestFrameByFrame = new WeakMap<DetectedFrame, PickResult>()

/** Bumped per scan. Frame indices restart at 0 every scan, so the winner
 *  index alone is not unique across two scans in one session — page ids
 *  would collide in the strip and `removePage` would hit the wrong page. */
const scanId = ref(0)

/**
 * Strip the repair handles from a page. Once a new scan installs its own
 * cluster array, pages from the previous scan can no longer be addressed:
 * their keys would resolve against the wrong scan's clusters.
 */
function detachRepair(p: Page): Page {
  const next: Page = {
    id: p.id,
    dataUrl: p.dataUrl,
    width: p.width,
    height: p.height,
    capturedAt: p.capturedAt,
  }
  if (p.llmDebug) next.llmDebug = p.llmDebug
  return next
}

// ---------------------------------------------------------------------------
// Live capture feedback (✓ / missed during the scan)
//
// scan-core `LiveCaptureJudge` sees every sampled frame — no blur gate —
// and decides the ✓ moment and the misses. At each ✓ a full-resolution
// still is taken (ImageCapture) and becomes that page's image; where the
// platform cannot, the hold's best video frame is kept, and the page
// records which one it got. After the scan, `buildCaptureReport`
// reconciles the live result with the post-scan clusters so pages the
// user never saw ✓ for are listed apart ("後から拾った").
// ---------------------------------------------------------------------------

interface LiveFrameData {
  idx: number
  warped: HTMLCanvasElement | null
}

interface LiveShot {
  blob: Blob
  dataUrl: string
  width: number
  height: number
  source: 'photo' | 'video'
}

/**
 * Eval hook: when a test harness defines `window.__astarProbe`, the scan
 * reports each sampled frame's quad, every ✓ / miss and the saved pages'
 * origins to it (scripts/eval/book-clips/book-e2e.mjs). No-op otherwise.
 */
function probe(ev: Record<string, unknown>): void {
  const fn = (globalThis as { __astarProbe?: (e: unknown) => void })
    .__astarProbe
  if (!fn) return
  try {
    fn({ ...ev, wall: performance.now() })
  } catch {
    /* harness errors never reach the scan */
  }
}

/** 32×18 grey thumbnail of a frame, so the eval harness can tell which
 *  clip frame the fake camera delivered. Only computed for the probe. */
function frameSignature(src: HTMLCanvasElement): number[] {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 18
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return []
  ctx.drawImage(src, 0, 0, 32, 18)
  const d = ctx.getImageData(0, 0, 32, 18).data
  const out: number[] = []
  for (let i = 0; i < d.length; i += 4)
    out.push(Math.round(0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!))
  return out
}

type LiveSignal = 'none' | 'hold' | 'captured' | 'missed'

interface StripChip {
  id: string
  kind: 'captured' | 'missed'
  thumb: string
}

const liveSignal = ref<LiveSignal>('none')
const liveProgress = ref(0)
/** Bottom band during the scan: every ✓ and every miss, in order. */
const liveStrip = ref<StripChip[]>([])
/** End-of-scan table rows (view model of the last report). */
const reportView = ref<ReportViewRow[]>([])
/** Miss start time of the row being retaken; null when not retaking. */
const retakeTarget = ref<number | null>(null)

let judge: LiveCaptureJudge<LiveFrameData> | null = null
let stillCapturer: StillCapturer | null = null
let signalTimer: ReturnType<typeof setTimeout> | null = null
let lastJudgeT = 0
/** Judge time (s) of every sampled frame, by sample index. The clusters
 *  speak in sample indices; the live spans in judge time. */
let frameTimes: number[] = []
let pendingShots: Promise<unknown>[] = []

/** What the current scan showed live — kept for report rebuilds. */
interface ScanLive {
  spans: LivePageSpan[]
  misses: { startT: number; endT: number; thumb: string }[]
  shots: Map<number, LiveShot>
}
let scanLive: ScanLive = { spans: [], misses: [], shots: new Map() }
/** Retaken pages, keyed by the start time of the miss they replace. */
const retakes = new Map<number, LiveShot>()
/** Live pages the user removed from the output. */
const removedLive = new Set<number>()

function setSignal(kind: LiveSignal, stickyMs = 0): void {
  // A ✓ or a miss stays visible for a moment even if the next page's hold
  // starts right away.
  if (kind === 'hold' && signalTimer) return
  if (signalTimer) {
    clearTimeout(signalTimer)
    signalTimer = null
  }
  liveSignal.value = kind
  if (stickyMs > 0) {
    signalTimer = setTimeout(() => {
      signalTimer = null
      liveSignal.value = 'none'
      renderOverlay()
    }, stickyMs)
  }
  renderOverlay()
}

function thumbOf(canvas: HTMLCanvasElement): string {
  return downscaleToLongSide(canvas, 120).toDataURL('image/jpeg', 0.6)
}

/**
 * Same page or not, by ORB inliers between the two warped pages (scan-core
 * `orb.ts`). The live judge's pHash cannot tell typeset book pages apart;
 * ORB can (book-clip frames warped to 400 px: same page ≥ 15 inliers in
 * 95 %, different pages ≤ 8). Null (pHash decides) when OpenCV is not
 * loaded or a page has no features.
 */
const ORB_SAME_PAGE_MIN_INLIERS = 12
const ORB_LONG_SIDE = 400
const ORB_CACHE_MAX = 16
const orbCache = new Map<HTMLCanvasElement, OrbResult | null>()

function orbOf(canvas: HTMLCanvasElement): OrbResult | null {
  if (orbCache.has(canvas)) return orbCache.get(canvas) ?? null
  const ops = getPipelineOps()
  if (!ops) return null
  const r = ops.computeOrbDescriptors(
    downscaleToLongSide(canvas, ORB_LONG_SIDE) as unknown as CanvasLike,
  )
  orbCache.set(canvas, r)
  while (orbCache.size > ORB_CACHE_MAX) {
    const [k, v] = orbCache.entries().next().value!
    v?.descriptors.delete()
    orbCache.delete(k)
  }
  return r
}

function clearOrbCache(): void {
  for (const v of orbCache.values()) v?.descriptors.delete()
  orbCache.clear()
}

function orbSamePage(
  a: LiveFrame<LiveFrameData>,
  b: LiveFrame<LiveFrameData>,
): boolean | null {
  const ops = getPipelineOps()
  const wa = a.data.warped
  const wb = b.data.warped
  if (!ops || !wa || !wb) return null
  if (wa === wb) return true
  try {
    const ra = orbOf(wa)
    const rb = orbOf(wb)
    if (!ra || !rb) return null
    const { inliers } = ops.countOrbMatches(ra, rb)
    probe({ type: 'orb', a: a.data.idx, b: b.data.idx, inliers })
    return inliers >= ORB_SAME_PAGE_MIN_INLIERS
  } catch (err) {
    console.warn('[live] ORB compare failed, using pHash', err)
    return null
  }
}

function startLive(track: MediaStreamTrack | undefined): void {
  clearOrbCache()
  resetPageTracking()
  lastHoldId = 0
  judge = new LiveCaptureJudge<LiveFrameData>({}, orbSamePage)
  stillCapturer = createStillCapturer(track)
  lastJudgeT = 0
  pendingShots = []
  liveStrip.value = []
  liveProgress.value = 0
  if (signalTimer) clearTimeout(signalTimer)
  signalTimer = null
  liveSignal.value = 'none'
}

function feedLive(frame: LiveFrame<LiveFrameData>): void {
  if (!judge) return
  lastJudgeT = frame.t
  const events = judge.push(frame)
  if (debugMode.value) {
    console.debug(
      `[live] t=${frame.t.toFixed(2)} conf=${frame.confidence.toFixed(2)} area=${frame.areaFrac.toFixed(2)}`,
      events
        .filter((e) => e.type !== 'hold')
        .map((e) => e.type)
        .join(',') ||
        events
          .map((e) =>
            e.type === 'hold' ? `hold ${e.progress.toFixed(2)}` : '',
          )
          .join(''),
    )
  }
  for (const e of events) onLiveEvent(e)
}

/** Close the live judge (may report a final miss) and wait for stills. */
async function endLive(): Promise<void> {
  if (judge) for (const e of judge.finish(lastJudgeT)) onLiveEvent(e)
  await Promise.allSettled(pendingShots)
  pendingShots = []
}

/** Latest hold the judge reported (a new id = the picture changed). */
let lastHoldId = 0

function onLiveEvent(e: LiveCaptureEvent<LiveFrameData>): void {
  if (e.holdId !== lastHoldId && e.type !== 'missed') {
    lastHoldId = e.holdId
    notifyNewHold()
  }
  switch (e.type) {
    case 'hold':
      liveProgress.value = e.progress
      setSignal('hold')
      break
    case 'captured': {
      probe({
        type: 'captured',
        pageNo: e.pageNo,
        bestT: e.best.t,
        bestIdx: e.best.data.idx,
        quad: e.best.quad,
        t: e.t,
      })
      liveProgress.value = 1
      setSignal('captured', 700)
      vibrateCaptured()
      beepCaptured()
      const warped = e.best.data.warped
      if (!warped) break
      liveStrip.value = [
        ...liveStrip.value,
        { id: `l${e.pageNo}`, kind: 'captured', thumb: thumbOf(warped) },
      ]
      const target = retakeTarget.value
      // A retake ends at its first ✓.
      if (target !== null) retakeTarget.value = null
      const p = takeShot(warped).then(async (shot) => {
        probe({ type: 'shot', pageNo: e.pageNo, source: shot.source })
        // After the still is cropped (it must show this page): on an open
        // book, move to the other page of the spread.
        notifyPageCaptured()
        if (target !== null) {
          await finishRetake(target, shot)
        } else {
          scanLive.shots.set(e.pageNo, shot)
        }
      })
      pendingShots.push(
        p.catch((err) => console.warn('[live] shot failed', err)),
      )
      break
    }
    case 'missed': {
      probe({ type: 'missed', startT: e.startT, endT: e.endT, t: e.t })
      setSignal('missed', 1500)
      const warped = e.best.data.warped
      const thumb = warped ? thumbOf(warped) : ''
      scanLive.misses.push({ startT: e.startT, endT: e.endT, thumb })
      liveStrip.value = [
        ...liveStrip.value,
        { id: `m${e.startT}`, kind: 'missed', thumb },
      ]
      break
    }
    case 'resumed':
      break
  }
}

/** Longest edge of a quad, in its own pixel space. */
function quadLongEdge(q: Quad): number {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y)
  return Math.max(d(q.tl, q.tr), d(q.bl, q.br), d(q.tl, q.bl), d(q.tr, q.br))
}

/** Detection is serialized: the ORT session must not run two inferences at
 *  once, and the still is detected while the frame loop keeps running. */
let detectChain: Promise<unknown> = Promise.resolve()
function detectSerial(
  canvas: HTMLCanvasElement,
  opts: { still?: boolean } = {},
): ReturnType<typeof detectDocument> {
  const next = detectChain.then(() => detectDocument(canvas, opts))
  detectChain = next.catch(() => null)
  return next
}

/**
 * The page image for a ✓: a full-resolution still when the camera can
 * take one and the page is found in it, else the hold's best video frame.
 */
async function takeShot(videoWarped: HTMLCanvasElement): Promise<LiveShot> {
  const photo = await stillCapturer?.take()
  if (photo) {
    try {
      const full = await blobToImageCanvas(photo)
      // Detect on a reduced copy (detector input is small anyway), then
      // crop the full-resolution still with the scaled-up quad.
      const small = downscaleToLongSide(full, 1280)
      const det = await detectSerial(small, { still: true })
      if (
        det &&
        judge &&
        det.confidence >= judge.opts.minConfidence &&
        (det.boxAgreement ?? 1) >= judge.opts.minBoxAgreement
      ) {
        const quad = scaleQuad(
          det.quad,
          small.width,
          small.height,
          full.width,
          full.height,
        )
        probe({
          type: 'photo',
          quad,
          w: full.width,
          h: full.height,
          sig: (globalThis as { __astarProbe?: unknown }).__astarProbe
            ? frameSignature(full)
            : null,
        })
        const warped = rotateAndCropQuad(
          full,
          quad,
          Math.round(quadLongEdge(quad)),
          0.03,
        )
        const blob = await canvasToJpegBlob(warped, 0.9)
        return {
          blob,
          dataUrl: await blobToDataUrl(blob),
          width: warped.width,
          height: warped.height,
          source: 'photo',
        }
      }
    } catch (err) {
      console.warn(
        '[live] still could not be cropped, using the video frame',
        err,
      )
    }
  }
  const blob = await canvasToJpegBlob(videoWarped, 0.85)
  return {
    blob,
    dataUrl: await blobToDataUrl(blob),
    width: videoWarped.width,
    height: videoWarped.height,
    source: 'video',
  }
}

function shotPage(id: string, shot: LiveShot, capturedAt: number): Page {
  return {
    id,
    dataUrl: shot.dataUrl,
    width: shot.width,
    height: shot.height,
    capturedAt,
  }
}

const rowIdOf = (r: CaptureRow): string =>
  r.missSpan
    ? `m${r.missSpan.startT}`
    : r.livePageNo !== undefined
      ? `l${r.livePageNo}`
      : `c${r.clusterKey}`

/**
 * Build the output pages and the end-of-scan table from the cluster array
 * (the repair controls' source of truth) plus what the scan showed live.
 */
async function buildPagesFromClusters(
  cs: readonly SegmentCluster<ScanRecord>[],
): Promise<Page[]> {
  const report = buildCaptureReport(
    scanLive.spans,
    scanLive.misses,
    cs.map((c) => ({
      key: c.winner.idx,
      memberT: c.members.map((m) => frameTimes[m.idx] ?? m.t_s),
    })),
  )
  const byKey = new Map(cs.map((c) => [c.winner.idx, c]))
  const pages: Page[] = []
  const rows: ReportViewRow[] = []
  const base = preScanPages.value.length

  const clusterPage = async (c: SegmentCluster<ScanRecord>): Promise<Page> => {
    const w = c.winner
    // Derived from the scan and the winner frame, so a page keeps its
    // identity across repairs that don't touch it (stable Vue key, stable
    // open detail) and never collides with an earlier scan's page.
    const page: Page = {
      id: `s${scanId.value}-c${w.idx}`,
      dataUrl: await blobToDataUrl(w.warpedBlob),
      width: w.warpedWidth,
      height: w.warpedHeight,
      capturedAt: w.capturedAt,
      clusterKey: w.idx,
      memberCount: c.members.length,
    }
    const validator = validatorByFrame.get(w)
    const bestFramePick = bestFrameByFrame.get(w)
    if (validator || bestFramePick) {
      const dbg: LlmDebug = {}
      if (validator) dbg.validator = validator
      if (bestFramePick) dbg.bestFramePick = bestFramePick
      page.llmDebug = dbg
    }
    return page
  }

  for (const r of report) {
    const id = rowIdOf(r)
    const c = r.clusterKey !== undefined ? byKey.get(r.clusterKey) : undefined
    const retake = r.missSpan ? retakes.get(r.missSpan.startT) : undefined
    let page: Page | null = null
    let kind: ReportViewRow['kind'] = r.kind
    let source: ReportViewRow['source'] = null
    let thumb: string | null = null

    if (retake && r.missSpan) {
      page = {
        ...shotPage(
          `s${scanId.value}-r${r.missSpan.startT}`,
          retake,
          performance.now(),
        ),
        retakeOf: r.missSpan.startT,
      }
      kind = 'captured'
      source = retake.source
    } else if (r.kind === 'missed') {
      thumb =
        scanLive.misses.find((m) => m.startT === r.missSpan?.startT)?.thumb ||
        null
    } else if (r.kind === 'recovered') {
      if (c) page = await clusterPage(c)
    } else if (r.livePageNo !== undefined) {
      if (removedLive.has(r.livePageNo)) continue
      const shot = scanLive.shots.get(r.livePageNo)
      if (shot) {
        page = {
          ...shotPage(
            `s${scanId.value}-l${r.livePageNo}`,
            shot,
            performance.now(),
          ),
          livePageNo: r.livePageNo,
        }
        source = shot.source
        // The first live page of a cluster stands for the cluster in the
        // repair controls; a duplicate does not (one key, one page).
        if (r.kind === 'captured' && c) {
          page.clusterKey = c.winner.idx
          page.memberCount = c.members.length
        }
      } else if (c && r.kind === 'captured') {
        page = await clusterPage(c)
      }
    }
    if (page) pages.push(page)
    rows.push({
      id,
      kind,
      no: page ? base + pages.length : null,
      thumb: page?.dataUrl ?? thumb,
      source,
      duplicateOfNo: null,
      canRetake: !retake && !!r.missSpan,
      pageId: page?.id ?? null,
    })
    if (r.kind === 'duplicate' && r.duplicateOf !== undefined) {
      const orig = rows.find((x) => x.id === `l${r.duplicateOf}`)
      rows[rows.length - 1]!.duplicateOfNo = orig?.no ?? null
    }
  }
  reportView.value = rows
  return pages
}

async function loadMembers(key: number): Promise<void> {
  const c = repairClusters.value.find((x) => x.winner.idx === key)
  if (!c) {
    detailMembers.value = []
    return
  }
  membersLoading.value = true
  try {
    detailMembers.value = await Promise.all(
      c.members.map(async (m) => ({
        idx: m.idx,
        t_s: m.t_s,
        dataUrl: await blobToDataUrl(m.warpedBlob),
        isWinner: m.idx === c.winner.idx,
      })),
    )
  } finally {
    membersLoading.value = false
  }
}

/** Commit a repaired cluster array and rebuild the visible page list. */
async function applyRepair(next: SegmentCluster<ScanRecord>[]): Promise<void> {
  repairClusters.value = next
  mergeSelection.value = []
  captured.value = [
    ...preScanPages.value,
    ...(await buildPagesFromClusters(next)),
  ]
  // The open detail view holds a Page object that the rebuild just
  // replaced. Re-resolve it by id, or close it if the repair removed it.
  if (selectedPage.value) {
    const stillThere = captured.value.find(
      (p) => p.id === selectedPage.value?.id,
    )
    selectedPage.value = stillThere ?? null
  }
  if (detailKey.value !== null) {
    if (next.some((c) => c.winner.idx === detailKey.value)) {
      await loadMembers(detailKey.value)
    } else {
      closeMembers()
    }
  }
  // A repair can retire the key the editor is holding (merge/split/remove
  // re-elect winners). Its source URL would then point at a frame that no
  // longer represents any page.
  if (
    quadEditKey.value !== null &&
    !next.some((c) => c.winner.idx === quadEditKey.value)
  ) {
    closeQuadEdit()
  }
  void saveSession(captured.value.map(pageToStored))
}

function toggleMergeSelection(key: number): void {
  mergeSelection.value = mergeSelection.value.includes(key)
    ? mergeSelection.value.filter((k) => k !== key)
    : [...mergeSelection.value, key]
}

async function repairMerge(): Promise<void> {
  await applyRepair(mergeClusters(repairClusters.value, mergeSelection.value))
}

async function repairRemove(key: number): Promise<void> {
  await applyRepair(removeCluster(repairClusters.value, key))
}

async function repairSplit(key: number, atIdx: number): Promise<void> {
  await applyRepair(splitCluster(repairClusters.value, key, atIdx))
}

async function repairSetWinner(key: number, memberIdx: number): Promise<void> {
  const next = setClusterWinner(repairClusters.value, key, memberIdx)
  // Re-electing the winner moves the cluster's key onto the chosen frame.
  detailKey.value = memberIdx
  await applyRepair(next)
}

async function openMembers(key: number): Promise<void> {
  detailKey.value = key
  await loadMembers(key)
}

function closeMembers(): void {
  detailKey.value = null
  detailMembers.value = []
}

// ---- manual corner correction ----------------------------------------

/** Cluster whose winner is open in the corner editor. */
const quadEditKey = ref<number | null>(null)
/** Object URL of that winner's source frame; revoked on close. */
const quadEditUrl = ref('')

/** The winner record behind the open editor, or null. */
const quadEditFrame = computed(() =>
  quadEditKey.value === null
    ? null
    : (repairClusters.value.find((c) => c.winner.idx === quadEditKey.value)
        ?.winner ?? null),
)

function openQuadEdit(key: number): void {
  const frame = repairClusters.value.find((c) => c.winner.idx === key)?.winner
  if (!frame) return
  closeQuadEdit()
  quadEditKey.value = key
  quadEditUrl.value = URL.createObjectURL(frame.srcBlob)
}

function closeQuadEdit(): void {
  if (quadEditUrl.value) URL.revokeObjectURL(quadEditUrl.value)
  quadEditUrl.value = ''
  quadEditKey.value = null
}

/**
 * Re-crop the winner from its retained source using the corrected quad.
 *
 * `updatePageQuad` in types.ts requires the warped image and the pHash be
 * regenerated; the long side comes from `classifyQuad` exactly as it does
 * during capture, so a corrected page is sized by the same rule as an
 * auto-detected one. `score` is deliberately NOT recomputed — it decides
 * winner election on a later merge, and fixing a crop must not silently
 * change which frame represents a page.
 */
async function saveQuadEdit(quad: Quad): Promise<void> {
  const key = quadEditKey.value
  const w = quadEditFrame.value
  if (key === null || !w) {
    closeQuadEdit()
    return
  }
  try {
    const src = await blobToCanvas(w.srcBlob, w.srcW, w.srcH)
    const cls = classifyQuad(quad, w.srcW, w.srcH)
    const longSide = cls.target
      ? Math.max(cls.target.width, cls.target.height)
      : LONG_SIDE_DEFAULT
    const warped = rotateAndCropQuad(src, quad, longSide, 0.03)
    const patch = {
      quad,
      warpedBlob: await canvasToJpegBlob(warped, 0.75),
      warpedWidth: warped.width,
      warpedHeight: warped.height,
      hash: computePHash(warped),
      tileHash: computeTilePHash(warped),
    }
    closeQuadEdit()
    await applyRepair(updateClusterCrop(repairClusters.value, key, patch))
  } catch (err) {
    console.warn('[saveQuadEdit] re-crop failed', err)
    closeQuadEdit()
  }
}

const videoRef = ref<HTMLVideoElement | null>(null)
const overlayRef = ref<HTMLCanvasElement | null>(null)
const mediaStream = ref<MediaStream | null>(null)

const route = useRoute()
const debugMode = computed(() => route.query.debug === '1')

let detectorReady = false

/** A frame in the segment pipeline: DetectedFrame payload + the temporal
 *  identity (`idx` = sample counter, `t_s` = idx × SAMPLE_INTERVAL_S)
 *  that clusterBySegments reasons over. */
interface ScanRecord extends DetectedFrame {
  idx: number
  t_s: number
  tileHash: bigint[]
  ten: number
  /** Reduced source frame, pre-warp. Manual corner correction re-warps
   *  from this; the warped crop cannot be un-warped. */
  srcBlob: Blob
  /** Pixel size of `srcBlob` — NOT of the capture canvas it came from. */
  srcW: number
  srcH: number
  /** Detected quad, expressed in `srcBlob` pixel space so the editor and
   *  the re-warp share one coordinate system. */
  quad: Quad
}

/** Frames that cleared every gate (conf + blur). */
let acceptedRecords: ScanRecord[] = []
/** Blur-gate rejects that cleared the rescue floors — the gap-rescue
 *  pool. Sharp illustration-heavy pages live here (Tenengrad measures
 *  texture, not blur). */
let candidateRecords: ScanRecord[] = []
let sampledFrames = 0
let detectedFrames = 0
let lastOverlayInfo: OverlayInfo | null = null

interface OverlayInfo {
  quad: Quad | null
  laplacian: number
  tenengrad: number
  area: number
  confidence: number
  score: number
  source: 'yolo-pose' | 'opencv' | 'pending'
  srcW: number
  srcH: number
}

onMounted(async () => {
  const saved = await loadSession()
  if (saved?.pages?.length) {
    captured.value = saved.pages.map(storedToPage)
  }

  // WebGPU probe. Failing requestAdapter() (Firefox / Safari < 26 / older
  // Chrome on non-supported GPUs) disables LLM features without breaking
  // the heuristic path. Stays off in non-secure contexts too.
  try {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = await (navigator as any).gpu?.requestAdapter()
      llmAvailable.value = !!adapter
    }
  } catch (err) {
    console.warn('[index] WebGPU probe failed:', err)
    llmAvailable.value = false
  }
  if (!llmAvailable.value) useLlm.value = false
})

// ---------------------------------------------------------------------------
// Detection pipeline
// ---------------------------------------------------------------------------

async function ensureDetector(): Promise<void> {
  if (detectorReady) return
  await ensureDocDetector()
  detectorReady = true
}

/**
 * Sharpness metrics — implementation unified in scan-core
 * (pipeline/sharpness.ts), bound to OpenCV.js via pipeline-ops. Returns 0
 * while OpenCV is still loading, matching the old window.cv probes.
 * Laplacian variance catches defocus; Tenengrad catches motion blur.
 */
function computeLaplacian(canvas: HTMLCanvasElement): number {
  const ops = getPipelineOps()
  return ops ? ops.computeLaplacian(canvas as unknown as CanvasLike) : 0
}

function computeTenengrad(canvas: HTMLCanvasElement): number {
  const ops = getPipelineOps()
  return ops ? ops.computeTenengrad(canvas as unknown as CanvasLike) : 0
}

function canvasToJpegBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('canvas.toBlob returned null'))
      },
      'image/jpeg',
      quality,
    )
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Commit the winners to the persisted `captured[]` via the segment-first
 * pipeline — scan-core `clusterBySegments`, the SAME algorithm and
 * thresholds the eval harness froze at identity recall 1.0 / zero missed
 * pages on both GT videos (`bun scripts/eval/regress.mjs`):
 *
 *   L1  temporal runs over accepted frames (acceptance gap > 1 s = page
 *       turn); suspicious in-run gaps verified by ORB, then the verifier
 *   →   gap rescue: > 2.5 s gaps are scanned in `candidateRecords` for
 *       blur-gated sparse pages (center-weighted best pick, NMS)
 *   →   L2 union-find merge: tile ≤ 18 unconditional → ORB ≥ 25/50 with
 *       grid ≥ 8 → OCR 3-gram Jaccard for adjacent text pairs that defeat
 *       every classical signal
 *
 * verifySame = NDLOCR-Lite OCR text + scan-core text-similarity (the eval
 * harness uses YomiToku for the OCR half; the judgment is identical).
 * When OCR abstains (graphics / occlusion) and LLM is enabled, the VLM
 * pair-compare is the fallback verifier.
 */
async function finalizeScan(
  opts: { enableLlm: boolean } = { enableLlm: false },
): Promise<void> {
  const llmOn = opts.enableLlm && llmAvailable.value
  const records = [...acceptedRecords].sort((a, b) => a.idx - b.idx)
  const candidates = [...candidateRecords].sort((a, b) => a.idx - b.idx)
  const byIdx = new Map<number, ScanRecord>()
  for (const r of records) byIdx.set(r.idx, r)
  for (const r of candidates) byIdx.set(r.idx, r)

  const canvasCache = new Map<number, Promise<HTMLCanvasElement>>()
  const loadCanvas = (idx: number): Promise<CanvasLike> => {
    let p = canvasCache.get(idx)
    if (!p) {
      const r = byIdx.get(idx)
      if (!r)
        return Promise.reject(
          new Error(`finalizeScan: no record for idx ${idx}`),
        )
      p = blobToCanvas(r.warpedBlob, r.warpedWidth, r.warpedHeight)
      canvasCache.set(idx, p)
    }
    return p as unknown as Promise<CanvasLike>
  }

  // ORB ops from scan-core (bound to OpenCV.js). If OpenCV failed to
  // load, fall back to an abstaining stub — cuts then rely on the
  // verifier and merges on tile distance + verifier.
  const ops = getPipelineOps()
  const orb: SegmentHooks['orb'] = ops ?? {
    computeOrbDescriptors: () => null,
    countOrbMatches: () => ({ inliers: 0, gridCoverage: 0 }),
  }

  // NDLOCR-Lite loads lazily on the FIRST ambiguous pair (~147 MB models,
  // IndexedDB-cached after the first download) — scans without dense-text
  // ambiguity never pay for it.
  let ocrInit: Promise<boolean> | null = null
  const ensureOcr = (): Promise<boolean> =>
    (ocrInit ??= initOcr()
      .then(() => true)
      .catch((err) => {
        console.warn('[finalizeScan] OCR init failed — text verifier off:', err)
        return false
      }))
  const ocrTexts = new Map<number, Promise<string | null>>()
  const ocrTextOf = (idx: number): Promise<string | null> => {
    let p = ocrTexts.get(idx)
    if (!p) {
      p = (async (): Promise<string | null> => {
        if (!(await ensureOcr())) return null
        const r = byIdx.get(idx)
        if (!r) return null
        const result = await runOcr(await blobToDataUrl(r.warpedBlob))
        return result.text.replace(/\s+/g, '')
      })().catch((err) => {
        console.warn(`[finalizeScan] OCR failed for idx=${idx}:`, err)
        return null
      })
      ocrTexts.set(idx, p)
    }
    return p
  }
  const verifySame = async (
    aIdx: number,
    bIdx: number,
    gapS: number,
  ): Promise<boolean | null> => {
    const [ta, tb] = await Promise.all([ocrTextOf(aIdx), ocrTextOf(bIdx)])
    const v = verifySameText(ta, tb, gapS)
    if (v != null) {
      console.log(
        `[verify-ocr] ${aIdx}↔${bIdx}: jaccard=${v.jaccard.toFixed(3)} containment=${v.containment.toFixed(3)} gap=${gapS.toFixed(1)}s → ${v.same ? 'same' : 'diff'}`,
      )
      return v.same
    }
    // OCR abstained (graphics page / too little text). Optional VLM rescue.
    if (llmOn) {
      try {
        const ra = byIdx.get(aIdx)
        const rb = byIdx.get(bIdx)
        if (!ra || !rb) return null
        const [aUrl, bUrl] = await Promise.all([
          blobToDataUrl(ra.warpedBlob),
          blobToDataUrl(rb.warpedBlob),
        ])
        const r = await arePairSameCard(aUrl, bUrl)
        console.log(
          `[verify-llm] ${aIdx}↔${bIdx}: ${r.same ? 'same' : 'diff'} (conf ${r.confidence})`,
        )
        return r.same
      } catch (err) {
        console.warn('[verify-llm] pair compare failed:', err)
        return null
      }
    }
    return null
  }

  statusText.value = `クラスタリング中… (採用 ${records.length} / 救済候補 ${candidates.length})`
  const { clusters, debug } = await clusterBySegments(
    records,
    loadCanvas,
    {},
    { orb, verifySame },
    candidates,
  )
  console.log(
    `[finalizeScan] ${clusters.length} clusters (${debug.rescues.length} rescued, ${debug.cuts.length} cuts)`,
    debug,
  )

  // ---- Winner per cluster: composite score (eval-aligned default);
  //      LLM best-frame re-pick only when enabled. The pick is applied as
  //      a winner override on the cluster array, which from here on is the
  //      single source of truth for the review screen — repairs rebuild
  //      the page list from it rather than editing pages directly. ----
  let working: SegmentCluster<ScanRecord>[] = [...clusters]
  if (llmOn) {
    const clustersToPick = clusters.filter((c) => c.members.length > 1)
    llmProgress.value = {
      done: 0,
      total: clustersToPick.length,
      phase: 'ベストフレーム選定',
    }
    for (const cluster of clustersToPick) {
      const K = Math.min(4, cluster.members.length)
      const topK = [...cluster.members]
        .sort((a, b) => b.score - a.score)
        .slice(0, K)
      const llmCandidates = await Promise.all(
        topK.map(async (m, i) => ({
          id: `${i}`,
          imageDataUrl: await blobToDataUrl(m.warpedBlob),
          score: m.score,
        })),
      )
      const pick = await pickBestFrameByLlm(llmCandidates)
      const picked = topK[pick.pickedIndex]
      if (picked) {
        bestFrameByFrame.set(picked, pick)
        working = setClusterWinner(working, cluster.winner.idx, picked.idx)
      }
      if (llmProgress.value) {
        llmProgress.value = {
          ...llmProgress.value,
          done: llmProgress.value.done + 1,
        }
      }
    }
  }

  // ---- Build Pages from clusters + what the scan showed live ----
  scanLive.spans = judge?.pages ?? []
  llmProgress.value = null
  scanId.value += 1
  preScanPages.value = captured.value.map(detachRepair)
  repairClusters.value = working
  mergeSelection.value = []
  closeMembers()
  closeQuadEdit()
  captured.value = [
    ...preScanPages.value,
    ...(await buildPagesFromClusters(working)),
  ]
  acceptedRecords = []
  candidateRecords = []
  void saveSession(captured.value.map(pageToStored))

  // Auto-dump to dev server so debug state is on disk without the
  // user clicking anything. Dev-only: production/static builds have no
  // /api/debug-export, and even a silently-failing fetch shows up as a
  // console 404.
  if (import.meta.dev) {
    void postDebugJson(false).then((r) => {
      if (r?.latestPath) console.log('[finalizeScan] auto-saved:', r.latestPath)
    })
  }
}

function blobToCanvas(
  blob: Blob,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get 2D context for blobToCanvas'))
        return
      }
      ctx.drawImage(img, 0, 0)
      resolve(canvas)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to decode JPEG blob for ORB merge'))
    }
    img.src = url
  })
}

async function processFrame(
  video: HTMLVideoElement,
  opts: {
    enableLlm?: boolean
    /** Scan time in seconds (video time / wall clock) for the live judge. */
    t: number
    /** False during a retake: feed the live judge only, keep no records. */
    collect?: boolean
  },
): Promise<void> {
  if (!detectorReady) return
  if (video.readyState < 2 || video.videoWidth === 0) return
  const collect = opts.collect !== false

  // Temporal identity for the segment pipeline: the sample counter is the
  // frame index (10 fps → idx gap of 10 ≈ 1 s), matching the eval harness.
  const idx = sampledFrames
  const t_s = idx * SAMPLE_INTERVAL_S
  if (collect) {
    sampledFrames += 1
    frameTimes[idx] = opts.t
  }

  const work = document.createElement('canvas')
  work.width = video.videoWidth
  work.height = video.videoHeight
  work.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0)

  const detectStart = performance.now()
  const detection = await detectSerial(work)
  probe({
    type: 'frame',
    idx,
    t: opts.t,
    detectMs: Math.round(performance.now() - detectStart),
    w: work.width,
    h: work.height,
    quad: detection?.quad ?? null,
    confidence: detection?.confidence ?? 0,
    boxAgreement: detection?.boxAgreement ?? null,
    sig: (globalThis as { __astarProbe?: unknown }).__astarProbe
      ? frameSignature(work)
      : null,
  })
  const liveBase = {
    t: opts.t,
    frameW: work.width,
    frameH: work.height,
  }
  if (!detection) {
    feedLive({
      ...liveBase,
      confidence: 0,
      quad: null,
      areaFrac: 0,
      score: 0,
      hash: null,
      data: { idx, warped: null },
    })
    lastOverlayInfo = {
      quad: null,
      laplacian: 0,
      tenengrad: 0,
      area: 0,
      confidence: 0,
      score: 0,
      source: getDetectorSource(),
      srcW: work.width,
      srcH: work.height,
    }
    renderOverlay()
    return
  }

  if (detection.confidence < MIN_CONFIDENCE) {
    feedLive({
      ...liveBase,
      confidence: detection.confidence,
      quad: detection.quad,
      boxAgreement: detection.boxAgreement,
      areaFrac: 0,
      score: 0,
      hash: null,
      data: { idx, warped: null },
    })
    lastOverlayInfo = {
      quad: detection.quad,
      laplacian: 0,
      tenengrad: 0,
      area: 0,
      confidence: detection.confidence,
      score: 0,
      source: detection.source,
      srcW: work.width,
      srcH: work.height,
    }
    renderOverlay()
    return
  }

  detectedFrames += 1

  // Aspect-preserving crop: derive long side from the detected mode.
  // No more 1200×1600 stretch — landscape cards stay landscape.
  const cls = classifyQuad(detection.quad, work.width, work.height)
  const longSide = cls.target
    ? Math.max(cls.target.width, cls.target.height)
    : LONG_SIDE_DEFAULT
  const warped = rotateAndCropQuad(work, detection.quad, longSide, 0.03)
  const hash = computePHash(warped)
  const tileHash = computeTilePHash(warped)
  const lap = computeLaplacian(warped)
  const ten = computeTenengrad(warped)
  const areaFrac = quadArea(detection.quad) / (work.width * work.height)
  const score = combinedScore(lap, ten, detection.confidence, areaFrac)
  probe({
    type: 'hash',
    idx,
    hash: hash.toString(16),
    tile: tileHash.map((h) => h.toString(16)),
  })

  // Live ✓ / miss judgment sees every detected frame — no blur gate.
  feedLive({
    ...liveBase,
    confidence: detection.confidence,
    quad: detection.quad,
    boxAgreement: detection.boxAgreement,
    areaFrac,
    score,
    hash,
    data: { idx, warped },
  })
  if (!collect) {
    lastOverlayInfo = {
      quad: detection.quad,
      laplacian: lap,
      tenengrad: ten,
      area: areaFrac,
      confidence: detection.confidence,
      score,
      source: detection.source,
      srcW: work.width,
      srcH: work.height,
    }
    renderOverlay()
    return
  }

  /** Reduced source frame + the detected quad mapped into its pixel space
   *  — the only inputs a later corner correction can re-warp from. The
   *  warped crop alone cannot be un-warped.
   *
   *  Called at the push sites rather than here so a frame that clears
   *  neither the blur gate nor the rescue floors never pays for the
   *  encode. */
  const snapshotSource = async () => {
    const src = downscaleToLongSide(work, SRC_LONG_SIDE)
    return {
      srcBlob: await canvasToJpegBlob(src, SRC_JPEG_Q),
      srcW: src.width,
      srcH: src.height,
      quad: scaleQuad(
        detection.quad,
        work.width,
        work.height,
        src.width,
        src.height,
      ),
    }
  }

  // Pre-cluster blur gate. Obviously-blurry frames would otherwise compete
  // for "best in cluster" and occasionally win. BUT the gate is content-
  // biased (Tenengrad ∝ texture): sharp illustration-heavy pages fail it
  // too. Rejects that clear the rescue floors go to `candidateRecords` so
  // the gap-rescue pass can recover whole pages instead of dropping them
  // silently (measured: 4/11 pages lost on mp4-1 without this).
  if (ten < MIN_TENENGRAD) {
    if (
      ten >= RESCUE_MIN_TENENGRAD &&
      detection.confidence >= RESCUE_MIN_CONFIDENCE &&
      areaFrac >= RESCUE_MIN_AREA_FRAC
    ) {
      try {
        const blob = await canvasToJpegBlob(warped, 0.75)
        candidateRecords.push({
          idx,
          t_s,
          hash,
          tileHash,
          ten,
          sharpness: lap,
          confidence: detection.confidence,
          areaFrac,
          score,
          warpedBlob: blob,
          warpedWidth: warped.width,
          warpedHeight: warped.height,
          capturedAt: performance.now(),
          // Rescued frames are exactly the marginal pages a user is most
          // likely to want to re-crop, so they carry a source too.
          ...(await snapshotSource()),
        })
        if (candidateRecords.length > CANDIDATE_POOL_MAX) {
          // Evict the lowest score — rescue always picks per-gap maxima,
          // so globally weak candidates are the safest to drop.
          let worst = 0
          for (let i = 1; i < candidateRecords.length; i += 1) {
            if (candidateRecords[i]!.score < candidateRecords[worst]!.score)
              worst = i
          }
          candidateRecords.splice(worst, 1)
        }
      } catch (err) {
        console.warn('[processFrame] failed to snapshot rescue candidate', err)
      }
    }
    lastOverlayInfo = {
      quad: detection.quad,
      laplacian: lap,
      tenengrad: ten,
      area: areaFrac,
      confidence: detection.confidence,
      score,
      source: detection.source,
      srcW: work.width,
      srcH: work.height,
    }
    renderOverlay()
    return
  }

  // LLM frame validator (startFromFile path only; live camera skips).
  // Runs *before* enqueueing into the collector so quality<2 frames are
  // dropped at the source — they shouldn't compete for "best in cluster"
  // and they shouldn't show up in the strip drawer at all.
  let validatorResult: ValidationResult | undefined
  if (opts.enableLlm === true && llmAvailable.value) {
    try {
      const dataUrl = warped.toDataURL('image/jpeg', 0.75)
      validatorResult = await validateFrame(dataUrl)
      if (llmProgress.value) {
        llmProgress.value = {
          ...llmProgress.value,
          done: llmProgress.value.done + 1,
        }
      }
      if (validatorResult.quality < 2) {
        // drop unusable frame, but still update overlay so the user sees
        // detection happened
        lastOverlayInfo = {
          quad: detection.quad,
          laplacian: lap,
          tenengrad: ten,
          area: areaFrac,
          confidence: detection.confidence,
          score,
          source: detection.source,
          srcW: work.width,
          srcH: work.height,
        }
        renderOverlay()
        return
      }
    } catch (err) {
      console.warn('[processFrame] LLM validator failed, fail-open:', err)
    }
  }

  try {
    const blob = await canvasToJpegBlob(warped, 0.75)
    const frame: ScanRecord = {
      idx,
      t_s,
      hash,
      tileHash,
      ten,
      sharpness: lap,
      confidence: detection.confidence,
      areaFrac,
      score,
      warpedBlob: blob,
      warpedWidth: warped.width,
      warpedHeight: warped.height,
      capturedAt: performance.now(),
      ...(await snapshotSource()),
    }
    acceptedRecords.push(frame)
    // Safety valve for very long live-camera sessions (same policy the
    // old FrameCollector had): drop oldest first.
    if (acceptedRecords.length > ACCEPTED_MAX) {
      acceptedRecords.splice(0, acceptedRecords.length - ACCEPTED_MAX)
      // Evicted frames are gone for good, so the earliest pages of this
      // scan will have fewer (or no) candidates to split or re-pick from.
      // The review screen says so rather than silently offering less.
      bufferTruncated.value = true
    }
    if (validatorResult) validatorByFrame.set(frame, validatorResult)
  } catch (err) {
    console.warn('[processFrame] failed to snapshot warped canvas', err)
  }

  lastOverlayInfo = {
    quad: detection.quad,
    laplacian: lap,
    tenengrad: ten,
    area: areaFrac,
    confidence: detection.confidence,
    score,
    source: detection.source,
    srcW: work.width,
    srcH: work.height,
  }
  renderOverlay()
}

// ---------------------------------------------------------------------------
// Debug overlay
// ---------------------------------------------------------------------------

/**
 * Live blob footprint of the two ring buffers, in MB.
 *
 * Retaining a source frame per record (for manual corner correction)
 * roughly doubles what a scan holds, and the ceiling is set by
 * `SRC_LONG_SIDE` / `SRC_JPEG_Q` — constants picked without a real device
 * to measure on. This is the readout that settles them.
 */
function bufferedMb(): string {
  let warp = 0
  let src = 0
  for (const r of [...acceptedRecords, ...candidateRecords]) {
    warp += r.warpedBlob.size
    src += r.srcBlob.size
  }
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
  return `mem warp=${mb(warp)}MB  src=${mb(src)}MB`
}

const SIGNAL_COLOR: Record<LiveSignal, string> = {
  none: 'rgba(255, 255, 255, 0.7)',
  hold: '#facc15',
  captured: '#22c55e',
  missed: '#ef4444',
}

/**
 * Viewport overlay: the detected page outline colored by the live judge —
 * yellow + progress while held, green at ✓, red when a page was turned
 * before it was captured. `?debug=1` adds the metric readout.
 */
function renderOverlay(): void {
  const canvas = overlayRef.value
  const video = videoRef.value
  if (!canvas || !video) return
  const rect = video.getBoundingClientRect()
  if (
    canvas.width !== Math.round(rect.width) ||
    canvas.height !== Math.round(rect.height)
  ) {
    canvas.width = Math.round(rect.width)
    canvas.height = Math.round(rect.height)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (phase.value !== 'scanning') return
  const info = lastOverlayInfo
  const signal = liveSignal.value
  const color = SIGNAL_COLOR[signal]

  if (info?.quad) {
    // Map source coords → on-screen coords. Video uses object-fit: contain,
    // so compute the letterboxed viewport the same way.
    const scale = Math.min(canvas.width / info.srcW, canvas.height / info.srcH)
    const offX = (canvas.width - info.srcW * scale) / 2
    const offY = (canvas.height - info.srcH * scale) / 2
    const toScreen = (p: { x: number; y: number }) => ({
      x: offX + p.x * scale,
      y: offY + p.y * scale,
    })
    ctx.strokeStyle = color
    ctx.lineWidth = signal === 'none' ? 2 : 5
    ctx.beginPath()
    const pts = [info.quad.tl, info.quad.tr, info.quad.br, info.quad.bl]
    pts.forEach((p, i) => {
      const sp = toScreen(p)
      if (i === 0) ctx.moveTo(sp.x, sp.y)
      else ctx.lineTo(sp.x, sp.y)
    })
    ctx.closePath()
    ctx.stroke()
  }

  if (signal === 'hold' || signal === 'captured') {
    const w = canvas.width - 32
    const p = signal === 'captured' ? 1 : Math.min(1, liveProgress.value)
    ctx.fillStyle = 'rgba(15, 23, 42, 0.55)'
    ctx.fillRect(16, 16, w, 10)
    ctx.fillStyle = color
    ctx.fillRect(16, 16, w * p, 10)
  }
  if (signal === 'captured') {
    ctx.fillStyle = color
    ctx.font = 'bold 56px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('✓', canvas.width / 2, canvas.height / 2 + 20)
    ctx.textAlign = 'start'
  }
  if (signal === 'missed') {
    const text = 'まだ撮れていません'
    ctx.font = 'bold 20px system-ui, sans-serif'
    const tw = ctx.measureText(text).width
    const x = (canvas.width - tw) / 2
    ctx.fillStyle = 'rgba(239, 68, 68, 0.92)'
    ctx.fillRect(x - 14, 14, tw + 28, 38)
    ctx.fillStyle = '#fff'
    ctx.fillText(text, x, 40)
    ctx.strokeStyle = color
    ctx.lineWidth = 6
    ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6)
  }

  if (!debugMode.value || !info) return
  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)'
  ctx.fillRect(8, canvas.height - 114, 340, 106)
  ctx.fillStyle = '#e2e8f0'
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace'
  const lines = [
    `lap=${info.laplacian.toFixed(0)}  ten=${info.tenengrad.toFixed(0)}  area=${info.area.toFixed(2)}`,
    `conf=${info.confidence.toFixed(2)}  score=${info.score.toFixed(2)}`,
    `src=${info.source}  buf=${acceptedRecords.length}+${candidateRecords.length}`,
    `det=${detectedFrames}/${sampledFrames}  captured=${captured.value.length}`,
    bufferedMb(),
  ]
  lines.forEach((line, i) => {
    ctx.fillText(line, 16, canvas.height - 94 + i * 18)
  })
}

function resetPipelineState(): void {
  acceptedRecords = []
  candidateRecords = []
  sampledFrames = 0
  detectedFrames = 0
  lastOverlayInfo = null
  repairClusters.value = []
  preScanPages.value = []
  mergeSelection.value = []
  bufferTruncated.value = false
  frameTimes = []
  scanLive = { spans: [], misses: [], shots: new Map() }
  retakes.clear()
  removedLive.clear()
  reportView.value = []
  closeMembers()
  closeQuadEdit()
  if (overlayRef.value) {
    const ctx = overlayRef.value.getContext('2d')
    ctx?.clearRect(0, 0, overlayRef.value.width, overlayRef.value.height)
  }
}

// ---------------------------------------------------------------------------
// Video-file mode
// ---------------------------------------------------------------------------

async function startFromFile(): Promise<void> {
  const file = await pickFile()
  if (!file) return

  phase.value = 'loading'
  errorText.value = ''
  let objectUrl: string | null = null
  try {
    const video = videoRef.value
    if (!video) throw new Error('ビデオ要素が見つかりません')

    // Attach the video and start playback FIRST so the user sees the clip
    // while OpenCV initializes in parallel (first-time load is ~10 s). If
    // we awaited ensureDetector() first, the viewport stayed black for
    // that entire window and users thought playback had broken.
    objectUrl = URL.createObjectURL(file)
    video.srcObject = null
    video.load() // reset internal state after the srcObject=null assignment
    video.muted = true
    video.playsInline = true
    video.src = objectUrl
    await new Promise<void>((resolve, reject) => {
      video.oncanplay = () => resolve()
      video.onerror = () => reject(new Error('動画の読み込みに失敗しました'))
    })

    captured.value = []
    resetPipelineState()
    startLive(undefined)
    statusText.value = '検出器初期化中…'
    const detectorP = ensureDetector()

    phase.value = 'scanning'
    const enableLlm = useLlm.value && llmAvailable.value
    if (enableLlm) {
      llmProgress.value = { done: 0, total: 0, phase: 'フレーム検証' }
    }
    const duration = video.duration
    let lastSampleT = -999
    await video.play()
    await detectorP // detector must be ready before first processFrame runs

    await new Promise<void>((resolve) => {
      const step = async () => {
        if (video.ended) {
          resolve()
          return
        }
        if (video.currentTime - lastSampleT >= SAMPLE_INTERVAL_S) {
          lastSampleT = video.currentTime
          const pct =
            duration > 0 ? Math.round((video.currentTime / duration) * 100) : 0
          statusText.value = `解析中 ${pct}% (検出 ${detectedFrames}/${sampledFrames} / 候補 ${acceptedRecords.length})`
          if (enableLlm && llmProgress.value) {
            // bump total estimate so the bar reflects upcoming work
            llmProgress.value = {
              ...llmProgress.value,
              total: sampledFrames,
            }
          }
          await processFrame(video, { enableLlm, t: video.currentTime })
        }
        if (!video.ended) video.requestVideoFrameCallback(step)
        else resolve()
      }
      video.requestVideoFrameCallback(step)
      video.onended = () => resolve()
    })

    await endLive()
    statusText.value = `選抜中… (候補 ${acceptedRecords.length})`
    await finalizeScan({ enableLlm })

    URL.revokeObjectURL(objectUrl)
    objectUrl = null
    phase.value = 'done'
    statusText.value = `完了: ${captured.value.length} 枚 (検出 ${detectedFrames}/${sampledFrames})`
  } catch (err) {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    phase.value = 'error'
    errorText.value =
      err instanceof Error ? err.message : 'スキャンに失敗しました'
    statusText.value = ''
  }
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*,.mp4,.mov,.webm,.avi'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
}

// ---------------------------------------------------------------------------
// Live-camera mode
// ---------------------------------------------------------------------------

/**
 * Start the camera. With `retakeOf` (start time of a missed page) this is a
 * retake: no records are collected, and the first ✓ replaces that miss in
 * the report and stops the camera.
 */
async function startCamera(retakeOf?: number): Promise<void> {
  const retaking = typeof retakeOf === 'number'
  phase.value = 'loading'
  errorText.value = ''
  try {
    const video = videoRef.value
    if (!video) throw new Error('ビデオ要素が見つかりません')

    statusText.value = 'カメラ起動中...'
    mediaStream.value = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    })
    video.removeAttribute('src')
    video.srcObject = mediaStream.value
    await video.play()

    // Camera preview is live; now load detector in parallel so the viewport
    // isn't just a spinner.
    statusText.value = '検出器初期化中…'
    await ensureDetector()

    // Keep existing captured list (camera is "add more"), just reset counters.
    if (!retaking) resetPipelineState()
    startLive(mediaStream.value.getVideoTracks()[0])
    retakeTarget.value = retaking ? retakeOf : null
    phase.value = 'scanning'
    statusText.value = ''

    const t0 = performance.now()
    let lastSampleT = t0 - 10000
    const loop = async () => {
      if (phase.value !== 'scanning' || !mediaStream.value) return
      const now = performance.now()
      if (now - lastSampleT >= SAMPLE_INTERVAL_S * 1000) {
        lastSampleT = now
        await processFrame(video, { t: (now - t0) / 1000, collect: !retaking })
        probe({ type: 'frameDone', ms: Math.round(performance.now() - now) })
      }
      video.requestVideoFrameCallback(loop)
    }
    video.requestVideoFrameCallback(loop)
  } catch (err) {
    retakeTarget.value = null
    phase.value = 'error'
    errorText.value =
      err instanceof Error ? err.message : 'カメラ起動に失敗しました'
    statusText.value = ''
  }
}

function releaseCamera(): void {
  mediaStream.value?.getTracks().forEach((t) => t.stop())
  mediaStream.value = null
  const video = videoRef.value
  if (video) video.srcObject = null
}

async function stopCamera(): Promise<void> {
  // Retake abandoned before a ✓: nothing changes.
  if (retakeTarget.value !== null) {
    retakeTarget.value = null
    releaseCamera()
    judge = null
    phase.value =
      captured.value.length > 0 || reportView.value.length > 0 ? 'done' : 'idle'
    return
  }
  releaseCamera()

  // Run Stage 2 selection on whatever the user captured this session.
  // Live camera path intentionally skips LLM — per-frame Gemma 4 would
  // make stop→done feel unresponsive (10+ s per cluster).
  phase.value = 'loading'
  await endLive()
  statusText.value = `選抜中… (候補 ${acceptedRecords.length})`
  await finalizeScan({ enableLlm: false })
  probe({
    type: 'pages',
    pages: captured.value.map((p) => ({
      id: p.id,
      livePageNo: p.livePageNo ?? null,
      clusterKey: p.clusterKey ?? null,
      width: p.width,
      height: p.height,
    })),
  })

  phase.value =
    captured.value.length > 0 || reportView.value.length > 0 ? 'done' : 'idle'
  statusText.value =
    captured.value.length > 0 ? `完了: ${captured.value.length} 枚` : ''
}

function retakeRow(rowId: string): void {
  if (!rowId.startsWith('m')) return
  void startCamera(Number(rowId.slice(1)))
}

/** First ✓ of a retake: it fills the missed row and the camera stops. */
async function finishRetake(missStartT: number, shot: LiveShot): Promise<void> {
  retakes.set(missStartT, shot)
  releaseCamera()
  judge = null
  captured.value = [
    ...preScanPages.value,
    ...(await buildPagesFromClusters(repairClusters.value)),
  ]
  phase.value = 'done'
  void saveSession(captured.value.map(pageToStored))
}

// ---------------------------------------------------------------------------
// Page list management
// ---------------------------------------------------------------------------

function removePage(id: string): void {
  // A page backed by a cluster must be removed through the cluster, or the
  // next repair would rebuild it from clusters that still contain it.
  const page = captured.value.find((p) => p.id === id)
  // Live / retaken pages are rebuilt from the report on every repair, so
  // their removal is remembered there, not just in the list.
  if (page?.livePageNo !== undefined) removedLive.add(page.livePageNo)
  if (page?.retakeOf !== undefined) retakes.delete(page.retakeOf)
  if (page?.clusterKey !== undefined) {
    void repairRemove(page.clusterKey)
    return
  }
  if (page?.livePageNo !== undefined || page?.retakeOf !== undefined) {
    void applyRepair(repairClusters.value)
    return
  }
  captured.value = captured.value.filter((p) => p.id !== id)
  void saveSession(captured.value.map(pageToStored))
}

function movePageUp(idx: number): void {
  if (idx <= 0) return
  const pages = [...captured.value]
  const tmp = pages[idx - 1]!
  pages[idx - 1] = pages[idx]!
  pages[idx] = tmp
  captured.value = pages
  void saveSession(captured.value.map(pageToStored))
}

function movePageDown(idx: number): void {
  if (idx >= captured.value.length - 1) return
  const pages = [...captured.value]
  const tmp = pages[idx + 1]!
  pages[idx + 1] = pages[idx]!
  pages[idx] = tmp
  captured.value = pages
  void saveSession(captured.value.map(pageToStored))
}

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

async function exportPdf(): Promise<void> {
  if (captured.value.length === 0 || pdfExporting.value) return
  pdfExporting.value = true
  try {
    const pdf = new jsPDF({
      unit: 'mm',
      format: 'a4',
      orientation: 'portrait',
    })
    const mmW = pdf.internal.pageSize.getWidth()
    const mmH = pdf.internal.pageSize.getHeight()

    captured.value.forEach((page, i) => {
      if (i > 0) pdf.addPage()
      const imgAspect = page.width / page.height
      const pageAspect = mmW / mmH
      let w: number
      let h: number
      if (imgAspect > pageAspect) {
        w = mmW
        h = mmW / imgAspect
      } else {
        h = mmH
        w = mmH * imgAspect
      }
      const x = (mmW - w) / 2
      const y = (mmH - h) / 2
      pdf.addImage(page.dataUrl, 'JPEG', x, y, w, h)
    })

    pdf.save(`astarscan-${Date.now()}.pdf`)
  } finally {
    pdfExporting.value = false
  }
}

/**
 * Build the debug payload (captured pages + meta + LLM judgments).
 * `withImages=false` strips base64 thumbnails — the resulting file is
 * 30-50× smaller and still has everything needed to diagnose LLM
 * behaviour.
 */
function buildDebugPayload(withImages: boolean): unknown {
  return {
    meta: {
      exportedAt: new Date().toISOString(),
      detectorSource: getDetectorSource(),
      sampledFrames,
      detectedFrames,
      llmAvailable: llmAvailable.value,
      useLlm: useLlm.value,
      pageCount: captured.value.length,
      userAgent: navigator.userAgent,
    },
    pages: captured.value.map((p, idx) => ({
      index: idx,
      id: p.id,
      width: p.width,
      height: p.height,
      aspect: (p.width / p.height).toFixed(3),
      capturedAt: p.capturedAt,
      capturedAtIso: new Date(
        p.capturedAt + performance.timeOrigin,
      ).toISOString(),
      llmDebug: p.llmDebug,
      ...(withImages ? { dataUrl: p.dataUrl } : {}),
    })),
  }
}

/**
 * POST the payload to the dev server (`/api/debug-export`). Returns
 * the server's reply on success, null on any failure (caller decides
 * fallback). Silent — caller logs.
 */
async function postDebugJson(
  withImages: boolean,
): Promise<{ latestPath?: string; bytes?: number } | null> {
  if (captured.value.length === 0) return null
  const json = JSON.stringify(buildDebugPayload(withImages), null, 2)
  try {
    const res = await fetch('/api/debug-export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json,
    })
    if (!res.ok) {
      console.warn('[postDebugJson] server returned', res.status)
      return null
    }
    return await res.json()
  } catch (err) {
    console.warn('[postDebugJson] post failed:', err)
    return null
  }
}

/**
 * Manual trigger from the footer button. Prompts whether to include
 * base64 images; tries server save first, falls back to a download.
 */
async function exportDebugJson(): Promise<void> {
  if (captured.value.length === 0) return
  const withImages = window.confirm(
    '画像 (base64) も含めますか?\n\nOK: 画像込み (数十 MB 級)\nキャンセル: メタ + LLM 判定のみ (推奨、数百 KB)',
  )
  const result = await postDebugJson(withImages)
  if (result) {
    statusText.value = `サーバ保存: ${result.latestPath} (${result.bytes} bytes)`
    console.log('[exportDebugJson] saved on server:', result)
    return
  }
  // Fallback: download as a file (production static build path).
  const blob = new Blob(
    [JSON.stringify(buildDebugPayload(withImages), null, 2)],
    {
      type: 'application/json',
    },
  )
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `astarscan-debug-${Date.now()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function clearAll(): Promise<void> {
  captured.value = []
  resetPipelineState()
  await clearSession()
  phase.value = 'idle'
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function pageToStored(p: Page): StoredPage {
  return {
    id: p.id,
    dataUrl: p.dataUrl,
    width: p.width,
    height: p.height,
    sharpness: 0,
    capturedAt: p.capturedAt,
  }
}

function storedToPage(s: StoredPage): Page {
  return {
    id: s.id,
    dataUrl: s.dataUrl,
    width: s.width,
    height: s.height,
    capturedAt: s.capturedAt,
  }
}

const canExport = computed(
  () => captured.value.length > 0 && !pdfExporting.value,
)

/** Map other-page id → captured-list 1-based index, for the pair debug
 *  display. Cheap O(N) lookup; the captured list is small (<= 50). */
function pageIndexById(id: string): number {
  return captured.value.findIndex((p) => p.id === id) + 1
}
</script>

<template>
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">AstarScan</h1>
      <span v-if="statusText" class="app__status">{{ statusText }}</span>
      <label
        class="app__toggle"
        :title="
          llmAvailable
            ? 'Gemma 4 で文書品質 / 重複判定を行う (WebGPU)'
            : 'WebGPU 非対応 — LLM 機能を使えません'
        "
      >
        <input
          v-model="useLlm"
          type="checkbox"
          :disabled="
            !llmAvailable || phase === 'scanning' || phase === 'loading'
          "
        />
        LLM 判定{{ llmAvailable ? '' : ' (非対応)' }}
      </label>
    </header>

    <div v-if="llmProgress" class="llm-progress">
      <span class="llm-progress__label">{{ llmProgress.phase }}</span>
      <progress
        class="llm-progress__bar"
        :max="Math.max(1, llmProgress.total)"
        :value="llmProgress.done"
      />
      <span class="llm-progress__count"
        >{{ llmProgress.done }} / {{ llmProgress.total }}</span
      >
    </div>

    <section class="viewport">
      <video
        ref="videoRef"
        class="viewport__video"
        :class="{
          'viewport__video--hidden': phase === 'idle' || !!selectedPage,
        }"
        playsinline
        muted
      />
      <canvas
        ref="overlayRef"
        class="viewport__overlay"
        :class="{
          'viewport__overlay--hidden': phase === 'idle' || !!selectedPage,
        }"
      />

      <!-- thumb クリック時はメイン viewport を preview に占有 -->
      <div v-if="selectedPage" class="viewport__preview">
        <img
          :src="selectedPage.dataUrl"
          alt="page preview"
          class="viewport__preview-img"
        />
        <button
          type="button"
          class="viewport__preview-close"
          aria-label="閉じる"
          @click="closePageDetail"
        >
          ×
        </button>
        <small class="viewport__preview-meta">
          {{ selectedPage.width }}×{{ selectedPage.height }}px ·
          {{ new Date(selectedPage.capturedAt).toLocaleString() }}
        </small>
        <details v-if="selectedPage.llmDebug" class="viewport__preview-debug">
          <summary class="viewport__preview-debug-summary">
            LLM 判定
            <span v-if="selectedPage.llmDebug.validator">
              · 品質 {{ selectedPage.llmDebug.validator.quality }}/5
            </span>
            <span v-if="selectedPage.llmDebug.bestFramePick">
              ·
              {{ selectedPage.llmDebug.bestFramePick.candidateCount }}
              候補から選定
            </span>
            <span v-if="selectedPage.llmDebug.pairResults?.length">
              · ペア比較 {{ selectedPage.llmDebug.pairResults.length }} 件
            </span>
          </summary>
          <div class="viewport__preview-debug-body">
            <section v-if="selectedPage.llmDebug.validator" class="dbg-section">
              <h4>Frame validator</h4>
              <p class="dbg-reason">
                {{
                  selectedPage.llmDebug.validator.reasoning || '(理由出力なし)'
                }}
              </p>
              <small class="dbg-meta">
                quality {{ selectedPage.llmDebug.validator.quality }}/5 ·
                {{ selectedPage.llmDebug.validator.duration_ms.toFixed(0) }} ms
                ·
                {{ selectedPage.llmDebug.validator.prompt_version }}
              </small>
              <pre class="dbg-raw">
raw: {{ selectedPage.llmDebug.validator.raw }}</pre
              >
            </section>
            <section
              v-if="selectedPage.llmDebug.bestFramePick"
              class="dbg-section"
            >
              <h4>Best-frame pick</h4>
              <p class="dbg-reason">
                {{
                  selectedPage.llmDebug.bestFramePick.reasoning ||
                  '(理由出力なし)'
                }}
              </p>
              <small class="dbg-meta">
                picked index
                {{ selectedPage.llmDebug.bestFramePick.pickedIndex }} /
                {{ selectedPage.llmDebug.bestFramePick.candidateCount }} ·
                {{ selectedPage.llmDebug.bestFramePick.duration_ms.toFixed(0) }}
                ms ·
                {{ selectedPage.llmDebug.bestFramePick.prompt_version }}
              </small>
              <pre
                v-if="selectedPage.llmDebug.bestFramePick.raw"
                class="dbg-raw"
              >
raw: {{ selectedPage.llmDebug.bestFramePick.raw }}</pre
              >
            </section>
            <section
              v-if="selectedPage.llmDebug.pairResults?.length"
              class="dbg-section"
            >
              <h4>Pair comparison</h4>
              <ul class="dbg-pairs">
                <li
                  v-for="(r, ri) in selectedPage.llmDebug.pairResults"
                  :key="ri"
                >
                  <strong :class="r.same ? 'dbg-same' : 'dbg-diff'">
                    {{ r.same ? 'SAME' : 'DIFF' }}
                  </strong>
                  vs ページ {{ pageIndexById(r.otherPageId) || '?' }} (conf
                  {{ r.confidence.toFixed(1) }}) — {{ r.reasoning }}
                </li>
              </ul>
            </section>
          </div>
        </details>
      </div>

      <div v-if="phase === 'idle' && !selectedPage" class="splash">
        <h2 class="splash__title">書類の山をスマホで電子化</h2>
        <p class="splash__tagline">
          動画ファイルから自動で書類ページを抽出し、<br />
          PDF にまとめます。
        </p>
        <p class="splash__privacy">
          全ての処理は端末内で完結します。画像や PDF は外部に送信されません。
          <NuxtLink to="/privacy" class="splash__link">
            プライバシーポリシー
          </NuxtLink>
        </p>
      </div>

      <div v-else-if="phase === 'error'" class="splash splash--error">
        <p class="splash__error">{{ errorText }}</p>
      </div>

      <ol v-if="phase === 'scanning' && liveStrip.length" class="live-strip">
        <li
          v-for="chip in liveStrip"
          :key="chip.id"
          :class="`live-strip__chip live-strip__chip--${chip.kind}`"
        >
          <img v-if="chip.thumb" :src="chip.thumb" alt="" />
          <span class="live-strip__mark">{{
            chip.kind === 'captured' ? '✓' : '!'
          }}</span>
        </li>
      </ol>
    </section>

    <CaptureReport
      v-if="phase === 'done' && reportView.length > 0"
      :rows="reportView"
      :retake-busy="retakeTarget !== null"
      @retake="retakeRow"
      @remove="removePage"
    />

    <details
      v-if="captured.length > 0"
      class="strip-drawer"
      :open="stripOpen"
      @toggle="stripOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary class="strip-drawer__summary">
        書類 {{ captured.length }} 件
        <span class="strip-drawer__hint">
          {{ stripOpen ? '（クリックで閉じる）' : '（クリックで開く）' }}
        </span>
      </summary>
      <div class="strip">
        <figure
          v-for="(page, idx) in captured"
          :key="page.id"
          class="strip__thumb"
          role="button"
          tabindex="0"
          aria-label="詳細を見る"
          @click="openPageDetail(page)"
          @keydown.enter.prevent="openPageDetail(page)"
          @keydown.space.prevent="openPageDetail(page)"
        >
          <img :src="page.dataUrl" :alt="`ページ ${idx + 1}`" />
          <figcaption class="strip__caption">{{ idx + 1 }}</figcaption>
          <div class="strip__actions" @click.stop>
            <button
              type="button"
              aria-label="前のページと入れ替え"
              :disabled="idx === 0"
              @click.stop="movePageUp(idx)"
            >
              ◀
            </button>
            <button
              type="button"
              aria-label="次のページと入れ替え"
              :disabled="idx === captured.length - 1"
              @click.stop="movePageDown(idx)"
            >
              ▶
            </button>
            <button
              type="button"
              aria-label="削除"
              @click.stop="removePage(page.id)"
            >
              ×
            </button>
          </div>
        </figure>
      </div>

      <ReviewRepair
        v-if="repairClusters.length > 0"
        class="strip-repair"
        :pages="captured"
        :selected="mergeSelection"
        :detail-key="detailKey"
        :members="detailMembers"
        :members-loading="membersLoading"
        :buffer-truncated="bufferTruncated"
        @toggle="toggleMergeSelection"
        @merge="repairMerge"
        @remove="repairRemove"
        @open-members="openMembers"
        @close-members="closeMembers"
        @set-winner="repairSetWinner"
        @split="repairSplit"
        @edit-quad="openQuadEdit"
      />

      <QuadEditor
        v-if="quadEditFrame"
        class="strip-repair"
        :src="quadEditUrl"
        :src-w="quadEditFrame.srcW"
        :src-h="quadEditFrame.srcH"
        :quad="quadEditFrame.quad"
        @save="saveQuadEdit"
        @cancel="closeQuadEdit"
      />
    </details>

    <footer class="controls">
      <template v-if="phase === 'idle' || phase === 'error'">
        <button class="btn btn--primary" type="button" @click="startCamera()">
          カメラで撮影
        </button>
        <button class="btn btn--secondary" type="button" @click="startFromFile">
          動画ファイルから
        </button>
        <button
          v-if="captured.length > 0"
          class="btn btn--primary"
          type="button"
          :disabled="!canExport"
          @click="exportPdf"
        >
          {{ pdfExporting ? 'PDF 生成中…' : `PDF 出力 (${captured.length})` }}
        </button>
      </template>

      <template v-else-if="phase === 'scanning'">
        <button class="btn btn--secondary" type="button" @click="stopCamera">
          {{
            mediaStream
              ? retakeTarget !== null
                ? 'やめる'
                : '停止'
              : '処理中…'
          }}
        </button>
      </template>

      <template v-else-if="phase === 'done'">
        <button
          class="btn btn--primary"
          type="button"
          :disabled="!canExport"
          @click="exportPdf"
        >
          {{ pdfExporting ? 'PDF 生成中…' : `PDF 出力 (${captured.length})` }}
        </button>
        <button class="btn btn--secondary" type="button" @click="startCamera()">
          追加撮影
        </button>
        <button class="btn btn--secondary" type="button" @click="startFromFile">
          動画から追加
        </button>
        <button
          class="btn btn--ghost"
          type="button"
          :disabled="captured.length === 0"
          title="LLM 判定・メタを JSON でダウンロード"
          @click="exportDebugJson"
        >
          デバッグ JSON
        </button>
        <button class="btn btn--ghost" type="button" @click="clearAll">
          すべて削除
        </button>
      </template>

      <template v-else>
        <span class="controls__loading">読み込み中…</span>
      </template>
    </footer>
  </main>
</template>

<style scoped>
.live-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  gap: 6px;
  margin: 0;
  padding: 8px 12px;
  list-style: none;
  overflow-x: auto;
  background: linear-gradient(
    to top,
    rgba(15, 23, 42, 0.8),
    rgba(15, 23, 42, 0)
  );
  z-index: 3;
}
.live-strip__chip {
  position: relative;
  flex: 0 0 auto;
  width: 40px;
  height: 52px;
  border-radius: 6px;
  border: 3px solid;
  overflow: hidden;
  background: rgba(148, 163, 184, 0.4);
}
.live-strip__chip--captured {
  border-color: #22c55e;
}
.live-strip__chip--missed {
  border-color: #ef4444;
}
.live-strip__chip img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.live-strip__mark {
  position: absolute;
  right: 1px;
  bottom: 0;
  font-weight: 800;
  font-size: 14px;
  line-height: 1;
  color: #fff;
  text-shadow: 0 0 3px #000;
}
.live-strip__chip--missed .live-strip__mark {
  color: #fecaca;
}
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 100dvh;
  background: #0b1120;
  color: #f1f5f9;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}

.app__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: #001f42;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  gap: 1rem;
}

.app__title {
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.app__status {
  font-size: 0.8125rem;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.app__toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.75rem;
  color: #cbd5e1;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.app__toggle input[type='checkbox'] {
  accent-color: #0284c7;
  cursor: pointer;
}
.app__toggle input[type='checkbox']:disabled {
  cursor: not-allowed;
}

.llm-progress {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 1rem;
  background: rgba(2, 132, 199, 0.15);
  border-bottom: 1px solid rgba(2, 132, 199, 0.3);
  font-size: 0.75rem;
  color: #bae6fd;
}
.llm-progress__label {
  flex: 0 0 auto;
}
.llm-progress__bar {
  flex: 1;
  height: 0.5rem;
}
.llm-progress__count {
  flex: 0 0 auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #000;
}

.viewport__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  z-index: 1;
}

.viewport__video--hidden {
  visibility: hidden;
}

.viewport__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
}

.viewport__overlay--hidden {
  visibility: hidden;
}

.splash {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  gap: 1rem;
  background: #0b1120;
  z-index: 2;
  text-align: center;
}

.splash__title {
  font-size: 1.5rem;
  font-weight: 600;
}

.splash__tagline {
  font-size: 0.875rem;
  color: #cbd5e1;
  line-height: 1.6;
}

.splash__privacy {
  font-size: 0.75rem;
  color: #94a3b8;
  max-width: 24rem;
  line-height: 1.6;
}

.splash__link {
  color: #7dd3fc;
  text-decoration: underline;
}

.splash--error {
  background: rgba(185, 28, 28, 0.85);
}

.splash__error {
  font-size: 1rem;
  white-space: pre-line;
  max-width: 28rem;
}

.strip__thumb {
  cursor: pointer;
}
.strip__thumb:focus-visible {
  outline: 2px solid #001f42;
  outline-offset: 2px;
}
.strip__thumb:hover {
  transform: translateY(-2px);
  transition: transform 0.1s ease;
}

/* viewport 内に詳細 preview を overlay (専用 dialog ではなく既存 main 領域を再利用) */
.viewport__preview {
  position: absolute;
  inset: 0;
  background: #0b1120;
  display: flex;
  align-items: center;
  justify-content: center;
}
.viewport__preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.viewport__preview-close {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  border: 1px solid rgba(255, 255, 255, 0.3);
  font-size: 1.4rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.viewport__preview-close:hover {
  background: rgba(0, 0, 0, 0.9);
}
.viewport__preview-meta {
  position: absolute;
  bottom: 0.75rem;
  left: 0.75rem;
  background: rgba(0, 0, 0, 0.7);
  color: white;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 0.75rem;
}

.viewport__preview-debug {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  max-width: min(28rem, calc(100% - 5rem));
  max-height: calc(100% - 4rem);
  overflow-y: auto;
  background: rgba(2, 6, 23, 0.92);
  color: #e2e8f0;
  border: 1px solid rgba(125, 211, 252, 0.35);
  border-radius: 0.5rem;
  font-size: 0.75rem;
  line-height: 1.4;
}
.viewport__preview-debug-summary {
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  list-style: none;
  font-weight: 600;
  color: #7dd3fc;
}
.viewport__preview-debug-summary::-webkit-details-marker {
  display: none;
}
.viewport__preview-debug-body {
  padding: 0 0.75rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.dbg-section h4 {
  font-size: 0.75rem;
  margin: 0 0 0.25rem;
  color: #fbbf24;
}
.dbg-reason {
  margin: 0 0 0.25rem;
  white-space: pre-wrap;
}
.dbg-meta {
  display: block;
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  margin-bottom: 0.25rem;
}
.dbg-raw {
  margin: 0;
  padding: 0.375rem 0.5rem;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 0.25rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6875rem;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 8rem;
  overflow-y: auto;
}
.dbg-pairs {
  margin: 0;
  padding-left: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.dbg-same {
  color: #4ade80;
}
.dbg-diff {
  color: #f87171;
}

.strip-drawer {
  background: #101a2d;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.strip-drawer__summary {
  padding: 0.625rem 1rem;
  font-size: 0.8125rem;
  cursor: pointer;
  list-style: none;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.strip-drawer__summary::-webkit-details-marker {
  display: none;
}

.strip-drawer__hint {
  color: #64748b;
  font-size: 0.75rem;
}

.strip {
  display: flex;
  gap: 0.5rem;
  padding: 0 0.75rem 0.75rem;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}

.strip-repair {
  padding: 0.75rem;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.strip__thumb {
  position: relative;
  flex: 0 0 auto;
  max-width: 6rem;
  max-height: 4.5rem;
  background: #0b1120;
  border-radius: 0.5rem;
  overflow: hidden;
}

.strip__thumb img {
  display: block;
  max-width: 6rem;
  max-height: 4.5rem;
  width: auto;
  height: auto;
  object-fit: contain;
}

.strip__caption {
  position: absolute;
  top: 0.25rem;
  left: 0.25rem;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 0 0.375rem;
  font-size: 0.625rem;
  border-radius: 0.25rem;
}

.strip__actions {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  gap: 1px;
  background: rgba(0, 0, 0, 0.6);
}

.strip__actions button {
  flex: 1;
  padding: 0.125rem 0;
  background: transparent;
  border: none;
  color: #fff;
  font-size: 0.75rem;
  cursor: pointer;
}

.strip__actions button:disabled {
  color: #475569;
  cursor: not-allowed;
}

.controls {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: #001f42;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  flex-wrap: wrap;
}

.btn {
  flex: 1 1 auto;
  min-width: 6rem;
  padding: 0.625rem 1rem;
  border-radius: 0.5rem;
  border: 1px solid transparent;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn--primary {
  background: #0284c7;
  color: #fff;
}

.btn--secondary {
  background: transparent;
  color: #e2e8f0;
  border-color: #334155;
}

.btn--ghost {
  background: transparent;
  color: #94a3b8;
  border-color: transparent;
  flex: 0 0 auto;
}

.controls__loading {
  color: #94a3b8;
  font-size: 0.875rem;
  align-self: center;
}

@media (min-width: 768px) {
  .strip__thumb {
    flex: 0 0 6rem;
  }
}
</style>
