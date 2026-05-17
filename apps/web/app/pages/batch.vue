<script setup lang="ts">
/**
 * /batch — upload a video of business cards filmed sequentially and run
 * the full extraction pipeline (detect → warp → OCR → field extract →
 * dedup) entirely in the browser. Output is a grid of unique cards with
 * downloadable JSON.
 *
 * The pipeline ports the Node CLI `scripts/eval/meishi.mjs` line-for-line
 * via `~/services/batch-pipeline.ts`. OCR uses the existing NDLOCR worker
 * wired up in `~/services/ocr-service.ts`. Detection uses DocAligner
 * FastViT (the same model as the camera /scan flow).
 */

import { ref, computed, onMounted, onUnmounted } from 'vue'
import jsPDF from 'jspdf'
import {
  processVideoBatch,
  type BatchItem,
  type BatchProgress,
  type ExtractorKind,
} from '~/services/batch-pipeline'

const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const isProcessing = ref(false)
const progress = ref<BatchProgress | null>(null)
const items = ref<BatchItem[]>([])
const errorMessage = ref<string | null>(null)
const extractor = ref<ExtractorKind>('classical')
const strictness = ref<'balanced' | 'permissive'>('balanced')
const selectedItem = ref<BatchItem | null>(null)
let abortController: AbortController | null = null

function openDetail(item: BatchItem) {
  console.log('[batch] openDetail', item.id)
  selectedItem.value = item
  // Scroll to top so the detail view is visible
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function closeDetail() {
  selectedItem.value = null
}
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && selectedItem.value) closeDetail()
}
onMounted(() => {
  window.addEventListener('keydown', onEsc)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onEsc)
})

const fileSizeLabel = computed(() => {
  if (!selectedFile.value) return ''
  const mb = selectedFile.value.size / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(mb * 1024).toFixed(0)} KB`
})

const progressPercent = computed(() => {
  if (!progress.value || progress.value.total === 0) return 0
  return Math.round((progress.value.current / progress.value.total) * 100)
})

const validItemCount = computed(() =>
  items.value.filter(
    (it) => it.fields.email || it.fields.tel || it.fields.mobile,
  ).length,
)

function onFilePick(e: Event) {
  const target = e.target as HTMLInputElement
  const file = target.files?.[0] ?? null
  selectedFile.value = file
  items.value = []
  progress.value = null
  errorMessage.value = null
}

async function startProcessing() {
  if (!selectedFile.value || isProcessing.value) return
  isProcessing.value = true
  errorMessage.value = null
  items.value = []
  abortController = new AbortController()
  try {
    const result = await processVideoBatch(selectedFile.value, {
      fps: 5,
      mode: 'auto',
      extractor: extractor.value,
      // permissive: drop the in-pipeline filter floors so more candidates
      // pass through; rely on LLM dedup (gemma-webgpu) or manual review.
      minLaplacian: strictness.value === 'permissive' ? 0 : 10,
      onProgress: (p) => {
        progress.value = p
      },
      signal: abortController.signal,
    })
    items.value = result
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err)
    console.error('[batch] processing failed', err)
  } finally {
    isProcessing.value = false
    abortController = null
  }
}

function cancelProcessing() {
  abortController?.abort()
}

/**
 * Generate a PDF with one card per page; each page sized to the card's
 * actual aspect ratio so landscape and portrait both display un-squashed.
 * Page size derived from the card's pixel dimensions at 96 DPI:
 *   pxToMm = 25.4 / 96 ≈ 0.2646
 * For a 1010×600 card → page = 267×159 mm (close to JIS card 91×55 ×3).
 * Caller can rescale if mm size feels off; aspect is preserved regardless.
 */
function downloadPdf() {
  if (items.value.length === 0) return
  const PX_TO_MM = 25.4 / 96 / 3  // /3 keeps page sizes reasonable (≈90×60 mm for a 1010×670 card)
  let pdf: jsPDF | null = null
  for (let i = 0; i < items.value.length; i++) {
    const it = items.value[i]
    if (!it) continue
    const wmm = Math.max(20, it.width * PX_TO_MM)
    const hmm = Math.max(20, it.height * PX_TO_MM)
    if (i === 0) {
      pdf = new jsPDF({
        orientation: wmm > hmm ? 'landscape' : 'portrait',
        unit: 'mm',
        format: [wmm, hmm],
      })
    } else {
      pdf!.addPage([wmm, hmm], wmm > hmm ? 'landscape' : 'portrait')
    }
    pdf!.addImage(it.imageDataUrl, 'JPEG', 0, 0, wmm, hmm)
  }
  if (!pdf) return
  const base = selectedFile.value?.name?.replace(/\.[^.]+$/, '') ?? 'cards'
  pdf.save(`${base}.pdf`)
}

function downloadJson() {
  const payload = {
    source: selectedFile.value?.name ?? null,
    count: items.value.length,
    valid_contact_count: validItemCount.value,
    items: items.value.map((it) => ({
      id: it.id,
      mode: it.mode,
      source_ts_ms: it.source_ts_ms,
      source_frame_idx: it.source_frame_idx,
      laplacian: Math.round(it.laplacian),
      detector_confidence: Number(it.detector_confidence.toFixed(3)),
      canonical_key: it.canonical_key,
      dedup_dropped: it.dedup_dropped,
      fields: it.fields,
    })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${selectedFile.value?.name?.replace(/\.[^.]+$/, '') ?? 'cards'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

const stageLabel = computed(() => {
  if (!progress.value) return ''
  const map: Record<BatchProgress['stage'], string> = {
    'frame-extract': 'フレーム抽出',
    detect: '検出',
    ocr: 'OCR 解析',
    'llm-load': 'LLM model 読込中',
    'llm-extract': 'LLM 抽出',
    extract: 'フィールド抽出',
    dedup: '重複除去',
    done: '完了',
  }
  return map[progress.value.stage]
})
</script>

<template>
  <div class="batch-page">
    <header class="page-header">
      <h1>動画 → 名刺一括抽出 <small style="color:#888;font-size:0.7rem">v2d</small></h1>
      <p class="subtitle">
        名刺を撮影した動画 (mp4) をアップロードすると、ユニークな名刺ごとに
        画像と連絡先情報を抽出します。すべてブラウザ内で処理されます。
        カードをクリックまたは「詳細を見る」ボタンで詳細画面に切り替わります。
      </p>
    </header>

    <section class="upload">
      <input
        ref="fileInput"
        type="file"
        accept="video/mp4,video/quicktime,video/*"
        :disabled="isProcessing"
        @change="onFilePick"
      />
      <div v-if="selectedFile" class="file-info">
        <strong>{{ selectedFile.name }}</strong>
        <span class="size">{{ fileSizeLabel }}</span>
      </div>
      <fieldset class="extractor-pick" :disabled="isProcessing">
        <legend>抽出 model:</legend>
        <label>
          <input v-model="extractor" type="radio" value="classical" />
          NDLOCR + heuristic (軽量 / 全端末)
        </label>
        <label>
          <input v-model="extractor" type="radio" value="gemma-webgpu" />
          Gemma 4 E2B (WebGPU 必須 / 初回 ~3 GB DL / 高精度 / LLM validator + dedup)
        </label>
      </fieldset>
      <fieldset class="extractor-pick" :disabled="isProcessing">
        <legend>抽出強度:</legend>
        <label>
          <input v-model="strictness" type="radio" value="balanced" />
          balanced (default)
        </label>
        <label>
          <input v-model="strictness" type="radio" value="permissive" />
          permissive (もっと取る、Gemma 4 で dedup 推奨)
        </label>
      </fieldset>
      <div class="controls">
        <button
          v-if="!isProcessing"
          :disabled="!selectedFile"
          class="primary"
          @click="startProcessing"
        >
          抽出を開始
        </button>
        <button v-else class="danger" @click="cancelProcessing">中断</button>
      </div>
    </section>

    <section v-if="progress" class="progress">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: `${progressPercent}%` }" />
      </div>
      <div class="progress-label">
        <span>{{ stageLabel }}</span>
        <span>{{ progress.current }} / {{ progress.total }}</span>
      </div>
      <div v-if="progress.note" class="progress-note">{{ progress.note }}</div>
    </section>

    <section v-if="errorMessage" class="error">
      エラー: {{ errorMessage }}
    </section>

    <section v-if="selectedItem" class="detail-view">
      <header class="detail-header">
        <button class="back-btn" @click="closeDetail">← 一覧に戻る</button>
        <h2>{{ selectedItem.id }} <span class="mode" :class="`mode-${selectedItem.mode}`">{{ selectedItem.mode }}</span></h2>
        <small>
          frame={{ selectedItem.source_frame_idx }}
          | t={{ (selectedItem.source_ts_ms / 1000).toFixed(1) }}s
          | lap={{ Math.round(selectedItem.laplacian) }}
          | conf={{ selectedItem.detector_confidence.toFixed(3) }}
          | {{ selectedItem.width }}×{{ selectedItem.height }}px
        </small>
      </header>
      <div class="detail-body">
        <img :src="selectedItem.imageDataUrl" :alt="selectedItem.id" class="detail-image"/>
        <table class="detail-fields">
          <tbody>
            <tr v-for="(v, k) in selectedItem.fields" :key="k">
              <th>{{ k }}</th>
              <td>
                <span v-if="Array.isArray(v)">{{ v.join(', ') || '—' }}</span>
                <pre v-else-if="k === 'raw_text'">{{ v || '—' }}</pre>
                <span v-else>{{ v ?? '—' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-else-if="items.length > 0" class="results">
      <header class="results-header">
        <h2>抽出結果 ({{ items.length }} 件 / うち連絡先付き {{ validItemCount }} 件)</h2>
        <div class="download-buttons">
          <button class="primary" @click="downloadJson">JSON</button>
          <button class="primary" @click="downloadPdf">PDF</button>
        </div>
      </header>

      <div class="card-grid">
        <article
          v-for="item in items"
          :key="item.id"
          class="card"
          :class="{
            'card--valid': !!(item.fields.email || item.fields.tel || item.fields.mobile),
            'card--mode-card': item.mode === 'card',
            'card--mode-a4': item.mode === 'a4',
            'card--mode-receipt': item.mode === 'receipt',
          }"
          @click="openDetail(item)"
          @keydown.enter="openDetail(item)"
          tabindex="0"
          role="button"
        >
          <img :src="item.thumbnailDataUrl" :alt="item.id" loading="lazy" />
          <div class="card-body">
            <div class="card-head">
              <span class="mode">{{ item.mode }}</span>
              <span class="ts">t={{ (item.source_ts_ms / 1000).toFixed(1) }}s</span>
            </div>
            <table class="fields">
              <tbody>
                <tr v-if="item.fields.name">
                  <th>name</th>
                  <td>{{ item.fields.name }}</td>
                </tr>
                <tr v-if="item.fields.company">
                  <th>company</th>
                  <td>{{ item.fields.company }}</td>
                </tr>
                <tr v-if="item.fields.title">
                  <th>title</th>
                  <td>{{ item.fields.title }}</td>
                </tr>
                <tr v-if="item.fields.department">
                  <th>dept</th>
                  <td>{{ item.fields.department }}</td>
                </tr>
                <tr v-if="item.fields.postal">
                  <th>postal</th>
                  <td>{{ item.fields.postal }}</td>
                </tr>
                <tr v-if="item.fields.address">
                  <th>address</th>
                  <td>{{ item.fields.address }}</td>
                </tr>
                <tr v-if="item.fields.tel">
                  <th>tel</th>
                  <td>{{ item.fields.tel }}</td>
                </tr>
                <tr v-if="item.fields.mobile">
                  <th>mobile</th>
                  <td>{{ item.fields.mobile }}</td>
                </tr>
                <tr v-if="item.fields.fax">
                  <th>fax</th>
                  <td>{{ item.fields.fax }}</td>
                </tr>
                <tr v-if="item.fields.email">
                  <th>email</th>
                  <td>{{ item.fields.email }}</td>
                </tr>
                <tr v-if="item.fields.url">
                  <th>url</th>
                  <td>{{ item.fields.url }}</td>
                </tr>
              </tbody>
            </table>
            <button class="card-detail-btn primary" @click.stop="openDetail(item)">
              詳細を見る →
            </button>
          </div>
        </article>
      </div>
    </section>

  </div>
</template>

<style scoped>
.batch-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
.page-header {
  margin-bottom: 24px;
}
.page-header h1 {
  font-size: 1.6rem;
  margin: 0 0 6px;
}
.subtitle {
  color: #666;
  font-size: 0.95rem;
  line-height: 1.5;
}
.upload {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: #f7f7f8;
  border-radius: 8px;
  margin-bottom: 16px;
}
.upload input[type='file'] {
  font-size: 0.95rem;
}
.file-info {
  display: flex;
  align-items: center;
  gap: 8px;
}
.file-info .size {
  color: #888;
  font-size: 0.85rem;
}
.controls {
  display: flex;
  gap: 8px;
}
button {
  font-size: 0.95rem;
  padding: 10px 20px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 600;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.primary {
  background: #001f42;
  color: white;
}
.primary:hover:not(:disabled) {
  background: #002a59;
}
.danger {
  background: #dc2626;
  color: white;
}
.progress {
  padding: 16px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 8px;
  margin-bottom: 16px;
}
.progress-bar {
  height: 6px;
  background: #eee;
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #001f42, #7c3aed);
  transition: width 0.2s ease-out;
}
.progress-label {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 0.9rem;
  color: #444;
}
.progress-note {
  margin-top: 4px;
  color: #888;
  font-size: 0.85rem;
}
.error {
  padding: 12px;
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
  border-radius: 6px;
  margin-bottom: 16px;
}
.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.results-header h2 {
  font-size: 1.15rem;
  margin: 0;
}
.download-buttons {
  display: flex;
  gap: 8px;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 16px;
}
.card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  cursor: pointer;
  transition: transform 0.1s ease, box-shadow 0.1s ease;
}
.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
.card:focus-visible {
  outline: 2px solid #001f42;
  outline-offset: 2px;
}
.card-detail-btn {
  margin-top: 12px;
  width: 100%;
  padding: 10px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
}

/* ---- Detail view (in-page, no overlay) ---- */
.detail-view {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 24px;
  margin-bottom: 16px;
}
.detail-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-bottom: 16px;
  border-bottom: 1px solid #eee;
  margin-bottom: 16px;
}
.detail-header h2 {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 1.25rem;
}
.detail-header small {
  color: #888;
  font-size: 0.85rem;
}
.back-btn {
  background: #f3f4f6;
  border: 1px solid #d1d5db;
  color: #001f42;
  padding: 8px 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
  width: max-content;
}
.back-btn:hover {
  background: #e5e7eb;
}
.detail-body {
  display: flex;
  gap: 24px;
}
.detail-image {
  flex: 1 1 60%;
  max-width: 60%;
  max-height: 80vh;
  object-fit: contain;
  background: #fafafa;
  border-radius: 6px;
}
.detail-fields {
  flex: 1 1 40%;
  min-width: 280px;
  border-collapse: collapse;
  font-size: 0.92rem;
  align-self: flex-start;
}
.detail-fields th {
  text-align: left;
  color: #666;
  font-weight: 500;
  padding: 6px 12px 6px 0;
  vertical-align: top;
  width: 110px;
  white-space: nowrap;
}
.detail-fields td {
  padding: 6px 0;
  word-break: break-word;
}
.detail-fields pre {
  background: #fafafa;
  padding: 10px;
  border-radius: 6px;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 0.82rem;
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid #eee;
}
@media (max-width: 800px) {
  .detail-body { flex-direction: column; }
  .detail-image, .detail-fields { max-width: 100%; flex: 0 0 auto; }
}
.card--valid {
  border-color: #10b981;
}
.card img {
  width: 100%;
  display: block;
  background: #fafafa;
  object-fit: contain;
  max-height: 260px;
}
.card-body {
  padding: 12px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  margin-bottom: 8px;
}
.mode {
  background: #eee;
  padding: 2px 8px;
  border-radius: 4px;
  color: #444;
}
.card--mode-card .mode { background: #e8f4ff; color: #2563eb; }
.card--mode-a4 .mode { background: #fff4e6; color: #b45309; }
.card--mode-receipt .mode { background: #f0fdf4; color: #15803d; }
.ts {
  color: #888;
}
.fields {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.85rem;
}
.fields th {
  text-align: left;
  color: #888;
  font-weight: 500;
  padding: 2px 8px 2px 0;
  vertical-align: top;
  width: 70px;
}
.fields td {
  padding: 2px 0;
  word-break: break-word;
}
.raw {
  margin-top: 8px;
}
.raw pre {
  background: #fafafa;
  padding: 8px;
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
  font-size: 0.78rem;
}
</style>
