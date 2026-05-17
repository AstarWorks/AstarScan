/**
 * LLM frame validator using Gemma 4 vision.
 *
 * Replaces "OCR-returned-zero-paragraphs → drop the frame" with a direct
 * visual judgment by Gemma 4. Use case: a low-contrast card where
 * NDLOCR returns nothing should still be kept if the LLM can see that
 * it's a legible card.
 *
 * Two judgments per image:
 *   - usable: is this a readable business card image at all?
 *     (drops gray frames, wood texture, severe blur, hand-only shots)
 *   - quality: 1-5 score for OCR/extraction suitability
 *     (used for best-frame selection within a track without needing
 *      OCR on all candidates first)
 *
 * Runs in WebGPU only (CPU latency was 600s/card in Phase 0d spike).
 * Caller must `ensureLlmReady()` from llm-extractor-gemma.ts before
 * relying on this module — the Gemma 4 model is shared.
 */

import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  load_image,
} from '@huggingface/transformers'

import { ensureLlmReady } from './llm-extractor-gemma'

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _processor: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _model: any = null

async function getInstances() {
  await ensureLlmReady()
  if (!_processor) _processor = await AutoProcessor.from_pretrained(MODEL_ID)
  if (!_model) {
    _model = await Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, {
      dtype: 'q4f16',
      device: 'webgpu',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }
  return { processor: _processor, model: _model }
}

export interface ValidationResult {
  readonly usable: boolean
  readonly quality: number       // 1..5
  readonly raw: string
  readonly duration_ms: number
}

const PROMPT = `この画像は日本語の名刺ですか? 文字が読み取れる状態ですか?
以下のいずれか 1 行で答えてください:
- "1": カードではない / 真っ白 / 完全にブレている / 真っ黒
- "2": カードに見えるが文字がほぼ読めない
- "3": 部分的に読める
- "4": ほとんど読める
- "5": 鮮明に読める

数字 1 文字のみで回答してください。`

/**
 * Score a single warped card image's usability for OCR/extraction.
 * Returns { usable: quality >= 2, quality: 1..5 }.
 *
 * On any error: { usable: true, quality: 3 } — fail-open to avoid
 * silently dropping items when the LLM hiccups.
 */
export async function validateFrame(
  imageDataUrl: string,
): Promise<ValidationResult> {
  const t0 = performance.now()
  try {
    const { processor, model } = await getInstances()
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image' },
          { type: 'text', text: PROMPT },
        ],
      },
    ]
    const prompt = processor.apply_chat_template(messages, {
      add_generation_prompt: true,
    })
    const img = await load_image(imageDataUrl)
    const inputs = await processor(prompt, img, null, {
      add_special_tokens: false,
    })
    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: 4,
      do_sample: false,
    })
    const promptLen = inputs.input_ids.dims[1]
    const generated = outputs.slice(null, [promptLen, null])
    const raw = processor.batch_decode(generated, {
      skip_special_tokens: true,
    })[0] as string
    const m = raw.match(/[1-5]/)
    const quality = m ? Number(m[0]) : 3
    return {
      usable: quality >= 2,
      quality,
      raw: raw.trim(),
      duration_ms: performance.now() - t0,
    }
  } catch (err) {
    console.warn('[llm-frame-validator] failed, fail-open:', err)
    return {
      usable: true,
      quality: 3,
      raw: String(err),
      duration_ms: performance.now() - t0,
    }
  }
}

/**
 * Score multiple frames at once and return them sorted by quality
 * desc. Convenient for best-frame selection across track candidates.
 */
export async function rankFrames(
  imageDataUrls: readonly string[],
): Promise<Array<ValidationResult & { index: number }>> {
  const results = []
  for (let i = 0; i < imageDataUrls.length; i++) {
    const r = await validateFrame(imageDataUrls[i]!)
    results.push({ ...r, index: i })
  }
  results.sort((a, b) => b.quality - a.quality)
  return results
}
