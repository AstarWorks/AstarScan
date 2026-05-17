<script setup lang="ts">
/**
 * AstarScan — two-stage document scanner.
 *
 * Stage 1 (during scan):
 *   - Sample every SAMPLE_INTERVAL_S of video/camera
 *   - `detectDocument` returns `{quad, confidence}` using DocAligner ONNX
 *     (primary) or OpenCV Otsu+minAreaRect (fallback on load failure).
 *   - Warp, compute pHash + sharpness + quad-area-fraction + score
 *   - Push into `FrameCollector`. No dedup, no commit.
 *
 * Stage 2 (on video end / stop):
 *   - `collector.selectBest(CLUSTER_THRESHOLD)` runs Union-Find on the
 *     frame list using pHash Hamming distance — each component is one
 *     physical page. One frame per component wins by composite score.
 *   - Winners become `captured[]` pages.
 *
 * The previous streaming "pending + commit on page change" approach kept
 * picking the first-seen frame of each page (often blurry) and split one
 * physical page into multiple captures when handheld motion pushed pHash
 * past the same-page threshold between adjacent frames. Batch selection
 * sees the whole history at once and fixes both.
 */

import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import jsPDF from 'jspdf'
import type { Quad } from '@astarworks/scan-core'

import { detectDocument, ensureDocDetector, getDetectorSource } from '~/services/doc-detector'
import { warpPerspective } from '~/services/perspective-warper'
import { computePHash, computeTilePHash } from '~/services/phash-dedup'
import { FrameCollector, type DetectedFrame } from '~/services/frame-collector'
import { mergeClustersByOrb } from '~/services/orb-merge'
import {
  clearSession,
  loadSession,
  saveSession,
  type StoredPage,
} from '~/services/session-store'

interface Page {
  id: string
  dataUrl: string
  width: number
  height: number
  capturedAt: number
}

const EXTRACT_W = 1200
const EXTRACT_H = 1600
/** Dense sampling — a handheld page turn only gives 2-4 genuinely sharp
 *  frames per page (the moments when the hand pauses). Sampling at 0.5 s
 *  routinely missed them; 0.1 s (10 FPS) puts ~5× more candidates per
 *  page into the collector, so there's almost always a sharp one per
 *  cluster. OpenCV detection is ~5 ms so we stay well within budget. */
const SAMPLE_INTERVAL_S = 0.1
/** Tile-pHash 80th-percentile distance cutoff for first-pass centroid
 *  clustering. Same physical page (handheld angle changes): 5-25;
 *  different pages: 28+. We sit at 27 to be recall-oriented — over-
 *  splitting is fine because `mergeClustersByOrb` collapses same-page
 *  clusters in the second pass via ORB+RANSAC inlier matching.
 *
 *  See docs/eval-results.md for the empirical sweep that picked this. */
const CLUSTER_THRESHOLD = 27
/** ORB inlier threshold for the post-hoc cluster merger. Two clusters
 *  merge if their winners share at least this many RANSAC-validated
 *  ORB inlier matches (top-60 % crop, descriptor distance < 35). 25 is
 *  the empirical sweet spot for the eval mp4s; raising it costs
 *  recall, lowering it merges visually different pages with shared
 *  boilerplate. */
const ORB_MERGE_INLIERS = 25
/** Minimum detector confidence to accept a frame into the collector.
 *  OpenCV always returns 1.0, so this is currently a no-op. Kept so the
 *  slot exists for when the ML detector is re-enabled. */
const MIN_CONFIDENCE = 0.1
/** Pre-cluster blur floor. Empirically the handheld MP4s peak around
 *  ten=60-80 on the sharpest frames (the whole video is moderately
 *  blurry); a gate at 30 keeps the worst transitions out without
 *  nuking entire page clusters. Set to 0 to disable. */
const MIN_TENENGRAD = 30

type Phase = 'idle' | 'loading' | 'scanning' | 'done' | 'error'
const phase = ref<Phase>('idle')
const statusText = ref('')
const errorText = ref('')
const captured = ref<Page[]>([])
const pdfExporting = ref(false)
const stripOpen = ref(false)

const videoRef = ref<HTMLVideoElement | null>(null)
const overlayRef = ref<HTMLCanvasElement | null>(null)
const mediaStream = ref<MediaStream | null>(null)

const route = useRoute()
const debugMode = computed(() => route.query.debug === '1')

let detectorReady = false
const collector = new FrameCollector()
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
 * Minimal typed surface of the OpenCV.js Laplacian / Sobel / mean API
 * used by the sharpness helpers. Shadow-interface pattern per
 * perspective-warper.ts — we avoid bloating globals.d.ts with the full
 * cv namespace.
 */
interface CvSharpnessApi {
  imread(canvas: HTMLCanvasElement): CvMat
  cvtColor(src: CvMat, dst: CvMat, code: number): void
  Laplacian(
    src: CvMat,
    dst: CvMat,
    ddepth: number,
    ksize: number,
    scale: number,
    delta: number,
    borderType: number,
  ): void
  Sobel(
    src: CvMat,
    dst: CvMat,
    ddepth: number,
    dx: number,
    dy: number,
    ksize: number,
    scale: number,
    delta: number,
    borderType: number,
  ): void
  multiply(src1: CvMat, src2: CvMat, dst: CvMat): void
  add(src1: CvMat, src2: CvMat, dst: CvMat): void
  mean(src: CvMat): CvScalar
  meanStdDev(src: CvMat, mean: CvMat, stddev: CvMat): void
  Mat: new () => CvMat
  readonly COLOR_RGBA2GRAY: number
  readonly CV_64F: number
  readonly CV_32F: number
  readonly BORDER_DEFAULT: number
}
interface CvMat {
  delete(): void
  readonly data64F: Float64Array
}
interface CvScalar {
  readonly [index: number]: number
}

/**
 * Laplacian variance on a grayscale version of `canvas`. Higher = sharper.
 * Typical values on warped 1200×1600 document frames: ~50 for blurry
 * handheld, ~800–3000 for well-focused text. Good at defocus, weaker at
 * motion blur — that's what `computeTenengrad` complements below.
 */
function computeLaplacian(canvas: HTMLCanvasElement): number {
  const cv = (window as unknown as { cv?: CvSharpnessApi }).cv
  if (!cv?.Laplacian) return 0
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const lap = new cv.Mat()
  const mean = new cv.Mat()
  const stddev = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.Laplacian(gray, lap, cv.CV_64F, 1, 1, 0, cv.BORDER_DEFAULT)
    cv.meanStdDev(lap, mean, stddev)
    const sd = stddev.data64F[0] ?? 0
    return sd * sd
  } finally {
    src.delete()
    gray.delete()
    lap.delete()
    mean.delete()
    stddev.delete()
  }
}

/**
 * Tenengrad focus measure — sqrt of mean squared Sobel gradient magnitude.
 * Unlike Laplacian variance this is direct edge strength, which collapses
 * hard on motion blur (blurred edges produce smaller Sobel responses).
 * Used alongside Laplacian so the score penalizes defocus AND handheld
 * motion. Typical values: ~20-60 on motion blur, ~150-500 on a still.
 */
function computeTenengrad(canvas: HTMLCanvasElement): number {
  const cv = (window as unknown as { cv?: CvSharpnessApi }).cv
  if (!cv?.Sobel || !cv?.multiply || !cv?.add) return 0
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const gx = new cv.Mat()
  const gy = new cv.Mat()
  const gx2 = new cv.Mat()
  const gy2 = new cv.Mat()
  const mag = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT)
    cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT)
    cv.multiply(gx, gx, gx2)
    cv.multiply(gy, gy, gy2)
    cv.add(gx2, gy2, mag)
    const m = cv.mean(mag)
    return Math.sqrt(m[0] ?? 0)
  } finally {
    src.delete()
    gray.delete()
    gx.delete()
    gy.delete()
    gx2.delete()
    gy2.delete()
    mag.delete()
  }
}

/** Shoelace area of an ordered 4-vertex quad. */
function quadArea(q: Quad): number {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x]
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y]
  let s = 0
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4
    s += (xs[i] ?? 0) * (ys[j] ?? 0) - (xs[j] ?? 0) * (ys[i] ?? 0)
  }
  return Math.abs(s) / 2
}

/**
 * Composite score used both for overlay display and as the per-cluster
 * ranking key inside FrameCollector. Weights:
 *   Laplacian  0.30 (defocus) — normalized by /2000, saturated at 1.0
 *   Tenengrad  0.30 (motion blur) — normalized by /400, saturated at 1.0
 *   area       0.20 (quad size / source frame)
 *   confidence 0.20 (detector's self-rated quality)
 *
 * With OpenCV primary, confidence is a constant 1.0, so the real work is
 * done by the two sharpness metrics and area. Having both blur metrics
 * matters because they fail in different regimes — Laplacian misses
 * handheld motion, Tenengrad misses global defocus.
 */
function combinedScore(
  laplacian: number,
  tenengrad: number,
  confidence: number,
  areaFrac: number,
): number {
  const normLap = Math.min(1, laplacian / 2000)
  const normTen = Math.min(1, tenengrad / 400)
  return 0.3 * normLap + 0.3 * normTen + 0.2 * areaFrac + 0.2 * confidence
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
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * Commit the winners to the persisted `captured[]`. Two-stage selection:
 *   1. `selectBestByTile` does centroid clustering on the 4×4 tile-pHash
 *      at threshold 27 — recall-oriented (intentionally over-splits;
 *      same-physical-page captures often drift to tile-distance 28-35).
 *   2. `mergeClustersByOrb` collapses over-split pairs whose winners
 *      share ≥25 RANSAC-validated ORB inlier matches. Same physical
 *      page is a planar surface so legitimate matches lie on a single
 *      transform; spurious matches (random feature collisions, shared
 *      boilerplate) are filtered by RANSAC.
 *
 * Falls back to the pre-merge tile clusters if OpenCV.js doesn't expose
 * the ORB API (graceful degradation — see `isOrbAvailable`).
 */
async function finalizeScan(): Promise<void> {
  const tileClusters = collector.selectBestByTile(CLUSTER_THRESHOLD)
  const merged = await mergeClustersByOrb(
    tileClusters,
    async (winner) => blobToCanvas(winner.warpedBlob, winner.warpedWidth, winner.warpedHeight),
    ORB_MERGE_INLIERS,
  )
  const winners = merged.map((c) => c.winner)
  const existing = captured.value
  const fresh: Page[] = []
  for (const w of winners) {
    fresh.push({
      id: crypto.randomUUID(),
      dataUrl: await blobToDataUrl(w.warpedBlob),
      width: w.warpedWidth,
      height: w.warpedHeight,
      capturedAt: w.capturedAt,
    })
  }
  captured.value = [...existing, ...fresh]
  collector.clear()
  void saveSession(captured.value.map(pageToStored))
}

function blobToCanvas(blob: Blob, width: number, height: number): Promise<HTMLCanvasElement> {
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

async function processFrame(video: HTMLVideoElement): Promise<void> {
  if (!detectorReady) return
  if (video.readyState < 2 || video.videoWidth === 0) return

  sampledFrames += 1

  const work = document.createElement('canvas')
  work.width = video.videoWidth
  work.height = video.videoHeight
  work.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0)

  const detection = await detectDocument(work)
  if (!detection) {
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

  const warped = warpPerspective(work, detection.quad, EXTRACT_W, EXTRACT_H)
  const hash = computePHash(warped)
  const tileHash = computeTilePHash(warped)
  const lap = computeLaplacian(warped)
  const ten = computeTenengrad(warped)
  const areaFrac = quadArea(detection.quad) / (work.width * work.height)
  const score = combinedScore(lap, ten, detection.confidence, areaFrac)

  // Pre-cluster blur gate. The collector is supposed to hold candidates
  // a human would want; obviously-blurry frames would otherwise compete
  // for "best in cluster" and occasionally win if a page turn had no
  // sharp frames at all (better to drop the page than ship blur).
  if (ten < MIN_TENENGRAD) {
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

  try {
    const blob = await canvasToJpegBlob(warped, 0.75)
    const frame: DetectedFrame = {
      hash,
      tileHash,
      sharpness: lap,
      confidence: detection.confidence,
      areaFrac,
      score,
      warpedBlob: blob,
      warpedWidth: warped.width,
      warpedHeight: warped.height,
      capturedAt: performance.now(),
    }
    collector.add(frame)
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

function renderOverlay(): void {
  if (!debugMode.value) return
  const canvas = overlayRef.value
  const video = videoRef.value
  const info = lastOverlayInfo
  if (!canvas || !video || !info) return
  const rect = video.getBoundingClientRect()
  if (canvas.width !== rect.width || canvas.height !== rect.height) {
    canvas.width = Math.round(rect.width)
    canvas.height = Math.round(rect.height)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)

  // Map source coords → on-screen coords. Video uses object-fit: contain,
  // so compute letterboxed viewport the same way.
  const scale = Math.min(canvas.width / info.srcW, canvas.height / info.srcH)
  const dispW = info.srcW * scale
  const dispH = info.srcH * scale
  const offX = (canvas.width - dispW) / 2
  const offY = (canvas.height - dispH) / 2
  const toScreen = (p: { x: number; y: number }) => ({
    x: offX + p.x * scale,
    y: offY + p.y * scale,
  })

  if (info.quad) {
    ctx.strokeStyle = '#22c55e'
    ctx.lineWidth = 3
    ctx.beginPath()
    const pts = [info.quad.tl, info.quad.tr, info.quad.br, info.quad.bl]
    pts.forEach((p, i) => {
      const s = toScreen(p)
      if (i === 0) ctx.moveTo(s.x, s.y)
      else ctx.lineTo(s.x, s.y)
    })
    ctx.closePath()
    ctx.stroke()
  } else {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.9)'
    ctx.font = '16px system-ui, sans-serif'
    ctx.fillText('no quad', 12, 28)
  }

  ctx.fillStyle = 'rgba(15, 23, 42, 0.75)'
  ctx.fillRect(8, canvas.height - 96, 340, 88)
  ctx.fillStyle = '#e2e8f0'
  ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace'
  const lines = [
    `lap=${info.laplacian.toFixed(0)}  ten=${info.tenengrad.toFixed(0)}  area=${info.area.toFixed(2)}`,
    `conf=${info.confidence.toFixed(2)}  score=${info.score.toFixed(2)}`,
    `src=${info.source}  buf=${collector.size}`,
    `det=${detectedFrames}/${sampledFrames}  captured=${captured.value.length}`,
  ]
  lines.forEach((line, i) => {
    ctx.fillText(line, 16, canvas.height - 76 + i * 18)
  })
}

function resetPipelineState(): void {
  collector.clear()
  sampledFrames = 0
  detectedFrames = 0
  lastOverlayInfo = null
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
    statusText.value = '検出器初期化中…'
    const detectorP = ensureDetector()

    phase.value = 'scanning'
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
            duration > 0
              ? Math.round((video.currentTime / duration) * 100)
              : 0
          statusText.value = `解析中 ${pct}% (検出 ${detectedFrames}/${sampledFrames} / 候補 ${collector.size})`
          await processFrame(video)
        }
        if (!video.ended) video.requestVideoFrameCallback(step)
        else resolve()
      }
      video.requestVideoFrameCallback(step)
      video.onended = () => resolve()
    })

    statusText.value = `選抜中… (候補 ${collector.size})`
    await finalizeScan()

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

async function startCamera(): Promise<void> {
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
    video.srcObject = mediaStream.value
    await video.play()

    // Camera preview is live; now load detector in parallel so the viewport
    // isn't just a spinner.
    statusText.value = '検出器初期化中…'
    await ensureDetector()

    // Keep existing captured list (camera is "add more"), just reset counters.
    resetPipelineState()
    phase.value = 'scanning'
    statusText.value = '書類を映してください'

    let lastSampleT = performance.now() - 10000
    const loop = async () => {
      if (phase.value !== 'scanning') return
      const now = performance.now()
      if (now - lastSampleT >= SAMPLE_INTERVAL_S * 1000) {
        lastSampleT = now
        await processFrame(video)
        statusText.value = `検出 ${detectedFrames}/${sampledFrames} / 候補 ${collector.size}`
      }
      video.requestVideoFrameCallback(loop)
    }
    video.requestVideoFrameCallback(loop)
  } catch (err) {
    phase.value = 'error'
    errorText.value =
      err instanceof Error ? err.message : 'カメラ起動に失敗しました'
    statusText.value = ''
  }
}

async function stopCamera(): Promise<void> {
  mediaStream.value?.getTracks().forEach((t) => t.stop())
  mediaStream.value = null
  const video = videoRef.value
  if (video) video.srcObject = null

  // Run Stage 2 selection on whatever the user captured this session.
  phase.value = 'loading'
  statusText.value = `選抜中… (候補 ${collector.size})`
  await finalizeScan()

  phase.value = captured.value.length > 0 ? 'done' : 'idle'
  statusText.value = captured.value.length > 0
    ? `完了: ${captured.value.length} 枚`
    : ''
}

// ---------------------------------------------------------------------------
// Page list management
// ---------------------------------------------------------------------------

function removePage(id: string): void {
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
</script>

<template>
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">AstarScan</h1>
      <span v-if="statusText" class="app__status">{{ statusText }}</span>
    </header>

    <section class="viewport">
      <video
        ref="videoRef"
        class="viewport__video"
        :class="{ 'viewport__video--hidden': phase === 'idle' }"
        playsinline
        muted
      />
      <canvas
        v-if="debugMode"
        ref="overlayRef"
        class="viewport__overlay"
        :class="{ 'viewport__overlay--hidden': phase === 'idle' }"
      />

      <div v-if="phase === 'idle'" class="splash">
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
        <p class="splash__privacy" style="margin-top:1rem;font-weight:600">
          📹 動画から一括で名刺/書類を抽出する場合は
          <NuxtLink to="/batch" class="splash__link">/batch ページ</NuxtLink>
          へ
        </p>
      </div>

      <div v-else-if="phase === 'error'" class="splash splash--error">
        <p class="splash__error">{{ errorText }}</p>
      </div>
    </section>

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
        >
          <img :src="page.dataUrl" :alt="`ページ ${idx + 1}`" />
          <figcaption class="strip__caption">{{ idx + 1 }}</figcaption>
          <div class="strip__actions">
            <button
              type="button"
              aria-label="前のページと入れ替え"
              :disabled="idx === 0"
              @click="movePageUp(idx)"
            >
              ◀
            </button>
            <button
              type="button"
              aria-label="次のページと入れ替え"
              :disabled="idx === captured.length - 1"
              @click="movePageDown(idx)"
            >
              ▶
            </button>
            <button
              type="button"
              aria-label="削除"
              @click="removePage(page.id)"
            >
              ×
            </button>
          </div>
        </figure>
      </div>
    </details>

    <footer class="controls">
      <template v-if="phase === 'idle' || phase === 'error'">
        <button class="btn btn--primary" type="button" @click="startCamera">
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
          {{ mediaStream ? '停止' : '処理中…' }}
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
        <button class="btn btn--secondary" type="button" @click="startCamera">
          追加撮影
        </button>
        <button class="btn btn--secondary" type="button" @click="startFromFile">
          動画から追加
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
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 100dvh;
  background: #0b1120;
  color: #f1f5f9;
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    system-ui,
    sans-serif;
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
