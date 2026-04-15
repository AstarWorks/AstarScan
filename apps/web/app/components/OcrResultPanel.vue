<script setup lang="ts">
/**
 * OCR result display panel.
 *
 * Shows the recognized text from NDLOCR-Lite Web AI alongside (or below)
 * the scanned page image. Users can:
 * - Read the extracted text
 * - Copy to clipboard
 * - See per-line bounding boxes overlaid on the source image (future)
 *
 * Mounted inside a slide-up sheet or modal from the main scanner page.
 */

import { computed, ref } from 'vue'
import type { OcrResult } from '~/services/ocr-service'

const props = defineProps<{
  result: OcrResult | null
  pageImageUrl: string
  pageNumber: number
  loading: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const copied = ref(false)

const hasText = computed(
  () => props.result !== null && props.result.text.length > 0,
)

async function copyToClipboard(): Promise<void> {
  if (!props.result?.text) return
  try {
    await navigator.clipboard.writeText(props.result.text)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    // Clipboard API may fail in non-secure contexts or older browsers.
    // Silently ignore — the text is visible for manual selection.
  }
}
</script>

<template>
  <div class="ocr-panel">
    <header class="ocr-panel__header">
      <h2 class="ocr-panel__title">OCR 結果 — ページ {{ pageNumber }}</h2>
      <button
        class="ocr-panel__close"
        type="button"
        aria-label="閉じる"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <div class="ocr-panel__body">
      <div class="ocr-panel__image">
        <img :src="pageImageUrl" :alt="`ページ ${pageNumber}`" />
      </div>

      <div class="ocr-panel__text-area">
        <div v-if="loading" class="ocr-panel__loading">
          <div class="spinner" aria-hidden="true" />
          <span>テキスト認識中...</span>
        </div>

        <div v-else-if="hasText" class="ocr-panel__text">
          <pre class="ocr-panel__pre">{{ result!.text }}</pre>
          <div class="ocr-panel__meta">
            {{ result!.lines.length }} 行 /
            {{ Math.round(result!.durationMs) }}ms
          </div>
        </div>

        <div v-else class="ocr-panel__empty">
          テキストを検出できませんでした
        </div>
      </div>
    </div>

    <footer v-if="hasText" class="ocr-panel__footer">
      <button class="ocr-panel__copy" type="button" @click="copyToClipboard">
        {{ copied ? '✓ コピー済み' : 'テキストをコピー' }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.ocr-panel {
  display: flex;
  flex-direction: column;
  max-height: 80dvh;
  background: rgba(15, 23, 42, 0.98);
  border-radius: 1rem 1rem 0 0;
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

.ocr-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.ocr-panel__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.ocr-panel__close {
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: 0.5rem;
  background: rgba(255, 255, 255, 0.08);
  color: #94a3b8;
  font-size: 1.25rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ocr-panel__close:active {
  background: rgba(255, 255, 255, 0.15);
}

.ocr-panel__body {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

@media (max-width: 640px) {
  .ocr-panel__body {
    flex-direction: column;
  }
}

.ocr-panel__image {
  flex: 0 0 8rem;
}

.ocr-panel__image img {
  width: 100%;
  border-radius: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.ocr-panel__text-area {
  flex: 1;
  min-width: 0;
}

.ocr-panel__loading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: #94a3b8;
  font-size: 0.875rem;
}

.spinner {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.08);
  border-top-color: #60a5fa;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.ocr-panel__text {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ocr-panel__pre {
  margin: 0;
  padding: 0.75rem;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  color: #e2e8f0;
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', serif;
  max-height: 40dvh;
  overflow-y: auto;
}

.ocr-panel__meta {
  font-size: 0.6875rem;
  color: #64748b;
}

.ocr-panel__empty {
  color: #64748b;
  font-size: 0.875rem;
  padding: 2rem 0;
  text-align: center;
}

.ocr-panel__footer {
  padding: 0.75rem 1rem;
  padding-bottom: calc(0.75rem + env(safe-area-inset-bottom));
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.ocr-panel__copy {
  width: 100%;
  padding: 0.75rem;
  border: none;
  border-radius: 0.75rem;
  background: rgba(96, 165, 250, 0.15);
  color: #93c5fd;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.15s ease;
}

.ocr-panel__copy:active {
  background: rgba(96, 165, 250, 0.25);
}

/* Desktop overrides */
@media (min-width: 768px) {
  .ocr-panel {
    border-radius: 1rem;
  }

  .ocr-panel__image {
    flex: 0 0 12rem;
  }

  .ocr-panel__pre {
    font-size: 0.875rem;
    max-height: 50dvh;
  }

  .ocr-panel__footer {
    padding-bottom: 0.75rem;
  }

  .ocr-panel__copy {
    width: auto;
    min-width: 12rem;
    margin-left: auto;
  }

  .ocr-panel__copy:hover {
    background: rgba(96, 165, 250, 0.25);
  }
}
</style>
