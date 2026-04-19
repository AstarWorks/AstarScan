<script setup lang="ts">
/**
 * AstarScan — minimal document scanner.
 *
 * Pipeline (4 stages, strictly linear):
 *   1. Sample video / camera frame every SAMPLE_INTERVAL_S
 *   2. detectDocumentQuad → 4 corner Quad via Otsu + minAreaRect, null if none
 *   3. warpPerspective → cropped rectangular canvas
 *   4. pHash dedup → skip if same page already captured
 *
 * Intentionally removed vs. the previous implementation:
 *   - jscanify / Canny fallback cascades (one detector only)
 *   - Gemma4 / SmolVLM AI post-filter (trust the detector)
 *   - best-of-N sharpness replacement
 *   - autoCrop / CLAHE / deskew / A4-normalize post-processing
 *   - Streaming AI during capture
 * If detection misses, we accept that as a signal to swap the detector,
 * not as a reason to layer more stages on top of it.
 */

import { ref, computed, onMounted } from 'vue'
import jsPDF from 'jspdf'

import { detectDocumentQuad } from '~/services/doc-detector'
import { loadOpenCV } from '~/services/opencv-loader'
import { warpPerspective } from '~/services/perspective-warper'
import { computePHash, PHashDedupManager } from '~/services/phash-dedup'
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
const SAMPLE_INTERVAL_S = 0.5

type Phase = 'idle' | 'loading' | 'scanning' | 'done' | 'error'
const phase = ref<Phase>('idle')
const statusText = ref('')
const errorText = ref('')
const captured = ref<Page[]>([])
const pdfExporting = ref(false)
const stripOpen = ref(false)

const videoRef = ref<HTMLVideoElement | null>(null)
const mediaStream = ref<MediaStream | null>(null)

let detectorReady = false
const dedup = new PHashDedupManager()

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
  statusText.value = 'OpenCV 初期化中 (初回のみ)...'
  await loadOpenCV()
  detectorReady = true
}

async function processFrame(video: HTMLVideoElement): Promise<boolean> {
  if (!detectorReady) return false
  if (video.readyState < 2 || video.videoWidth === 0) return false

  const work = document.createElement('canvas')
  work.width = video.videoWidth
  work.height = video.videoHeight
  work.getContext('2d')?.drawImage(video, 0, 0)

  const quad = detectDocumentQuad(work)
  if (!quad) return false

  const warped = warpPerspective(work, quad, EXTRACT_W, EXTRACT_H)
  const hash = computePHash(warped)
  if (dedup.isDuplicate(hash)) return false

  const id = crypto.randomUUID()
  dedup.addPage(id, hash)
  captured.value = [
    ...captured.value,
    {
      id,
      dataUrl: warped.toDataURL('image/jpeg', 0.85),
      width: warped.width,
      height: warped.height,
      capturedAt: Date.now(),
    },
  ]
  void saveSession(captured.value.map(pageToStored))
  return true
}

// ---------------------------------------------------------------------------
// Video-file mode
// ---------------------------------------------------------------------------

async function startFromFile(): Promise<void> {
  const file = await pickFile()
  if (!file) return

  phase.value = 'loading'
  errorText.value = ''
  try {
    await ensureDetector()
    const video = videoRef.value
    if (!video) throw new Error('ビデオ要素が見つかりません')

    const objectUrl = URL.createObjectURL(file)
    video.srcObject = null
    video.muted = true
    video.playsInline = true
    video.src = objectUrl
    await new Promise<void>((resolve, reject) => {
      video.oncanplay = () => resolve()
      video.onerror = () => reject(new Error('動画の読み込みに失敗しました'))
    })

    phase.value = 'scanning'
    dedup.clear()
    captured.value = []

    const duration = video.duration
    let lastSampleT = -999
    await video.play()

    await new Promise<void>((resolve) => {
      const step = async () => {
        if (video.ended) {
          resolve()
          return
        }
        if (video.currentTime - lastSampleT >= SAMPLE_INTERVAL_S) {
          lastSampleT = video.currentTime
          const pct = duration > 0
            ? Math.round((video.currentTime / duration) * 100)
            : 0
          statusText.value = `解析中 ${pct}% (${captured.value.length} 枚検出)`
          await processFrame(video)
        }
        if (!video.ended) video.requestVideoFrameCallback(step)
        else resolve()
      }
      video.requestVideoFrameCallback(step)
      video.onended = () => resolve()
    })

    URL.revokeObjectURL(objectUrl)
    phase.value = 'done'
    statusText.value = `完了: ${captured.value.length} 枚`
  } catch (err) {
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
    await ensureDetector()
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

    phase.value = 'scanning'
    statusText.value = '書類を映してください'
    dedup.clear()

    let lastSampleT = performance.now() - 10000
    const loop = async () => {
      if (phase.value !== 'scanning') return
      const now = performance.now()
      if (now - lastSampleT >= SAMPLE_INTERVAL_S * 1000) {
        lastSampleT = now
        const added = await processFrame(video)
        if (added) statusText.value = `検出 ${captured.value.length} 枚`
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

function stopCamera(): void {
  mediaStream.value?.getTracks().forEach((t) => t.stop())
  mediaStream.value = null
  const video = videoRef.value
  if (video) video.srcObject = null
  phase.value = captured.value.length > 0 ? 'done' : 'idle'
  statusText.value = ''
}

// ---------------------------------------------------------------------------
// Page list management
// ---------------------------------------------------------------------------

function removePage(id: string): void {
  captured.value = captured.value.filter((p) => p.id !== id)
  dedup.removePage(id)
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
  dedup.clear()
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
  flex: 0 0 4.5rem;
  aspect-ratio: 3 / 4;
  background: #0b1120;
  border-radius: 0.5rem;
  overflow: hidden;
}

.strip__thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
