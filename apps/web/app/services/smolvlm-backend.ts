// @ts-nocheck — external library types are incomplete
/**
 * SmolVLM-256M document classifier backend.
 *
 * Uses HuggingFace Transformers.js to run SmolVLM-256M-Instruct in the
 * browser via WebGPU (with WASM fallback). The model classifies whether
 * a captured frame is a clear, fully-visible document page.
 *
 * Model: HuggingFaceTB/SmolVLM-256M-Instruct (~175MB quantized)
 * Speed: ~80 tok/s WebGPU on M4 Max, slower on WASM
 *
 * This is the browser implementation of DocumentClassifierBackend.
 * Future: GemmaE2bBackend (native, llama.cpp) for Tauri Mobile.
 */

import type { DocumentClassifierResult } from '@astarworks/scan-core'

const MODEL_ID = 'HuggingFaceTB/SmolVLM-256M-Instruct'

const CLASSIFY_PROMPT =
  'Look at this image. Is it a clear, fully-visible document or paper page? ' +
  'Consider: Is a document present? Is it fully visible (not covered by a hand)? ' +
  'Is it a document (not just a table or desk)? ' +
  'Reply with exactly one word: YES or NO.'

// Dynamic import to avoid loading Transformers.js until needed
type Pipeline = Awaited<
  ReturnType<typeof import('@huggingface/transformers').then>
>['pipeline']

let pipelineFn: Pipeline | null = null
let pipe: Awaited<ReturnType<Pipeline>> | null = null
let loading = false

/**
 * Check if the classifier is loaded and ready.
 */
export function isClassifierReady(): boolean {
  return pipe !== null
}

/**
 * Initialize the SmolVLM-256M classifier. Downloads ~175MB on first call,
 * cached by the browser afterwards. Safe to call multiple times.
 */
export async function initClassifier(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (pipe || loading) return
  loading = true

  try {
    onProgress?.('VLM モデル読み込み中 (~175MB、初回のみ)...')

    // Dynamic import to code-split Transformers.js
    const { pipeline, env } = await import('@huggingface/transformers')

    // Configure for browser
    env.backends.onnx.wasm.proxy = true

    // Per-module dtype for smallest download (~189MB total):
    // embed_tokens at fp16, vision+decoder at q4f16
    const dtype = {
      embed_tokens: 'fp16',
      vision_encoder: 'q4f16',
      decoder_model_merged: 'q4f16',
    }

    // Detect WebGPU safely (Android Chrome may crash on shader-f16)
    let device: 'webgpu' | 'wasm' = 'wasm'
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const adapter = await navigator.gpu?.requestAdapter()
        if (adapter) device = 'webgpu'
      } catch {
        // WebGPU not available
      }
    }

    pipelineFn = pipeline
    pipe = await pipeline('image-text-to-text', MODEL_ID, { dtype, device })

    onProgress?.(`VLM モデル準備完了 (${device})`)
  } catch (err) {
    // Fallback to WASM if WebGPU failed
    if (pipelineFn) {
      try {
        onProgress?.('フォールバック: WASM で再試行中...')
        pipe = await pipelineFn('image-text-to-text', MODEL_ID, {
          dtype: {
            embed_tokens: 'fp16',
            vision_encoder: 'q4f16',
            decoder_model_merged: 'q4f16',
          },
          device: 'wasm',
        })
        onProgress?.('VLM モデル準備完了 (WASM)')
      } catch {
        throw new Error(`VLM の初期化に失敗しました: ${err}`)
      }
    } else {
      throw new Error(`VLM の初期化に失敗しました: ${err}`)
    }
  } finally {
    loading = false
  }
}

/**
 * Classify a single captured frame as document or non-document.
 */
export async function classifyFrame(
  dataUrl: string,
): Promise<DocumentClassifierResult> {
  if (!pipe) {
    await initClassifier()
  }
  if (!pipe) {
    return { isDocument: true, confidence: 0 } // fail-open
  }

  try {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, image: dataUrl },
          { type: 'text' as const, text: CLASSIFY_PROMPT },
        ],
      },
    ]

    const result = await pipe(messages, { max_new_tokens: 5 })
    const text =
      Array.isArray(result) && result[0]?.generated_text
        ? String(result[0].generated_text)
        : String(result)

    const upperText = text.toUpperCase().trim()
    const isYes = upperText.includes('YES')
    const isNo = upperText.includes('NO')

    if (isNo) {
      // Try to determine reason from context
      const lowerText = text.toLowerCase()
      let reason: DocumentClassifierResult['reason'] = 'not_document'
      if (lowerText.includes('hand') || lowerText.includes('finger')) {
        reason = 'hand_occlusion'
      } else if (lowerText.includes('partial') || lowerText.includes('cover')) {
        reason = 'partial'
      }
      return { isDocument: false, confidence: 0.8, reason }
    }

    if (isYes) {
      return { isDocument: true, confidence: 0.8 }
    }

    // Ambiguous response — fail-open (accept the frame)
    return { isDocument: true, confidence: 0.3 }
  } catch {
    // Classification failed — fail-open
    return { isDocument: true, confidence: 0 }
  }
}

/**
 * Classify multiple frames in batch. Returns results in the same order.
 */
export async function classifyBatch(
  pages: Array<{ dataUrl: string }>,
  onProgress?: (msg: string) => void,
): Promise<DocumentClassifierResult[]> {
  if (!pipe) {
    await initClassifier(onProgress)
  }

  const results: DocumentClassifierResult[] = []
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(`書類判定中... ${i + 1}/${pages.length}`)
    results.push(await classifyFrame(pages[i]!.dataUrl))
  }
  return results
}

/**
 * Release the model.
 */
export function disposeClassifier(): void {
  pipe = null
  pipelineFn = null
}
