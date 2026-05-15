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

import { ref, computed } from 'vue'
import { processVideoBatch, type BatchItem, type BatchProgress } from '~/services/batch-pipeline'

const fileInput = ref<HTMLInputElement | null>(null)
const selectedFile = ref<File | null>(null)
const isProcessing = ref(false)
const progress = ref<BatchProgress | null>(null)
const items = ref<BatchItem[]>([])
const errorMessage = ref<string | null>(null)
let abortController: AbortController | null = null

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
      <h1>動画 → 名刺一括抽出</h1>
      <p class="subtitle">
        名刺を撮影した動画 (mp4) をアップロードすると、ユニークな名刺ごとに
        画像と連絡先情報を抽出します。すべてブラウザ内で処理されます。
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

    <section v-if="items.length > 0" class="results">
      <header class="results-header">
        <h2>抽出結果 ({{ items.length }} 件 / うち連絡先付き {{ validItemCount }} 件)</h2>
        <button class="primary" @click="downloadJson">JSON ダウンロード</button>
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
            <details v-if="item.fields.raw_text" class="raw">
              <summary>raw OCR text</summary>
              <pre>{{ item.fields.raw_text }}</pre>
            </details>
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
