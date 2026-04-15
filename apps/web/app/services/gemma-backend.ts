/**
 * Gemma 4 E2B document classifier backend (Tauri Mobile native).
 *
 * Uses Google's LiteRT-LM via a Tauri Kotlin plugin on Android.
 * Falls back to SmolVLM (browser) when not running in Tauri.
 *
 * Model: google/gemma-4-E2B-it (2.58GB LiteRT-LM format)
 * Speed: 20-35 tok/s on Snapdragon 8 Gen 3
 * Min device: 6GB RAM, Android 2022+
 */

import type {
  DocumentClassifierBackend,
  DocumentClassifierResult,
} from '@astarworks/scan-core'

/**
 * Check if running inside Tauri (mobile or desktop).
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

export class GemmaE2bBackend implements DocumentClassifierBackend {
  readonly name = 'gemma-4-e2b'
  #ready = false

  get ready() {
    return this.#ready
  }

  async warmUp(onProgress?: (progress: number) => void): Promise<void> {
    if (!isTauri()) {
      throw new Error('Gemma 4 E2B requires Tauri Mobile runtime')
    }

    const { invoke } = await import('@tauri-apps/api/core')
    onProgress?.(0)

    // Check if model is already downloaded
    const status = (await invoke('plugin:gemma|status')) as {
      downloaded: boolean
      modelPath: string
    }

    if (!status.downloaded) {
      // Trigger download with progress callback
      onProgress?.(10)
      await invoke('plugin:gemma|downloadModel')
      onProgress?.(80)
    }

    // Load model into GPU memory (~10s)
    await invoke('plugin:gemma|loadModel', { path: status.modelPath })
    onProgress?.(100)
    this.#ready = true
  }

  async classify(frame: HTMLCanvasElement): Promise<DocumentClassifierResult> {
    if (!isTauri()) {
      return { isDocument: true, confidence: 0 } // fail-open
    }

    const { invoke } = await import('@tauri-apps/api/core')
    const dataUrl = frame.toDataURL('image/jpeg', 0.8)

    const result = (await invoke('plugin:gemma|classify', {
      imageData: dataUrl,
      prompt:
        'Is this image a clear, fully-visible document page? Answer only YES or NO.',
    })) as { answer: string }

    const answer = result.answer.toUpperCase().trim()
    const isYes = answer.includes('YES')

    return {
      isDocument: isYes,
      confidence: 0.9,
      reason: isYes ? undefined : 'not_document',
    }
  }

  dispose(): void {
    if (!isTauri()) return
    import('@tauri-apps/api/core').then(({ invoke }) => {
      void invoke('plugin:gemma|dispose')
    })
    this.#ready = false
  }
}

/**
 * Auto-select the best available classifier backend.
 * Tauri Native → Gemma 4 E2B, Browser → SmolVLM-256M
 */
export async function createClassifierBackend(): Promise<DocumentClassifierBackend> {
  if (isTauri()) {
    try {
      const backend = new GemmaE2bBackend()
      await backend.warmUp()
      return backend
    } catch {
      // Gemma not available — fall through to SmolVLM
    }
  }

  // Browser fallback: SmolVLM-256M via Transformers.js
  // Import dynamically to avoid loading in Tauri
  const { classifyBatch, initClassifier, disposeClassifier } =
    await import('./smolvlm-backend')
  return {
    name: 'smolvlm-256m',
    ready: false,
    async warmUp(onProgress) {
      await initClassifier((msg) =>
        onProgress?.(msg === 'VLM モデル準備完了' ? 100 : 50),
      )
      ;(this as { ready: boolean }).ready = true
    },
    async classify(frame) {
      const dataUrl = frame.toDataURL('image/jpeg', 0.8)
      const results = await classifyBatch([{ dataUrl }])
      return results[0] ?? { isDocument: true, confidence: 0 }
    },
    dispose() {
      disposeClassifier()
    },
  }
}
