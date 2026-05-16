/**
 * LLM-based best-frame selection per track.
 *
 * The ByteTrack pipeline keeps the top-K candidate frames per identity by
 * a numerical composite score (Laplacian × confidence × area_fraction).
 * That score is a proxy for sharpness, not for "human-judged readability"
 * — sometimes the sharpest frame has hand occlusion, glare, or a partial
 * crop that a human (or an LLM) would dismiss.
 *
 * This module sends the K candidate JPEGs to Gemma 4 E2B and asks which
 * is the best to OCR. Used only in the WebGPU extraction path (so Gemma 4
 * is already loaded and the marginal cost is small).
 *
 * Output: 0-indexed pick into the input array. Falls back to 0 (highest-
 * score candidate) on any LLM error or parse failure.
 */

import { ensureLlmReady, type LlmProgressCallback } from './llm-extractor-gemma'

// We re-use the same Gemma 4 state managed in llm-extractor-gemma.ts.
// To avoid duplicating the transformers.js wiring, we import the
// already-initialised processor/model through a small shim.
import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  load_image,
} from '@huggingface/transformers'

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _processor: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _model: any = null

async function getInstances(): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processor: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any
}> {
  await ensureLlmReady()
  if (!_processor) {
    _processor = await AutoProcessor.from_pretrained(MODEL_ID)
  }
  if (!_model) {
    _model = await Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, {
      dtype: 'q4f16',
      device: 'webgpu',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
  }
  return { processor: _processor, model: _model }
}

export interface FrameCandidate {
  readonly id: string
  readonly imageDataUrl: string
  readonly score: number
}

export interface PickResult {
  readonly pickedIndex: number
  readonly reasoning?: string
  readonly duration_ms: number
}

const PROMPT_HEADER = `これらは同じ名刺を連続撮影した候補画像です。最も読みやすい (テキストが鮮明、手の遮蔽がない、グレアがない) 1 枚を選んでください。回答は数字 1 文字のみ — 候補の 0-indexed の番号です。`

/**
 * Pick the best frame among K candidates using Gemma 4 vision.
 * Falls back to index 0 (highest-score) on any failure.
 */
export async function pickBestFrameByLlm(
  candidates: readonly FrameCandidate[],
  onProgress?: LlmProgressCallback,
): Promise<PickResult> {
  if (candidates.length <= 1) {
    return { pickedIndex: 0, duration_ms: 0 }
  }

  const t0 = performance.now()
  try {
    const { processor, model } = await getInstances()
    onProgress?.({ stage: 'inference' })

    const labelLines = candidates
      .map((_, i) => `${i}: (候補 ${i + 1})`)
      .join('\n')

    const content: Array<{ type: 'image' } | { type: 'text'; text: string }> = []
    for (const _ of candidates) content.push({ type: 'image' })
    content.push({
      type: 'text',
      text: `${PROMPT_HEADER}\n\n候補:\n${labelLines}\n\n最も読みやすい候補の番号 (0..${candidates.length - 1}):`,
    })

    const messages = [{ role: 'user', content }]
    const prompt = processor.apply_chat_template(messages, {
      add_generation_prompt: true,
    })

    const images = []
    for (const c of candidates) {
      images.push(await load_image(c.imageDataUrl))
    }

    const inputs = await processor(prompt, images, null, {
      add_special_tokens: false,
    })
    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: 8,
      do_sample: false,
    })
    const promptLen = inputs.input_ids.dims[1]
    const generated = outputs.slice(null, [promptLen, null])
    const raw = processor.batch_decode(generated, { skip_special_tokens: true })[0] as string

    // Parse the first digit in the response
    const m = raw.match(/\d/)
    let pickedIndex = 0
    if (m) {
      const idx = Number(m[0])
      if (idx >= 0 && idx < candidates.length) pickedIndex = idx
    }
    return {
      pickedIndex,
      reasoning: raw.trim(),
      duration_ms: performance.now() - t0,
    }
  } catch (err) {
    console.warn('[llm-best-frame] failed, falling back to score-best', err)
    return { pickedIndex: 0, duration_ms: performance.now() - t0 }
  }
}
