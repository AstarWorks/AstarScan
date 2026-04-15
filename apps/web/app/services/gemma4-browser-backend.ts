// @ts-nocheck — external library types are incomplete
/**
 * Gemma 4 E2B document classifier — pure browser edge execution.
 *
 * Runs Google's Gemma 4 E2B (2.3B params) entirely in the browser via
 * WebGPU using @huggingface/transformers. No server required.
 *
 * Model: onnx-community/gemma-4-E2B-it-ONNX (q4f16, ~3.4GB)
 * Vision: Supported — vision_encoder included in ONNX export
 * Speed: ~40-180 tok/s on WebGPU (v4), ~2-5s per YES/NO answer
 * RAM: ~4-5GB
 *
 * Loaded lazily in background. Falls back to SmolVLM-256M or
 * heuristics if WebGPU unavailable or insufficient storage.
 */

import type { DocumentClassifierResult } from '@astarworks/scan-core'

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX'

const CLASSIFY_PROMPT =
  'Look at this image. Is it a clear, fully-visible document or paper page? ' +
  'Not a desk, hand, or blurry transition. Answer with exactly one word: YES or NO.'

// Minimum free storage to attempt Gemma 4 download (4GB)
const MIN_FREE_STORAGE_BYTES = 4 * 1024 * 1024 * 1024

let processor: Awaited<
  ReturnType<typeof import('@huggingface/transformers').then>
> extends { AutoProcessor: infer P }
  ? Awaited<ReturnType<P['from_pretrained']>>
  : unknown = null
let model: unknown = null
let loading = false
let available = false

/**
 * Check if the device has enough storage and WebGPU for Gemma 4.
 */
async function canRunGemma4(): Promise<boolean> {
  // Need WebGPU
  if (!('gpu' in navigator)) return false
  try {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) return false
  } catch {
    return false
  }

  // Need enough storage
  if (navigator.storage?.estimate) {
    const { quota = 0, usage = 0 } = await navigator.storage.estimate()
    if (quota - usage < MIN_FREE_STORAGE_BYTES) return false
  }

  return true
}

/**
 * Initialize Gemma 4 E2B in the background. Non-blocking — the model
 * downloads progressively and becomes available once ready.
 *
 * @returns true if initialization started, false if device can't run it
 */
export async function initGemma4Background(
  onProgress?: (msg: string) => void,
): Promise<boolean> {
  if (available || loading) return available

  const canRun = await canRunGemma4()
  if (!canRun) return false

  loading = true
  try {
    const { AutoProcessor, Gemma4ForConditionalGeneration } =
      await import('@huggingface/transformers')

    onProgress?.('Gemma 4 モデル読み込み中 (~3.4GB、初回のみ)...')

    processor = await AutoProcessor.from_pretrained(MODEL_ID, {
      progress_callback: (p: { progress?: number }) => {
        if (p.progress) {
          onProgress?.(`Gemma 4: ${Math.round(p.progress)}%`)
        }
      },
    })

    model = await Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, {
      dtype: 'q4f16',
      device: 'webgpu',
      progress_callback: (p: { progress?: number }) => {
        if (p.progress) {
          onProgress?.(`Gemma 4: ${Math.round(p.progress)}%`)
        }
      },
    })

    available = true
    onProgress?.('Gemma 4 準備完了')
    return true
  } catch (err) {
    console.warn('[gemma4] Failed to initialize:', err)
    return false
  } finally {
    loading = false
  }
}

/**
 * Check if Gemma 4 is loaded and ready for inference.
 */
export function isGemma4Ready(): boolean {
  return available && model !== null && processor !== null
}

/**
 * Classify a single frame as document or non-document using Gemma 4.
 */
export async function classifyWithGemma4(
  dataUrl: string,
): Promise<DocumentClassifierResult> {
  if (!available || !model || !processor) {
    return { isDocument: true, confidence: 0 } // fail-open
  }

  try {
    const { load_image } = await import('@huggingface/transformers')
    const image = await load_image(dataUrl)

    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const },
          { type: 'text' as const, text: CLASSIFY_PROMPT },
        ],
      },
    ]

    const proc = processor as {
      apply_chat_template: (
        msgs: unknown[],
        opts: Record<string, boolean>,
      ) => string;
      (text: string, images: unknown[]): Promise<Record<string, unknown>>
      batch_decode: (ids: unknown, opts: Record<string, boolean>) => string[]
    }
    const gen = model as {
      generate: (
        opts: Record<string, unknown>,
      ) => Promise<{ sequences?: unknown }>
    }

    const text = proc.apply_chat_template(messages, {
      add_generation_prompt: true,
    })
    const inputs = await proc(text, [image])

    const output = await gen.generate({
      ...inputs,
      max_new_tokens: 5,
      do_sample: false,
    })

    // Decode the generated tokens
    const sequences = output.sequences ?? output
    const decoded = proc.batch_decode(sequences, {
      skip_special_tokens: true,
    })

    const answer = (decoded[0] ?? '').toUpperCase().trim()
    const isYes = answer.includes('YES')
    const isNo = answer.includes('NO')

    if (isNo) {
      return { isDocument: false, confidence: 0.95, reason: 'not_document' }
    }
    if (isYes) {
      return { isDocument: true, confidence: 0.95 }
    }
    return { isDocument: true, confidence: 0.3 } // ambiguous → fail-open
  } catch (err) {
    console.warn('[gemma4] Classification failed:', err)
    return { isDocument: true, confidence: 0 } // fail-open
  }
}

/**
 * Release the model.
 */
export function disposeGemma4(): void {
  model = null
  processor = null
  available = false
}
