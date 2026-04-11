<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import jsPDF from 'jspdf'

import type { EdgeDetectorBackend, Quad } from '@astarworks/scan-core'
import { JscanifyBackend } from '~/services/jscanify-backend'
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
}

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// Target resolution for the perspective-corrected output. A4-ish aspect.
const EXTRACT_WIDTH = 1200
const EXTRACT_HEIGHT = 1600

// Async detection runs every N RAF frames. At 60 FPS display that's
// ~15 FPS detection — responsive enough for the outline to feel live
// without saturating the CPU. Detection is fire-and-forget; the loop
// just renders the most recent known quad until a new one arrives.
const DETECTION_EVERY_N_FRAMES = 4

// --------------------------------------------------------------------------
// Reactive state
// --------------------------------------------------------------------------

const videoRef = ref<HTMLVideoElement | null>(null)
const overlayRef = ref<HTMLCanvasElement | null>(null)
const phase = ref<Phase>('idle')
const statusText = ref<string>('')
const errorText = ref<string | null>(null)
const captured = ref<CapturedPage[]>([])

// --------------------------------------------------------------------------
// Non-reactive handles (these don't need Vue reactivity, and making them
// refs would create proxy wrappers around objects that don't tolerate it)
// --------------------------------------------------------------------------

let backend: EdgeDetectorBackend | null = null
let stream: MediaStream | null = null
let rafId: number | null = null
let detectionTick = 0

// Async detection state: RAF draws `lastQuad` on every frame, a throttled
// tick kicks off `backend.detect()`, and the resolved quad updates
// `lastQuad` without blocking the loop.
let lastQuad: Quad | null = null
let detectionInFlight = false
let detectionWorkCanvas: HTMLCanvasElement | null = null

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
// Async detection loop — renders the quad overlay on every frame, kicks
// off detection every DETECTION_EVERY_N_FRAMES without awaiting.
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
): void {
  ctx.fillStyle = 'rgba(96, 165, 250, 0.18)'
  ctx.strokeStyle = 'rgba(96, 165, 250, 0.95)'
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

  const loop = () => {
    rafId = requestAnimationFrame(loop)
    if (video.readyState < 2 || video.videoWidth === 0) return

    // Keep the overlay canvas's internal resolution matched to the
    // video source; CSS scales it to the display size.
    if (overlay.width !== video.videoWidth) {
      overlay.width = video.videoWidth
      overlay.height = video.videoHeight
    }

    ctx.clearRect(0, 0, overlay.width, overlay.height)
    if (lastQuad) {
      drawQuadOverlay(ctx, lastQuad, overlay.width)
    }

    detectionTick += 1
    if (detectionTick % DETECTION_EVERY_N_FRAMES !== 0) return
    if (detectionInFlight) return

    const currentBackend = backend
    if (!currentBackend) return
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
  loop()
}

// --------------------------------------------------------------------------
// Start / stop orchestration
// --------------------------------------------------------------------------

async function start(): Promise<void> {
  phase.value = 'loading'
  errorText.value = null
  try {
    statusText.value = 'スキャナー初期化中 (初回のみ、数秒)...'
    const newBackend = new JscanifyBackend()
    await newBackend.warmUp()
    backend = newBackend

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

async function capture(): Promise<void> {
  const video = videoRef.value
  const currentBackend = backend
  if (!video || !currentBackend || phase.value !== 'ready') return

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
    showTransientError(
      '書類を検出できませんでした。画面内に収めてもう一度撮影してください。',
    )
    return
  }

  try {
    const extracted = warpPerspective(work, quad, EXTRACT_WIDTH, EXTRACT_HEIGHT)
    captured.value = [
      ...captured.value,
      {
        id: crypto.randomUUID(),
        dataUrl: extracted.toDataURL('image/jpeg', 0.85),
        width: extracted.width,
        height: extracted.height,
      },
    ]
  } catch (err) {
    showTransientError(
      err instanceof Error ? err.message : '書類の切り出しに失敗しました',
    )
  }
}

function removePage(id: string): void {
  captured.value = captured.value.filter((p) => p.id !== id)
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
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  backend?.dispose()
  backend = null
  lastQuad = null
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
          スマホを書類に向けて撮影するだけ。<br />
          ページごとに検出・補正して PDF にまとめます。
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
    </section>

    <div v-if="captured.length > 0" class="strip">
      <div v-for="(page, idx) in captured" :key="page.id" class="strip__thumb">
        <img :src="page.dataUrl" :alt="`ページ ${idx + 1}`" />
        <span class="strip__num">{{ idx + 1 }}</span>
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
          class="btn btn--primary"
          type="button"
          :disabled="phase !== 'ready'"
          @click="capture"
        >
          撮影
        </button>
        <button
          class="btn btn--secondary"
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
  /* Visible: the raw camera stream is shown directly for smooth playback;
     the overlay canvas on top draws only the detected quad. */
}

.viewport__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
  /* Transparent background — only the quad polygon is rendered. */
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
