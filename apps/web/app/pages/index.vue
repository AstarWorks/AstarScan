<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import jsPDF from 'jspdf'

import type { EdgeDetectorBackend, Quad } from '@astarworks/scan-core'
import { measureSharpness } from '~/services/blur-detection'
import { cannyDetectQuad } from '~/services/canny-detector'
import { deskewDocument } from '~/services/deskew'
import { DocAlignerBackend } from '~/services/docaligner-backend'
import { enhanceDocument } from '~/services/image-enhancer'
import { JscanifyBackend } from '~/services/jscanify-backend'
import { extractGrayscale, SsimDedupManager } from '~/services/ssim-dedup'
import { disposeOcr, initOcr, isOcrReady, runOcr } from '~/services/ocr-service'
import type { OcrLine, OcrResult } from '~/services/ocr-service'
import { disposeVisualDedup, runVisualDedup } from '~/services/visual-dedup'
import { classifyBatch, disposeClassifier } from '~/services/smolvlm-backend'
import { warpPerspective } from '~/services/perspective-warper'
import {
  clearSession,
  loadSession,
  saveSession,
} from '~/services/session-store'
import type { StoredPage } from '~/services/session-store'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

type Phase = 'idle' | 'loading' | 'ready' | 'error'

interface CapturedPage {
  readonly id: string
  readonly dataUrl: string
  readonly width: number
  readonly height: number
  readonly sharpness: number
  /** Full camera frame before perspective correction (for re-detection). */
  readonly sourceDataUrl?: string
  readonly sourceWidth?: number
  readonly sourceHeight?: number
  /** Name of the backend that detected this page ("docaligner" or "jscanify"). */
  readonly backendName?: string
  ocrText?: string
  ocrLines?: readonly OcrLine[]
}

interface CaptureNotification {
  readonly id: number
  readonly dataUrl: string
  readonly pageNumber: number
  readonly type: 'new' | 'replaced' | 'skipped'
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// Target resolution for the perspective-corrected output. A4-ish aspect.
const EXTRACT_WIDTH = 1200
const EXTRACT_HEIGHT = 1600

const NOTIFICATION_THUMB_QUALITY = 0.6
const NOTIFICATION_DURATION_MS = 2500

// Capture interval: 1s sampling. 0.5s causes too many candidates (50+)
// which overflows SigLIP's stack during embedding extraction.
// 1s at SSIM 0.70 = 11/11 on test video (verified).
const CAPTURE_INTERVAL_MS = 1000

// Overlay detection runs every N RAF frames (~15 FPS at 60 FPS display).
// This is for UX feedback only — capture decisions are made by the timer.
const OVERLAY_DETECT_EVERY_N = 4

// --------------------------------------------------------------------------
// Reactive state
// --------------------------------------------------------------------------

const videoRef = ref<HTMLVideoElement | null>(null)
const overlayRef = ref<HTMLCanvasElement | null>(null)
const phase = ref<Phase>('idle')
const statusText = ref<string>('')
const errorText = ref<string | null>(null)
const captured = ref<CapturedPage[]>([])
const notification = ref<CaptureNotification | null>(null)

// Visual dedup state
const dedupRunning = ref(false)
const dedupProgressText = ref('')

// Page preview state
const previewPageIndex = ref<number | null>(null)

// OCR state
const ocrLoading = ref(false)
const ocrProgress = ref<string>('')
const ocrPanelPage = ref<{
  pageIndex: number
  result: OcrResult | null
  loading: boolean
} | null>(null)

// --------------------------------------------------------------------------
// Non-reactive handles
// --------------------------------------------------------------------------

let edgeBackend: EdgeDetectorBackend | null = null
let fallbackBackend: EdgeDetectorBackend | null = null
const ssimDedup = new SsimDedupManager()
let stream: MediaStream | null = null
let visibilityCleanup: (() => void) | null = null
let rafId: number | null = null
let captureTimerId: ReturnType<typeof setInterval> | null = null
let overlayTick = 0
let lastQuad: Quad | null = null
let detectionInFlight = false
let processingFrame = false
let nextNotificationId = 0
let notificationTimeoutId: number | null = null

// --------------------------------------------------------------------------
// Camera lifecycle — iOS Safari survival kit (WebKit bug #185448)
//
// 1. Single MediaStream: only one getUserMedia call per session
// 2. visibilitychange handler: detect background→foreground transitions
// 3. track.onended listener: detect surprise camera loss
// 4. Error retry: NotReadableError / AbortError → retry once after 500ms
// 5. Safari version check: warn on iOS < 15
// --------------------------------------------------------------------------

function isIOSSafari(): boolean {
  const ua = navigator.userAgent
  return (
    /iPhone|iPad|iPod/.test(ua) && /WebKit/.test(ua) && !/CriOS|FxiOS/.test(ua)
  )
}

async function startCamera(): Promise<void> {
  // iOS Safari version check
  if (isIOSSafari()) {
    const match = navigator.userAgent.match(/OS (\d+)_/)
    const iosVersion = match ? parseInt(match[1] ?? '0', 10) : 0
    if (iosVersion > 0 && iosVersion < 15) {
      throw new Error(
        `iOS ${iosVersion} は対応していません。iOS 15 以上にアップデートしてください。`,
      )
    }
  }

  let mediaStream: MediaStream
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    })
  } catch (err) {
    // iOS Safari retry: NotReadableError / AbortError can be transient
    // in standalone (home screen) mode — retry once after 500ms.
    if (
      err instanceof DOMException &&
      (err.name === 'NotReadableError' || err.name === 'AbortError')
    ) {
      await new Promise((r) => setTimeout(r, 500))
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })
    } else {
      throw err
    }
  }

  stream = mediaStream

  const video = videoRef.value
  if (!video) {
    mediaStream.getTracks().forEach((t) => t.stop())
    stream = null
    throw new Error('ビデオ要素の取得に失敗しました')
  }

  video.srcObject = mediaStream
  await video.play()

  // Track ended listener: detect surprise camera loss (iOS Safari
  // standalone mode, tab switch, or another app grabbing the camera)
  const videoTrack = mediaStream.getVideoTracks()[0]
  if (videoTrack) {
    videoTrack.onended = () => {
      showTransientError(
        'カメラが切断されました。再度「スキャンを開始」をタップしてください。',
      )
      phase.value = 'error'
      errorText.value =
        'カメラが切断されました。再度「スキャンを開始」をタップしてください。'
    }
  }

  // Visibility change handler: if the page goes background and comes
  // back, the MediaStream may be dead on iOS Safari. Check and warn.
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && stream) {
      const tracks = stream.getVideoTracks()
      const allEnded =
        tracks.length === 0 || tracks.every((t) => t.readyState === 'ended')
      if (allEnded) {
        showTransientError(
          'バックグラウンドから復帰後、カメラが停止しました。再開してください。',
        )
        phase.value = 'error'
        errorText.value =
          'バックグラウンドから復帰後、カメラが停止しました。再開してください。'
      }
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  // Store cleanup ref so onBeforeUnmount can remove it
  visibilityCleanup = () =>
    document.removeEventListener('visibilitychange', onVisibilityChange)
}

// --------------------------------------------------------------------------
// Unified capture pipeline — shared by camera and video file modes.
// Same logic: edge detect → warp → blur check → SSIM dedup → accept.
// --------------------------------------------------------------------------

/**
 * Capture a single frame from the video, run edge detection + warp,
 * blur check, and SSIM dedup. Shared by camera and video file modes.
 */
async function processFrame(video: HTMLVideoElement): Promise<void> {
  if (processingFrame || video.readyState < 2 || video.videoWidth === 0) return
  processingFrame = true

  try {
    const work = document.createElement('canvas')
    work.width = video.videoWidth
    work.height = video.videoHeight
    const ctx = work.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)

    // 1. Edge detect — cascade: DocAligner → jscanify → Canny contour
    let quad: Quad | null = null
    let backendName = 'raw'

    // Try primary backend (DocAligner ML)
    if (edgeBackend) {
      try {
        quad = await edgeBackend.detect(work)
        if (quad) backendName = edgeBackend.name
      } catch {
        /* silent */
      }
    }

    // Try fallback backend (jscanify classical CV)
    if (!quad && fallbackBackend) {
      try {
        quad = await fallbackBackend.detect(work)
        if (quad) backendName = fallbackBackend.name
      } catch {
        /* silent */
      }
    }

    // Try Canny + contour detection (OpenCV.js direct)
    if (!quad) {
      quad = cannyDetectQuad(work)
      if (quad) backendName = 'canny'
    }

    // 2. Perspective warp + deskew (or raw frame for SSIM comparison)
    // NOTE: enhancement (auto-crop, CLAHE, A4) is applied AFTER dedup,
    // not here. SSIM must compare raw frames for consistent results.
    let output: HTMLCanvasElement
    if (quad) {
      output = warpPerspective(work, quad, EXTRACT_WIDTH, EXTRACT_HEIGHT)
      output = deskewDocument(output)
    } else {
      output = work
    }

    // 3. Sharpness for best-frame selection (no pre-dedup filtering —
    // all filters were found to kill valid pages. SigLIP handles non-doc removal.)
    const sharpness = measureSharpness(output)

    // 3. SSIM dedup — simple accept/reject (no best-frame replacement,
    // which was found to merge different pages at SSIM 0.70 threshold)
    const gray = extractGrayscale(output)
    if (ssimDedup.isDuplicate(gray)) return

    // 4. Accept new page
    const pageId = crypto.randomUUID()
    const dataUrl = output.toDataURL('image/jpeg', 0.85)
    ssimDedup.addPage(pageId, gray)
    captured.value = [
      ...captured.value,
      {
        id: pageId,
        dataUrl,
        width: output.width,
        height: output.height,
        sharpness,
        backendName,
      },
    ]
    showCaptureNotification(output, 'new')
    void persistSession()
  } finally {
    processingFrame = false
  }
}

function drawQuadOverlay(
  ctx: CanvasRenderingContext2D,
  quad: Quad,
  canvasWidth: number,
): void {
  ctx.fillStyle = 'rgba(0, 132, 255, 0.15)'
  ctx.strokeStyle = 'rgba(0, 132, 255, 0.8)'
  ctx.lineWidth = Math.max(3, Math.round(canvasWidth / 400))
  ctx.beginPath()
  ctx.moveTo(quad.tl.x, quad.tl.y)
  ctx.lineTo(quad.tr.x, quad.tr.y)
  ctx.lineTo(quad.br.x, quad.br.y)
  ctx.lineTo(quad.bl.x, quad.bl.y)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
}

/**
 * Overlay-only RAF loop for camera mode: draws detected quad on the
 * canvas for UX feedback. Capture decisions are NOT made here — they
 * happen in the 1s interval timer via processFrame().
 */
function startOverlayLoop(): void {
  const video = videoRef.value
  const overlay = overlayRef.value
  if (!video || !overlay) return
  const ctx = overlay.getContext('2d')
  if (!ctx) return

  const loop = () => {
    rafId = requestAnimationFrame(loop)
    if (video.readyState < 2 || video.videoWidth === 0) return

    if (overlay.width !== video.videoWidth) {
      overlay.width = video.videoWidth
      overlay.height = video.videoHeight
    }

    ctx.clearRect(0, 0, overlay.width, overlay.height)
    if (lastQuad) {
      drawQuadOverlay(ctx, lastQuad, overlay.width)
    }

    // Throttled detection for overlay display only
    overlayTick += 1
    if (overlayTick % OVERLAY_DETECT_EVERY_N === 0 && !detectionInFlight) {
      if (edgeBackend) {
        detectionInFlight = true
        const work = document.createElement('canvas')
        work.width = video.videoWidth
        work.height = video.videoHeight
        work.getContext('2d')?.drawImage(video, 0, 0)
        edgeBackend
          .detect(work)
          .then((quad) => {
            lastQuad = quad
          })
          .catch(() => {
            lastQuad = null
          })
          .finally(() => {
            detectionInFlight = false
          })
      }
    }
  }
  loop()
}

/**
 * Start capture timer: processFrame() runs every CAPTURE_INTERVAL_MS.
 * Used by both camera and video-playback modes.
 */
function startCaptureTimer(): void {
  const video = videoRef.value
  if (!video) return
  captureTimerId = setInterval(() => {
    void processFrame(video)
  }, CAPTURE_INTERVAL_MS)
}

function stopCaptureTimer(): void {
  if (captureTimerId !== null) {
    clearInterval(captureTimerId)
    captureTimerId = null
  }
}

// --------------------------------------------------------------------------
// Start / stop orchestration
// --------------------------------------------------------------------------

async function initEdgeBackend(): Promise<void> {
  // Primary: DocAligner ML model
  statusText.value = 'AI モデル読み込み中 (初回のみ)...'
  try {
    const docaligner = new DocAlignerBackend('fastvit_t8')
    await docaligner.warmUp()
    edgeBackend = docaligner
  } catch {
    edgeBackend = null
  }

  // Fallback: jscanify (Canny + contour, requires OpenCV.js)
  try {
    statusText.value = 'OpenCV 初期化中...'
    const jscanify = new JscanifyBackend()
    await jscanify.warmUp()
    if (edgeBackend) {
      fallbackBackend = jscanify // secondary
    } else {
      edgeBackend = jscanify // promote to primary if DocAligner failed
    }
  } catch {
    fallbackBackend = null
  }
  // Canny direct (cannyDetectQuad) needs OpenCV.js too, which is now loaded
}

async function start(): Promise<void> {
  phase.value = 'loading'
  errorText.value = null
  try {
    await initEdgeBackend()

    statusText.value = 'カメラ起動中...'
    await startCamera()

    statusText.value = ''
    phase.value = 'ready'
    startOverlayLoop()
    startCaptureTimer()
  } catch (err) {
    phase.value = 'error'
    errorText.value =
      err instanceof Error ? err.message : '初期化に失敗しました'
    statusText.value = ''
  }
}

async function startFromFile(): Promise<void> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*,.mp4,.mov,.webm,.avi'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.oncancel = () => resolve(null)
    input.click()
  })
  if (!file) return

  phase.value = 'loading'
  errorText.value = null
  try {
    await initEdgeBackend()

    const video = videoRef.value
    if (!video) throw new Error('ビデオ要素の取得に失敗しました')

    statusText.value = '動画を読み込み中...'
    const objectUrl = URL.createObjectURL(file)
    video.srcObject = null
    video.muted = true
    video.playsInline = true

    const ready = new Promise<void>((resolve, reject) => {
      video.oncanplay = () => resolve()
      video.onerror = () => reject(new Error('動画の読み込みに失敗しました'))
    })
    video.src = objectUrl
    await ready

    const duration = video.duration
    const totalSamples = Math.floor(duration / (CAPTURE_INTERVAL_MS / 1000))

    statusText.value = `${totalSamples} フレームを解析中...`
    phase.value = 'ready'

    // Batch: seek to each sample point, run processFrame
    for (let i = 0; i <= totalSamples; i++) {
      const seekTime = i * (CAPTURE_INTERVAL_MS / 1000)
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve()
        video.currentTime = seekTime
      })
      await processFrame(video)
      statusText.value = `解析中... ${i + 1}/${totalSamples} (${captured.value.length} ページ検出)`
    }

    URL.revokeObjectURL(objectUrl)

    // Auto-run SigLIP visual dedup — but only when SSIM left too many
    // candidates. SigLIP-base-224 can over-merge similar-looking pages
    // from the same document (e.g., manual pages with identical layout).
    // Heuristic: if SSIM candidates > duration/3, there are likely
    // duplicates that need semantic dedup. Otherwise SSIM was sufficient.
    const ssimCount = captured.value.length
    const maxReasonable = Math.max(10, Math.floor(duration / 3))
    if (ssimCount > maxReasonable) {
      statusText.value = `${ssimCount} 候補を SigLIP で最終重複除去中...`
      try {
        await runDedup()
      } catch (dedupErr) {
        console.error('[scan] SigLIP dedup failed:', dedupErr)
        showTransientError(
          `SigLIP 重複除去失敗: ${dedupErr instanceof Error ? dedupErr.message : String(dedupErr)}`,
        )
      }
    }

    // Post-filter: remove completely unreadable frames (sharpness < 10).
    // Only catches extreme motion blur (page-flip mid-transition).
    // Threshold 10 preserves dim/soft pages while removing garbage.
    const MIN_READABLE_SHARPNESS = 10
    const blurry = captured.value.filter(
      (p) => p.sharpness < MIN_READABLE_SHARPNESS,
    )
    if (blurry.length > 0) {
      captured.value = captured.value.filter(
        (p) => p.sharpness >= MIN_READABLE_SHARPNESS,
      )
    }

    // Post-enhance: apply auto-crop + CLAHE + A4 normalization to raw frames.
    // This runs AFTER dedup so SSIM compares raw (consistent) frames.
    statusText.value = `${captured.value.length} ページを画像補正中...`
    const pages = [...captured.value]
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!
      if (page.backendName && page.backendName !== 'raw') continue
      // Load dataUrl into canvas
      const img = await new Promise<HTMLImageElement>((resolve) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.src = page.dataUrl
      })
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      c.getContext('2d')?.drawImage(img, 0, 0)
      const out = enhanceDocument(c)
      pages[i] = {
        ...page,
        dataUrl: out.toDataURL('image/jpeg', 0.85),
        width: out.width,
        height: out.height,
        backendName: 'enhanced',
      }
    }
    captured.value = pages

    statusText.value = ''
    void persistSession()
    showTransientError(
      `完了: ${captured.value.length} ユニークページを検出しました。`,
    )
  } catch (err) {
    phase.value = 'error'
    errorText.value =
      err instanceof Error ? err.message : '動画の読み込みに失敗しました'
    statusText.value = ''
  }
}

// --------------------------------------------------------------------------
// Manual capture (button tap in camera mode)
// --------------------------------------------------------------------------

async function manualCapture(): Promise<void> {
  const video = videoRef.value
  if (!video) return
  await processFrame(video)
}

function showCaptureNotification(
  source: HTMLCanvasElement,
  type: 'new' | 'replaced' | 'skipped' = 'new',
  pageNumber?: number,
): void {
  const id = ++nextNotificationId
  notification.value = {
    id,
    dataUrl: source.toDataURL('image/jpeg', NOTIFICATION_THUMB_QUALITY),
    pageNumber: pageNumber ?? captured.value.length,
    type,
  }
  if (notificationTimeoutId !== null) {
    window.clearTimeout(notificationTimeoutId)
  }
  // Skipped notifications fade faster — they're informational, not actionable.
  const duration = type === 'skipped' ? 1500 : NOTIFICATION_DURATION_MS
  notificationTimeoutId = window.setTimeout(() => {
    if (notification.value?.id === id) {
      notification.value = null
    }
    notificationTimeoutId = null
  }, duration)
}

function downloadPageImage(page: CapturedPage, idx: number): void {
  const a = document.createElement('a')
  a.href = page.dataUrl
  a.download = `astarscan-page-${String(idx + 1).padStart(3, '0')}.jpg`
  a.click()
}

function removePage(id: string): void {
  captured.value = captured.value.filter((p) => p.id !== id)
  ssimDedup.removePage(id)
  void persistSession()
}

function movePageUp(idx: number): void {
  if (idx <= 0) return
  const pages = [...captured.value]
  const temp = pages[idx - 1]!
  pages[idx - 1] = pages[idx]!
  pages[idx] = temp
  captured.value = pages
  void persistSession()
}

function movePageDown(idx: number): void {
  if (idx >= captured.value.length - 1) return
  const pages = [...captured.value]
  const temp = pages[idx + 1]!
  pages[idx + 1] = pages[idx]!
  pages[idx] = temp
  captured.value = pages
  void persistSession()
}

/**
 * Re-detect corners on the source frame and re-warp. This is the
 * simplified version of "manual 4-corner correction" — the user gets
 * a fresh detection attempt rather than dragging handles. Useful when
 * auto-capture grabbed a slightly off quad.
 */
async function redetectPage(idx: number): Promise<void> {
  const page = captured.value[idx]
  if (!page?.sourceDataUrl || !edgeBackend) return

  try {
    // Reconstruct canvas from the saved source frame
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Failed to load source frame'))
      el.src = page.sourceDataUrl!
    })
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    canvas.getContext('2d')?.drawImage(img, 0, 0)

    const quad = await edgeBackend.detect(canvas)
    if (!quad) {
      showTransientError('再検出できませんでした。')
      return
    }

    const extracted = warpPerspective(
      canvas,
      quad,
      EXTRACT_WIDTH,
      EXTRACT_HEIGHT,
    )
    const sharpness = measureSharpness(extracted)

    const pages = [...captured.value]
    pages[idx] = {
      ...page,
      dataUrl: extracted.toDataURL('image/jpeg', 0.85),
      width: extracted.width,
      height: extracted.height,
      sharpness,
      ocrText: undefined, // OCR needs to be re-run after re-warp
    }
    captured.value = pages
    void persistSession()
    showTransientError('再検出しました。')
  } catch {
    showTransientError('再検出に失敗しました。')
  }
}

// --------------------------------------------------------------------------
// OCR
// --------------------------------------------------------------------------

async function startOcr(pageIndex: number): Promise<void> {
  const page = captured.value[pageIndex]
  if (!page) return

  // Show panel immediately in loading state
  ocrPanelPage.value = { pageIndex, result: null, loading: true }

  try {
    // Initialize OCR engine on first use (downloads ~146MB of models)
    if (!isOcrReady()) {
      ocrLoading.value = true
      ocrProgress.value = 'OCR モデル準備中...'
      await initOcr((p) => {
        ocrProgress.value = `${p.stage} (${Math.round(p.percent)}%)`
      })
      ocrLoading.value = false
      ocrProgress.value = ''
    }

    // Run OCR on the page
    const result = await runOcr(page.dataUrl)

    // Write back text to the CapturedPage
    const pages = [...captured.value]
    const target = pages[pageIndex]
    if (target) {
      pages[pageIndex] = {
        ...target,
        ocrText: result.text,
        ocrLines: result.lines,
      }
      captured.value = pages
    }

    ocrPanelPage.value = { pageIndex, result, loading: false }
  } catch (err) {
    ocrPanelPage.value = null
    showTransientError(
      err instanceof Error ? err.message : 'OCR の実行に失敗しました',
    )
    ocrLoading.value = false
  }
}

function closeOcrPanel(): void {
  ocrPanelPage.value = null
}

// --------------------------------------------------------------------------
// Page preview (fullscreen)
// --------------------------------------------------------------------------

function openPreview(idx: number): void {
  previewPageIndex.value = idx
}

function closePreview(): void {
  previewPageIndex.value = null
}

function previewPrev(): void {
  if (previewPageIndex.value !== null && previewPageIndex.value > 0) {
    previewPageIndex.value -= 1
  }
}

function previewNext(): void {
  if (
    previewPageIndex.value !== null &&
    previewPageIndex.value < captured.value.length - 1
  ) {
    previewPageIndex.value += 1
  }
}

function previewOcrAndClose(): void {
  if (previewPageIndex.value !== null) {
    startOcr(previewPageIndex.value)
  }
  closePreview()
}

function previewDeleteAndClose(): void {
  if (previewPageIndex.value !== null) {
    const page = captured.value[previewPageIndex.value]
    if (page) removePage(page.id)
  }
  closePreview()
}

// --------------------------------------------------------------------------
// Visual dedup (post-processing)
// --------------------------------------------------------------------------

/**
 * Run visual embedding-based dedup on all captured pages. Uses a SigLIP
 * vision encoder (~55MB, lazy-loaded) to find semantically similar pages
 * and merge clusters. Keeps the sharpest representative per cluster.
 */
async function runDedup(): Promise<void> {
  if (captured.value.length < 2 || dedupRunning.value) return
  dedupRunning.value = true
  dedupProgressText.value = ''

  try {
    const result = await runVisualDedup(
      captured.value.map((p) => ({
        dataUrl: p.dataUrl,
        sharpness: p.sharpness,
      })),
      undefined, // use default threshold
      (msg) => {
        dedupProgressText.value = msg
      },
    )

    const removed = captured.value.length - result.keepIndices.length
    if (removed === 0) {
      showTransientError('重複は検出されませんでした。')
      return
    }

    // Keep only the representative pages
    const keepSet = new Set(result.keepIndices)
    const newPages = captured.value.filter((_, i) => keepSet.has(i))

    // Rebuild dedup manager with the surviving pages
    ssimDedup.clear()
    // (SSIM thumbnails would need to be re-extracted, but since we're
    // in post-processing mode the dedup manager is secondary. Just
    // clear it — new captures will build it fresh.)

    captured.value = newPages
    void persistSession()
    showTransientError(
      `重複除去完了: ${removed} 件の重複を除外し、${result.clusterCount} ページに整理しました。`,
    )
  } catch (err) {
    showTransientError(
      err instanceof Error ? err.message : '重複除去に失敗しました',
    )
  } finally {
    dedupRunning.value = false
    dedupProgressText.value = ''
  }
}

// VLM filter state
const vlmRunning = ref(false)
const vlmProgressText = ref('')

/**
 * Run VLM-based document classification on all captured pages.
 * Removes non-document frames (desk, hand occlusion, etc.).
 * Uses SmolVLM-256M (~175MB, lazy-loaded).
 */
async function runVlmFilter(): Promise<void> {
  if (captured.value.length === 0 || vlmRunning.value) return
  vlmRunning.value = true
  vlmProgressText.value = ''

  try {
    const results = await classifyBatch(
      captured.value.map((p) => ({ dataUrl: p.dataUrl })),
      (msg) => {
        vlmProgressText.value = msg
      },
    )

    const removed: number[] = []
    results.forEach((r, i) => {
      if (!r.isDocument) removed.push(i)
    })

    if (removed.length === 0) {
      showTransientError('全てのページが書類として認識されました。')
      return
    }

    const removeSet = new Set(removed)
    const kept = captured.value.filter((_, i) => !removeSet.has(i))
    ssimDedup.clear()
    captured.value = kept
    void persistSession()
    showTransientError(
      `書類判定完了: ${removed.length} 件の非書類フレームを除外しました。`,
    )
  } catch (err) {
    showTransientError(
      err instanceof Error ? err.message : '書類判定に失敗しました',
    )
  } finally {
    vlmRunning.value = false
    vlmProgressText.value = ''
  }
}

type PdfMode = 'single' | 'split' | 'batch'
const pdfMode = ref<PdfMode>('single')

// CJK font cache — loaded once, reused across PDF exports
let cjkFontBase64: string | null = null

async function loadCjkFont(): Promise<string> {
  if (cjkFontBase64) return cjkFontBase64
  // Try local first, fallback to Google Fonts CDN
  let resp = await fetch('/fonts/NotoSansJP-Regular.ttf').catch(() => null)
  if (!resp?.ok) {
    resp = await fetch(
      'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf',
    )
  }
  const buf = await resp.arrayBuffer()
  // Convert ArrayBuffer to base64
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  cjkFontBase64 = btoa(binary)
  return cjkFontBase64
}

async function buildPdf(pages: CapturedPage[]): Promise<jsPDF> {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' })
  const mmWidth = pdf.internal.pageSize.getWidth()
  const mmHeight = pdf.internal.pageSize.getHeight()

  // Register CJK font if any page has OCR lines
  const hasOcr = pages.some((p) => p.ocrLines?.length)
  if (hasOcr) {
    const fontData = await loadCjkFont()
    pdf.addFileToVFS('NotoSansJP-Regular.ttf', fontData)
    pdf.addFont('NotoSansJP-Regular.ttf', 'NotoSansJP', 'normal', 'Identity-H')
  }

  pages.forEach((page, i) => {
    if (i > 0) pdf.addPage()
    const imgAspect = page.width / page.height
    const pageAspect = mmWidth / mmHeight
    let w: number
    let h: number
    if (imgAspect > pageAspect) {
      w = mmWidth
      h = mmWidth / imgAspect
    } else {
      h = mmHeight
      w = mmHeight * imgAspect
    }
    const x = (mmWidth - w) / 2
    const y = (mmHeight - h) / 2
    pdf.addImage(page.dataUrl, 'JPEG', x, y, w, h)

    // Transparent text overlay for searchable PDF
    if (page.ocrLines?.length) {
      pdf.setFont('NotoSansJP')
      for (const line of page.ocrLines) {
        const mmX = x + (line.bbox[0] / EXTRACT_WIDTH) * w
        // bbox[1] is top of text; add bbox[3] (height) for baseline
        const mmY = y + ((line.bbox[1] + line.bbox[3]) / EXTRACT_HEIGHT) * h
        const fontPt = Math.max(
          4,
          Math.min((line.bbox[3] / EXTRACT_HEIGHT) * h * 2.835, 24),
        )
        pdf.setFontSize(fontPt)
        pdf.text(line.text, mmX, mmY, { renderingMode: 'invisible' })
      }
    }
  })
  return pdf
}

const pdfExporting = ref(false)

async function exportPdf(): Promise<void> {
  if (captured.value.length === 0 || pdfExporting.value) return
  pdfExporting.value = true
  try {
    // Auto-run OCR on pages that don't have it yet
    const needsOcr = captured.value.filter((p) => !p.ocrLines)
    if (needsOcr.length > 0) {
      statusText.value = `OCR 実行中... (${needsOcr.length} ページ)`
      if (!isOcrReady()) {
        await initOcr((p) => {
          statusText.value = `OCR モデル準備中... (${Math.round(p.percent)}%)`
        })
      }
      const pages = [...captured.value]
      for (let i = 0; i < pages.length; i++) {
        if (!pages[i]!.ocrLines) {
          statusText.value = `OCR: ${i + 1}/${pages.length}`
          const result = await runOcr(pages[i]!.dataUrl)
          pages[i] = {
            ...pages[i]!,
            ocrText: result.text,
            ocrLines: result.lines,
          }
        }
      }
      captured.value = pages
      void persistSession()
    }

    statusText.value = 'PDF 生成中...'
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const mode = pdfMode.value

    if (mode === 'single') {
      const pdf = await buildPdf(captured.value)
      pdf.save(`astarscan-${ts}.pdf`)
    } else if (mode === 'split') {
      for (let i = 0; i < captured.value.length; i++) {
        const pdf = await buildPdf([captured.value[i]!])
        pdf.save(`astarscan-${ts}-p${String(i + 1).padStart(3, '0')}.pdf`)
      }
    } else if (mode === 'batch') {
      const batchSize = 10
      for (let start = 0; start < captured.value.length; start += batchSize) {
        const batch = captured.value.slice(start, start + batchSize)
        const batchNum = Math.floor(start / batchSize) + 1
        const pdf = await buildPdf(batch)
        pdf.save(
          `astarscan-${ts}-batch${String(batchNum).padStart(2, '0')}.pdf`,
        )
      }
    }

    statusText.value = ''
    ssimDedup.clear()
    void clearSession()
  } catch (err) {
    showTransientError(
      err instanceof Error ? err.message : 'PDF の生成に失敗しました',
    )
    statusText.value = ''
  } finally {
    pdfExporting.value = false
  }
}

// --------------------------------------------------------------------------
// Session persistence
// --------------------------------------------------------------------------

function persistSession(): Promise<void> {
  const pages: StoredPage[] = captured.value.map((p) => ({
    id: p.id,
    dataUrl: p.dataUrl,
    width: p.width,
    height: p.height,
    sharpness: p.sharpness,
    ocrText: p.ocrText,
    ocrLines: p.ocrLines,
    capturedAt: Date.now(),
  }))
  return saveSession(pages).catch(() => {})
}

async function restoreSession(): Promise<void> {
  const session = await loadSession()
  if (!session || session.pages.length === 0) return
  captured.value = session.pages.map((p) => ({
    id: p.id,
    dataUrl: p.dataUrl,
    width: p.width,
    height: p.height,
    sharpness: p.sharpness,
    ocrText: p.ocrText,
    ocrLines: p.ocrLines as readonly OcrLine[] | undefined,
  }))
}

function showTransientError(msg: string): void {
  errorText.value = msg
  window.setTimeout(() => {
    errorText.value = null
  }, 3000)
}

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------

onMounted(() => {
  void restoreSession()
})

onBeforeUnmount(() => {
  stopCaptureTimer()
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (notificationTimeoutId !== null) {
    window.clearTimeout(notificationTimeoutId)
    notificationTimeoutId = null
  }
  visibilityCleanup?.()
  visibilityCleanup = null
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  edgeBackend?.dispose()
  edgeBackend = null
  fallbackBackend?.dispose()
  fallbackBackend = null
  lastQuad = null
  ssimDedup.clear()
  disposeOcr()
  disposeVisualDedup()
  disposeClassifier()
})
</script>

<template>
  <main class="app">
    <header class="app__header">
      <h1 class="app__title">AstarScan</h1>
      <span v-if="statusText && phase === 'loading'" class="app__status">
        {{ statusText }}
      </span>
    </header>

    <section class="viewport">
      <video ref="videoRef" class="viewport__video" playsinline muted />
      <canvas ref="overlayRef" class="viewport__overlay" />

      <div v-if="phase === 'idle'" class="splash">
        <h2 class="splash__title">書類の山をスマホで電子化</h2>
        <p class="splash__tagline">
          スマホを書類に向けるだけ。<br />
          安定したページを自動で検出し、PDF にまとめます。
        </p>
        <p class="splash__privacy">
          全ての処理はこの端末内で完結し、画像や PDF
          は外部サーバーに送信されません。
          <NuxtLink to="/privacy" class="splash__privacy-link"
            >プライバシーポリシー</NuxtLink
          >
        </p>
      </div>

      <div v-else-if="phase === 'loading'" class="splash">
        <div class="spinner" aria-hidden="true" />
      </div>

      <div v-else-if="phase === 'error'" class="splash splash--error">
        <p class="splash__error">{{ errorText }}</p>
      </div>

      <Transition name="notify">
        <div
          v-if="notification && phase === 'ready'"
          :key="notification.id"
          class="notify"
          :class="{
            'notify--replaced': notification.type === 'replaced',
            'notify--skipped': notification.type === 'skipped',
          }"
          role="status"
        >
          <img
            :src="notification.dataUrl"
            :alt="`ページ ${notification.pageNumber}`"
            class="notify__thumb"
          />
          <div class="notify__body">
            <span class="notify__title">
              <template v-if="notification.type === 'replaced'">
                ページ {{ notification.pageNumber }} を更新
              </template>
              <template v-else-if="notification.type === 'skipped'">
                ページ {{ notification.pageNumber }}
              </template>
              <template v-else> ページ {{ notification.pageNumber }} </template>
            </span>
            <span class="notify__subtitle">
              <template v-if="notification.type === 'replaced'">
                より鮮明なフレームに差し替えました
              </template>
              <template v-else-if="notification.type === 'skipped'">
                既にキャプチャ済み
              </template>
              <template v-else> キャプチャしました </template>
            </span>
          </div>
        </div>
      </Transition>
    </section>

    <div v-if="captured.length > 0" class="strip">
      <div
        v-for="(page, idx) in captured"
        :key="page.id"
        class="strip__thumb"
        :class="{ 'strip__thumb--ocr': page.ocrText }"
      >
        <img
          :src="page.dataUrl"
          :alt="`ページ ${idx + 1}`"
          @click="openPreview(idx)"
        />
        <span class="strip__num">{{ idx + 1 }}</span>
        <span class="strip__debug"
          >{{ (page.backendName ?? '?').slice(0, 3) }}:{{
            Math.round(page.sharpness)
          }}</span
        >
        <span v-if="page.ocrText" class="strip__ocr-badge">OCR</span>
        <div class="strip__actions">
          <button
            v-if="idx > 0"
            class="strip__btn"
            type="button"
            :aria-label="`ページ ${idx + 1} を前に`"
            @click.stop="movePageUp(idx)"
          >
            &lt;
          </button>
          <button
            class="strip__btn strip__btn--dl"
            type="button"
            :aria-label="`ページ ${idx + 1} を画像で保存`"
            @click.stop="downloadPageImage(page, idx)"
          >
            DL
          </button>
          <button
            v-if="page.sourceDataUrl"
            class="strip__btn strip__btn--re"
            type="button"
            :aria-label="`ページ ${idx + 1} を再検出`"
            @click.stop="redetectPage(idx)"
          >
            R
          </button>
          <button
            v-if="idx < captured.length - 1"
            class="strip__btn"
            type="button"
            :aria-label="`ページ ${idx + 1} を後に`"
            @click.stop="movePageDown(idx)"
          >
            &gt;
          </button>
        </div>
        <button
          class="strip__remove"
          type="button"
          :aria-label="`ページ ${idx + 1} を削除`"
          @click.stop="removePage(page.id)"
        >
          ×
        </button>
      </div>
    </div>

    <footer class="controls">
      <template v-if="phase === 'idle' || phase === 'error'">
        <button class="btn btn--primary" type="button" @click="start">
          {{ phase === 'idle' ? 'カメラで撮影' : '再試行' }}
        </button>
        <button
          v-if="phase === 'idle'"
          class="btn btn--secondary"
          type="button"
          @click="startFromFile"
        >
          動画ファイルから
        </button>
        <button
          v-if="captured.length >= 2"
          class="btn btn--accent"
          type="button"
          :disabled="dedupRunning"
          @click="runDedup"
        >
          {{ dedupRunning ? '処理中...' : '重複除去' }}
        </button>
        <button
          v-if="captured.length >= 1"
          class="btn btn--secondary"
          type="button"
          :disabled="vlmRunning"
          @click="runVlmFilter"
        >
          {{ vlmRunning ? '判定中...' : 'AI 書類判定' }}
        </button>
        <button
          v-if="captured.length > 0"
          class="btn btn--primary"
          type="button"
          :disabled="pdfExporting"
          @click="exportPdf"
        >
          {{ pdfExporting ? 'PDF 生成中...' : `PDF 出力 (${captured.length})` }}
        </button>
      </template>

      <template v-else>
        <button
          class="btn btn--secondary"
          type="button"
          :disabled="phase !== 'ready'"
          @click="manualCapture"
        >
          手動で撮影
        </button>
        <button
          v-if="captured.length >= 2"
          class="btn btn--accent"
          type="button"
          :disabled="dedupRunning"
          @click="runDedup"
        >
          {{ dedupRunning ? '処理中...' : '重複除去' }}
        </button>
        <button
          v-if="captured.length >= 1"
          class="btn btn--secondary"
          type="button"
          :disabled="vlmRunning"
          @click="runVlmFilter"
        >
          {{ vlmRunning ? '判定中...' : 'AI 書類判定' }}
        </button>
        <Select v-model="pdfMode">
          <SelectTrigger class="w-[130px] h-10 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="single">1つの PDF</SelectItem>
            <SelectItem value="split">ページ別 PDF</SelectItem>
            <SelectItem value="batch">10枚ずつ</SelectItem>
          </SelectContent>
        </Select>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="captured.length === 0 || pdfExporting"
          @click="exportPdf"
        >
          {{ pdfExporting ? 'PDF 生成中...' : `PDF 出力 (${captured.length})` }}
        </button>
      </template>
    </footer>

    <div v-if="errorText && phase === 'ready'" class="toast" role="alert">
      {{ errorText }}
    </div>

    <div v-if="ocrLoading" class="toast toast--info" role="status">
      {{ ocrProgress }}
    </div>

    <div v-if="dedupRunning" class="toast toast--info" role="status">
      {{ dedupProgressText || '重複除去中...' }}
    </div>

    <div v-if="vlmRunning" class="toast toast--info" role="status">
      {{ vlmProgressText || 'AI 書類判定中...' }}
    </div>

    <Transition name="sheet">
      <div
        v-if="ocrPanelPage !== null"
        class="sheet-backdrop"
        @click.self="closeOcrPanel"
      >
        <OcrResultPanel
          :result="ocrPanelPage.result"
          :page-image-url="captured[ocrPanelPage.pageIndex]?.dataUrl ?? ''"
          :page-number="ocrPanelPage.pageIndex + 1"
          :loading="ocrPanelPage.loading"
          @close="closeOcrPanel"
        />
      </div>
    </Transition>

    <!-- Fullscreen page preview -->
    <Transition name="sheet">
      <div
        v-if="previewPageIndex !== null && captured[previewPageIndex]"
        class="preview-backdrop"
        @click.self="closePreview"
      >
        <div class="preview">
          <div class="preview__header">
            <span class="preview__title">
              ページ {{ previewPageIndex + 1 }} / {{ captured.length }}
            </span>
            <button
              class="preview__close"
              type="button"
              aria-label="閉じる"
              @click="closePreview"
            >
              ×
            </button>
          </div>

          <div class="preview__image-wrap">
            <img
              :src="captured[previewPageIndex]!.dataUrl"
              :alt="`ページ ${previewPageIndex + 1}`"
              class="preview__image"
            />
          </div>

          <div class="preview__footer">
            <button
              class="btn btn--secondary"
              type="button"
              :disabled="previewPageIndex <= 0"
              @click="previewPrev"
            >
              ← 前
            </button>
            <button
              class="btn btn--secondary"
              type="button"
              @click="
                downloadPageImage(captured[previewPageIndex]!, previewPageIndex)
              "
            >
              DL
            </button>
            <button
              class="btn btn--secondary"
              type="button"
              @click="previewOcrAndClose"
            >
              OCR
            </button>
            <button
              class="btn btn--secondary"
              type="button"
              @click="previewDeleteAndClose"
            >
              削除
            </button>
            <button
              class="btn btn--secondary"
              type="button"
              :disabled="previewPageIndex >= captured.length - 1"
              @click="previewNext"
            >
              次 →
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </main>
</template>

<style scoped>
/* ============================================================
 * Astar Design System — Light theme, warm minimalism
 * "Notion のやさしさ × Linear の精密さ × 日本語の読みやすさ"
 * ============================================================ */

.app {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  background: #ffffff;
  color: #1e293b;
  font-family:
    'BIZTER',
    ui-sans-serif,
    system-ui,
    -apple-system,
    sans-serif;
  overflow: hidden;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  padding-top: calc(0.75rem + env(safe-area-inset-top));
  background: #ffffff;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  z-index: 10;
}

.app__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: #001f42;
}

.app__status {
  font-size: 0.8125rem;
  color: #64748b;
}

.viewport {
  position: relative;
  flex: 1;
  overflow: hidden;
  background: #000;
  min-height: 0;
}

.viewport__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  z-index: 1;
}

.viewport__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 2;
  background: transparent;
}

.splash {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: #ffffff;
  text-align: center;
  z-index: 5;
}

.splash__title {
  margin: 0 0 1rem;
  font-size: 1.5rem;
  font-weight: 700;
  color: #001f42;
}

.splash__tagline {
  margin: 0 0 2rem;
  font-size: 0.9375rem;
  line-height: 1.7;
  color: #64748b;
}

.splash__privacy {
  margin: 0;
  font-size: 0.8125rem;
  color: #909090;
  max-width: 20rem;
  line-height: 1.6;
}

.splash__privacy-link {
  color: #0084ff;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.splash--error {
  background: #fff5f5;
}

.splash__error {
  margin: 0;
  font-size: 1rem;
  color: #dc2626;
  font-weight: 500;
  max-width: 24rem;
  line-height: 1.6;
}

.spinner {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  border: 3px solid rgba(0, 0, 0, 0.06);
  border-top-color: #0084ff;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.notify {
  position: absolute;
  top: 1rem;
  right: 1rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.875rem 0.625rem 0.625rem;
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 0.625rem;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.08),
    0 1px 2px rgba(0, 0, 0, 0.04);
  max-width: calc(100% - 2rem);
  z-index: 15;
}

.notify__thumb {
  width: 3.5rem;
  height: 4.5rem;
  object-fit: cover;
  border-radius: 0.375rem;
  border: 1px solid rgba(0, 0, 0, 0.08);
  flex-shrink: 0;
}

.notify__body {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  min-width: 0;
}

.notify__title {
  font-size: 0.8125rem;
  font-weight: 700;
  color: #001f42;
}

.notify__subtitle {
  font-size: 0.75rem;
  color: #64748b;
}

.notify-enter-active,
.notify-leave-active {
  transition:
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.notify-enter-from,
.notify-leave-to {
  transform: translateX(calc(100% + 2rem));
  opacity: 0;
}
.notify-enter-to,
.notify-leave-from {
  transform: translateX(0);
  opacity: 1;
}

.notify--replaced {
  border-left: 3px solid #16a34a;
}

.notify--replaced .notify__title {
  color: #16a34a;
}

.notify--skipped {
  opacity: 0.7;
}

.notify--skipped .notify__title {
  color: #909090;
}

.strip {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  overflow-y: hidden;
  background: #f4f5f9;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
  scrollbar-width: none;
}

.strip::-webkit-scrollbar {
  display: none;
}

.strip__thumb {
  position: relative;
  flex: 0 0 3.5rem;
  aspect-ratio: 3 / 4;
  border-radius: 0.5rem;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #ffffff;
}

.strip__thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.strip__num {
  position: absolute;
  top: 0.125rem;
  left: 0.125rem;
  padding: 0 0.3125rem;
  background: rgba(0, 31, 66, 0.75);
  border-radius: 0.25rem;
  font-size: 0.625rem;
  font-weight: 600;
  color: #ffffff;
}

.strip__remove {
  position: absolute;
  top: 0;
  right: 0;
  width: 1.25rem;
  height: 1.25rem;
  padding: 0;
  border: none;
  border-radius: 0 0 0 0.375rem;
  background: rgba(239, 68, 68, 0.9);
  color: #fff;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
}

.strip__remove:active {
  background: rgb(220, 38, 38);
}

.strip__actions {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.strip__thumb:hover .strip__actions,
.strip__thumb:focus-within .strip__actions {
  opacity: 1;
}

.strip__btn {
  padding: 0.125rem 0.25rem;
  border: none;
  background: rgba(0, 31, 66, 0.7);
  color: #ffffff;
  font-size: 0.5rem;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
}

.strip__btn--re {
  background: rgba(0, 132, 255, 0.8);
}

.strip__btn--dl {
  background: rgba(22, 163, 74, 0.8);
}

.strip__btn:active {
  background: rgba(0, 31, 66, 0.9);
}

.strip__debug {
  position: absolute;
  top: 0.125rem;
  right: 1.375rem;
  font-size: 0.4375rem;
  color: rgba(0, 0, 0, 0.4);
  font-family: monospace;
}

.strip__thumb--ocr {
  border-color: #0084ff;
}

.strip__ocr-badge {
  position: absolute;
  bottom: 0.125rem;
  left: 0.125rem;
  right: 0.125rem;
  padding: 0.0625rem 0;
  background: #0084ff;
  color: #ffffff;
  border-radius: 0.1875rem;
  font-size: 0.5rem;
  font-weight: 700;
  text-align: center;
}

.toast--info {
  background: #ffffff;
  color: #0084ff;
  border-left: 3px solid #0084ff;
}

.sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-end;
  z-index: 30;
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.25s ease;
}
.sheet-enter-active > *,
.sheet-leave-active > * {
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from > *,
.sheet-leave-to > * {
  transform: translateY(100%);
}

.preview-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 30;
}

.preview {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  max-width: 100vw;
  max-height: 100dvh;
}

.preview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  padding-top: calc(0.75rem + env(safe-area-inset-top));
  flex-shrink: 0;
}

.preview__title {
  font-size: 0.875rem;
  font-weight: 600;
  color: #f1f5f9;
}

.preview__close {
  width: 2.5rem;
  height: 2.5rem;
  border: none;
  background: rgba(255, 255, 255, 0.15);
  color: #f1f5f9;
  font-size: 1.25rem;
  border-radius: 50%;
  cursor: pointer;
}

.preview__image-wrap {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem;
  -webkit-overflow-scrolling: touch;
}

.preview__image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 0.375rem;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
}

.preview__footer {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
  justify-content: center;
  flex-shrink: 0;
}

.preview__footer .btn {
  font-size: 0.75rem;
  padding: 0.5rem 0.75rem;
  min-width: auto;
}

.controls {
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
  padding-bottom: calc(1rem + env(safe-area-inset-bottom));
  background: #ffffff;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.btn {
  flex: 1;
  padding: 1rem;
  border: none;
  border-radius: 0.625rem;
  font-size: 1rem;
  font-weight: 600;
  color: #ffffff;
  cursor: pointer;
  transition:
    transform 0.15s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  font-family: inherit;
}

.btn--full {
  flex: 1 1 100%;
}

.btn--primary {
  background: #0084ff;
  box-shadow:
    0 1px 3px rgba(0, 132, 255, 0.2),
    0 1px 2px rgba(0, 0, 0, 0.06);
}

.btn--secondary {
  background: #ffffff;
  border: 1px solid rgba(0, 0, 0, 0.12);
  color: #001f42;
}

.btn--accent {
  background: #001f42;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.1),
    0 1px 2px rgba(0, 0, 0, 0.06);
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}

.toast {
  position: fixed;
  left: 1rem;
  right: 1rem;
  bottom: calc(5.5rem + env(safe-area-inset-bottom));
  padding: 0.75rem 1rem;
  background: #ffffff;
  color: #dc2626;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-left: 3px solid #dc2626;
  border-radius: 0.625rem;
  font-size: 0.875rem;
  text-align: center;
  font-weight: 500;
  box-shadow:
    0 1px 3px rgba(0, 0, 0, 0.08),
    0 1px 2px rgba(0, 0, 0, 0.04);
  z-index: 20;
  animation: slideUp 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(0.5rem);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
