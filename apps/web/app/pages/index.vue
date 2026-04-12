<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import jsPDF from 'jspdf'

import type { EdgeDetectorBackend, Quad } from '@astarworks/scan-core'
import {
  DEFAULT_BLUR_THRESHOLD,
  measureSharpness,
} from '~/services/blur-detection'
import { DocAlignerBackend } from '~/services/docaligner-backend'
import { JscanifyBackend } from '~/services/jscanify-backend'
import {
  MOTION_RESET_THRESHOLD,
  MotionDetector,
  STABILITY_THRESHOLD,
} from '~/services/motion-detection'
import { disposeOcr, initOcr, isOcrReady, runOcr } from '~/services/ocr-service'
import type { OcrResult } from '~/services/ocr-service'
import { warpPerspective } from '~/services/perspective-warper'

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
  ocrText?: string
}

interface CaptureNotification {
  readonly id: number
  readonly dataUrl: string
  readonly pageNumber: number
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// Target resolution for the perspective-corrected output. A4-ish aspect.
const EXTRACT_WIDTH = 1200
const EXTRACT_HEIGHT = 1600

// Thumbnail used inside the capture-notification toast.
const NOTIFICATION_THUMB_QUALITY = 0.6

// Async detection runs every N RAF frames. At 60 FPS display that's
// ~15 FPS detection — responsive enough for the outline to feel live
// without saturating the CPU. Detection is fire-and-forget; the loop
// just renders the most recent known quad until a new one arrives.
const DETECTION_EVERY_N_FRAMES = 4

// How long the scene must stay stable before auto-capture fires.
// Tuned so the user can show a page, wait half a second while the
// outline locks on, and have it captured without a button tap.
const STABLE_DURATION_MS = 500

// Auto-capture notification display time (ms).
const NOTIFICATION_DURATION_MS = 2500

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

// OCR state
const ocrLoading = ref(false)
const ocrProgress = ref<string>('')
const ocrPanelPage = ref<{
  pageIndex: number
  result: OcrResult | null
  loading: boolean
} | null>(null)

// --------------------------------------------------------------------------
// Non-reactive handles (these don't need Vue reactivity, and making them
// refs would create proxy wrappers around objects that don't tolerate it)
// --------------------------------------------------------------------------

let backend: EdgeDetectorBackend | null = null
let motionDetector: MotionDetector | null = null
let stream: MediaStream | null = null
let rafId: number | null = null
let detectionTick = 0

// Async detection state: RAF draws `lastQuad` on every frame, a throttled
// tick kicks off `backend.detect()`, and the resolved quad updates
// `lastQuad` without blocking the loop.
let lastQuad: Quad | null = null
let detectionInFlight = false
let detectionWorkCanvas: HTMLCanvasElement | null = null

// Auto-capture state machine (see `startDetectionLoop`).
let stableSinceMs: number | null = null
let captureInFlight = false
let captureCooldown = false
let nextNotificationId = 0
let notificationTimeoutId: number | null = null

// --------------------------------------------------------------------------
// Camera lifecycle
// --------------------------------------------------------------------------

async function startCamera(): Promise<void> {
  const mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  })
  stream = mediaStream

  const video = videoRef.value
  if (!video) {
    mediaStream.getTracks().forEach((t) => t.stop())
    stream = null
    throw new Error('ビデオ要素の取得に失敗しました')
  }

  video.srcObject = mediaStream
  await video.play()
}

// --------------------------------------------------------------------------
// Async detection loop — draws quad overlay, samples motion, kicks off
// async detect(), triggers auto-capture when the scene is stable+sharp.
// --------------------------------------------------------------------------

function ensureWorkCanvas(video: HTMLVideoElement): HTMLCanvasElement {
  if (!detectionWorkCanvas) {
    detectionWorkCanvas = document.createElement('canvas')
  }
  if (detectionWorkCanvas.width !== video.videoWidth) {
    detectionWorkCanvas.width = video.videoWidth
    detectionWorkCanvas.height = video.videoHeight
  }
  const ctx = detectionWorkCanvas.getContext('2d', {
    willReadFrequently: true,
  })
  ctx?.drawImage(video, 0, 0)
  return detectionWorkCanvas
}

function drawQuadOverlay(
  ctx: CanvasRenderingContext2D,
  quad: Quad,
  canvasWidth: number,
  stable: boolean,
): void {
  // Yellow when we're actively holding the scene steady and arming a
  // capture; blue when idle-tracking. Gives the user visual feedback
  // that auto-capture is about to fire.
  const stroke = stable
    ? 'rgba(251, 191, 36, 0.98)'
    : 'rgba(96, 165, 250, 0.95)'
  const fill = stable ? 'rgba(251, 191, 36, 0.22)' : 'rgba(96, 165, 250, 0.18)'
  ctx.fillStyle = fill
  ctx.strokeStyle = stroke
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

function startDetectionLoop(): void {
  const video = videoRef.value
  const overlay = overlayRef.value
  if (!video || !overlay || !backend) return
  const ctx = overlay.getContext('2d')
  if (!ctx) return

  if (!motionDetector) {
    motionDetector = new MotionDetector()
  } else {
    motionDetector.reset()
  }
  stableSinceMs = null
  captureCooldown = false

  const loop = () => {
    rafId = requestAnimationFrame(loop)
    if (video.readyState < 2 || video.videoWidth === 0) return

    // Keep the overlay canvas's internal resolution matched to the
    // video source; CSS scales it to the display size.
    if (overlay.width !== video.videoWidth) {
      overlay.width = video.videoWidth
      overlay.height = video.videoHeight
    }

    // -- Motion tracking (hysteresis) -------------------------------
    const motionAmount =
      motionDetector?.sample(video) ?? Number.POSITIVE_INFINITY
    const now = performance.now()

    if (motionAmount >= MOTION_RESET_THRESHOLD) {
      // Definite motion: reset both the stable timer and any post-
      // capture cooldown, so the next stable period can auto-capture.
      stableSinceMs = null
      captureCooldown = false
    } else if (motionAmount < STABILITY_THRESHOLD) {
      // Below the lower threshold: arm or continue the stable timer.
      if (stableSinceMs === null) stableSinceMs = now
    }
    // The band between STABILITY and MOTION_RESET is deliberately a
    // no-op zone — it prevents tiny jitter from flipping the state.

    // -- Overlay paint ---------------------------------------------
    ctx.clearRect(0, 0, overlay.width, overlay.height)
    if (lastQuad) {
      const stableReady =
        stableSinceMs !== null && now - stableSinceMs >= STABLE_DURATION_MS
      drawQuadOverlay(ctx, lastQuad, overlay.width, stableReady)
    }

    // -- Throttled async detection ---------------------------------
    detectionTick += 1
    if (detectionTick % DETECTION_EVERY_N_FRAMES === 0 && !detectionInFlight) {
      const currentBackend = backend
      if (currentBackend) {
        detectionInFlight = true
        const work = ensureWorkCanvas(video)
        currentBackend
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

    // -- Auto-capture trigger --------------------------------------
    if (
      !captureCooldown &&
      !captureInFlight &&
      lastQuad !== null &&
      stableSinceMs !== null &&
      now - stableSinceMs >= STABLE_DURATION_MS
    ) {
      void tryCapture({ auto: true })
    }
  }
  loop()
}

// --------------------------------------------------------------------------
// Start / stop orchestration
// --------------------------------------------------------------------------

async function start(): Promise<void> {
  phase.value = 'loading'
  errorText.value = null
  try {
    // Try DocAligner ONNX first (ML-based, 85-92% accuracy), fall back
    // to JscanifyBackend (classical CV, 60-70%) on load failure.
    statusText.value = 'AI モデル読み込み中 (初回のみ)...'
    let selectedBackend: EdgeDetectorBackend
    try {
      const docaligner = new DocAlignerBackend('fastvit_t8')
      await docaligner.warmUp()
      selectedBackend = docaligner
    } catch {
      statusText.value = 'フォールバック: 古典スキャナー初期化中...'
      const jscanify = new JscanifyBackend()
      await jscanify.warmUp()
      selectedBackend = jscanify
    }
    backend = selectedBackend

    statusText.value = 'カメラ起動中...'
    await startCamera()

    statusText.value = ''
    phase.value = 'ready'
    startDetectionLoop()
  } catch (err) {
    phase.value = 'error'
    errorText.value =
      err instanceof Error ? err.message : '初期化に失敗しました'
    statusText.value = ''
  }
}

// --------------------------------------------------------------------------
// Capture / review / export
// --------------------------------------------------------------------------

async function tryCapture(options: { auto: boolean }): Promise<void> {
  const video = videoRef.value
  const currentBackend = backend
  if (!video || !currentBackend || phase.value !== 'ready') return
  if (captureInFlight) return
  captureInFlight = true

  try {
    // Off-screen canvas at full camera resolution — we don't want the
    // preview overlay (which may be scaled) to affect the captured output.
    const work = document.createElement('canvas')
    work.width = video.videoWidth
    work.height = video.videoHeight
    const ctx = work.getContext('2d')
    if (!ctx) return
    ctx.drawImage(video, 0, 0)

    let quad: Quad | null = null
    try {
      quad = await currentBackend.detect(work)
    } catch {
      quad = null
    }

    if (!quad) {
      if (!options.auto) {
        showTransientError(
          '書類を検出できませんでした。画面内に収めてもう一度撮影してください。',
        )
      }
      return
    }

    let extracted: HTMLCanvasElement
    try {
      extracted = warpPerspective(work, quad, EXTRACT_WIDTH, EXTRACT_HEIGHT)
    } catch (err) {
      if (!options.auto) {
        showTransientError(
          err instanceof Error ? err.message : '書類の切り出しに失敗しました',
        )
      }
      return
    }

    // Quality gate: Laplacian variance. Blurry frames never reach the PDF.
    const sharpness = measureSharpness(extracted)
    if (sharpness < DEFAULT_BLUR_THRESHOLD) {
      if (!options.auto) {
        showTransientError(
          `ピンボケが検出されました (${Math.round(sharpness)})。端末を固定してもう一度撮影してください。`,
        )
      }
      // For auto-capture, silently skip and wait for a better frame.
      // Don't arm the cooldown — we want to retry.
      return
    }

    // Accept!
    const dataUrl = extracted.toDataURL('image/jpeg', 0.85)
    captured.value = [
      ...captured.value,
      {
        id: crypto.randomUUID(),
        dataUrl,
        width: extracted.width,
        height: extracted.height,
        sharpness,
      },
    ]

    if (options.auto) {
      // Lock out further auto-captures until motion is detected. This
      // is what prevents the same stable page from being captured 10
      // times while the user holds the camera still.
      captureCooldown = true
      stableSinceMs = null
    }

    showCaptureNotification(extracted)
  } finally {
    captureInFlight = false
  }
}

function showCaptureNotification(source: HTMLCanvasElement): void {
  const id = ++nextNotificationId
  notification.value = {
    id,
    dataUrl: source.toDataURL('image/jpeg', NOTIFICATION_THUMB_QUALITY),
    pageNumber: captured.value.length,
  }
  if (notificationTimeoutId !== null) {
    window.clearTimeout(notificationTimeoutId)
  }
  notificationTimeoutId = window.setTimeout(() => {
    // Only clear if this is still the latest notification.
    if (notification.value?.id === id) {
      notification.value = null
    }
    notificationTimeoutId = null
  }, NOTIFICATION_DURATION_MS)
}

function removePage(id: string): void {
  captured.value = captured.value.filter((p) => p.id !== id)
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
      pages[pageIndex] = { ...target, ocrText: result.text }
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

function exportPdf(): void {
  if (captured.value.length === 0) return
  try {
    const pdf = new jsPDF({
      unit: 'mm',
      format: 'a4',
      orientation: 'portrait',
    })
    const mmWidth = pdf.internal.pageSize.getWidth()
    const mmHeight = pdf.internal.pageSize.getHeight()

    captured.value.forEach((page, i) => {
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
    })

    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    pdf.save(`astarscan-${ts}.pdf`)
  } catch (err) {
    showTransientError(
      err instanceof Error ? err.message : 'PDF の生成に失敗しました',
    )
  }
}

function showTransientError(msg: string): void {
  errorText.value = msg
  window.setTimeout(() => {
    errorText.value = null
  }, 3000)
}

// --------------------------------------------------------------------------
// Teardown
// --------------------------------------------------------------------------

onBeforeUnmount(() => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (notificationTimeoutId !== null) {
    window.clearTimeout(notificationTimeoutId)
    notificationTimeoutId = null
  }
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  backend?.dispose()
  backend = null
  motionDetector = null
  lastQuad = null
  disposeOcr()
  detectionWorkCanvas = null
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
      <video
        ref="videoRef"
        class="viewport__video"
        playsinline
        muted
        autoplay
      />
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
          role="status"
        >
          <img
            :src="notification.dataUrl"
            :alt="`ページ ${notification.pageNumber}`"
            class="notify__thumb"
          />
          <div class="notify__body">
            <span class="notify__title">✓ キャプチャしました</span>
            <span class="notify__subtitle"
              >ページ {{ notification.pageNumber }}</span
            >
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
        @click="startOcr(idx)"
      >
        <img :src="page.dataUrl" :alt="`ページ ${idx + 1}`" />
        <span class="strip__num">{{ idx + 1 }}</span>
        <span v-if="page.ocrText" class="strip__ocr-badge">OCR</span>
        <button
          class="strip__remove"
          type="button"
          :aria-label="`ページ ${idx + 1} を削除`"
          @click="removePage(page.id)"
        >
          ×
        </button>
      </div>
    </div>

    <footer class="controls">
      <button
        v-if="phase === 'idle' || phase === 'error'"
        class="btn btn--primary btn--full"
        type="button"
        @click="start"
      >
        {{ phase === 'idle' ? 'スキャンを開始' : '再試行' }}
      </button>

      <template v-else>
        <button
          class="btn btn--secondary"
          type="button"
          :disabled="phase !== 'ready'"
          @click="tryCapture({ auto: false })"
        >
          手動で撮影
        </button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="captured.length === 0"
          @click="exportPdf"
        >
          PDF 出力 ({{ captured.length }})
        </button>
      </template>
    </footer>

    <div v-if="errorText && phase === 'ready'" class="toast" role="alert">
      {{ errorText }}
    </div>

    <div v-if="ocrLoading" class="toast toast--info" role="status">
      {{ ocrProgress }}
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
  </main>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
  background: #000;
  color: #f1f5f9;
  font-family:
    'Hiragino Sans',
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic UI',
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
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  z-index: 10;
}

.app__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.app__status {
  font-size: 0.75rem;
  color: #94a3b8;
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
}

.viewport__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}

.splash {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  background: linear-gradient(
    180deg,
    rgba(15, 23, 42, 0.96) 0%,
    rgba(2, 6, 23, 0.98) 100%
  );
  text-align: center;
  z-index: 5;
}

.splash__title {
  margin: 0 0 1rem;
  font-size: 1.5rem;
  font-weight: 700;
  color: #f1f5f9;
}

.splash__tagline {
  margin: 0 0 2rem;
  font-size: 0.9375rem;
  line-height: 1.7;
  color: #cbd5e1;
}

.splash__privacy {
  margin: 0;
  font-size: 0.75rem;
  color: #64748b;
  max-width: 20rem;
  line-height: 1.6;
}

.splash--error {
  background: linear-gradient(
    180deg,
    rgba(127, 29, 29, 0.9) 0%,
    rgba(69, 10, 10, 0.98) 100%
  );
}

.splash__error {
  margin: 0;
  font-size: 1rem;
  color: #fecaca;
  font-weight: 500;
  max-width: 24rem;
  line-height: 1.6;
}

.spinner {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.08);
  border-top-color: #60a5fa;
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
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid rgba(96, 165, 250, 0.4);
  border-radius: 0.75rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  max-width: calc(100% - 2rem);
  z-index: 15;
}

.notify__thumb {
  width: 2.75rem;
  height: 3.5rem;
  object-fit: cover;
  border-radius: 0.375rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
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
  color: #86efac;
}

.notify__subtitle {
  font-size: 0.6875rem;
  color: #94a3b8;
}

.notify-enter-active,
.notify-leave-active {
  transition:
    transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1.2),
    opacity 0.25s ease;
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

.strip {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  overflow-x: auto;
  overflow-y: hidden;
  background: rgba(15, 23, 42, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
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
  border: 2px solid rgba(255, 255, 255, 0.15);
  background: #1e293b;
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
  background: rgba(0, 0, 0, 0.75);
  border-radius: 0.25rem;
  font-size: 0.625rem;
  font-weight: 600;
  color: #f1f5f9;
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

.strip__thumb--ocr {
  border-color: rgba(96, 165, 250, 0.6);
}

.strip__ocr-badge {
  position: absolute;
  bottom: 0.125rem;
  left: 0.125rem;
  right: 0.125rem;
  padding: 0.0625rem 0;
  background: rgba(96, 165, 250, 0.9);
  color: #fff;
  border-radius: 0.1875rem;
  font-size: 0.5rem;
  font-weight: 700;
  text-align: center;
}

.toast--info {
  background: rgba(15, 23, 42, 0.95);
  color: #93c5fd;
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
  transition: transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}
.sheet-enter-from > *,
.sheet-leave-to > * {
  transform: translateY(100%);
}

.controls {
  display: flex;
  gap: 0.75rem;
  padding: 1rem;
  padding-bottom: calc(1rem + env(safe-area-inset-bottom));
  background: rgba(15, 23, 42, 0.9);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.btn {
  flex: 1;
  padding: 1rem;
  border: none;
  border-radius: 0.875rem;
  font-size: 1rem;
  font-weight: 600;
  color: #f1f5f9;
  cursor: pointer;
  transition:
    transform 0.1s ease,
    opacity 0.2s ease;
  font-family: inherit;
}

.btn--full {
  flex: 1 1 100%;
}

.btn--primary {
  background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%);
  box-shadow: 0 4px 16px rgba(99, 102, 241, 0.35);
}

.btn--secondary {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
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
  background: rgba(127, 29, 29, 0.95);
  color: #fecaca;
  border-radius: 0.75rem;
  font-size: 0.875rem;
  text-align: center;
  font-weight: 500;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: 20;
  animation: slideUp 0.2s ease;
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
