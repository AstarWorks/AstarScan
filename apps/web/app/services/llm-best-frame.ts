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
import { parseCoTAnswer } from './llm-parse-cot'

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
  readonly candidateCount: number
  readonly raw: string
  readonly reasoning: string
  readonly prompt_version: string
  readonly duration_ms: number
}

const PROMPT_VERSION = 'v2-cot'

function buildPrompt(n: number): string {
  return `これら ${n} 枚は同じ名刺を別タイミング・角度で撮影した候補画像です。OCR / 文字読取に最も適した 1 枚の番号 (0..${n - 1}) を選んでください。

判断材料:
- 文字の鮮明度 (ブレが無いか)
- グレア / 反射の少なさ
- カード全体が画角に収まっているか (端が切れていないか)
- 手や指による遮蔽が無いか

以下の形式で必ず 2 行出力してください:
理由: <2-3 文で評価>
答え: <0-${n - 1} の数字>`
}

/**
 * Pick the best frame among K candidates using Gemma 4 vision.
 * Falls back to index 0 (highest-score) on any failure.
 */
export async function pickBestFrameByLlm(
  candidates: readonly FrameCandidate[],
  onProgress?: LlmProgressCallback,
): Promise<PickResult> {
  if (candidates.length <= 1) {
    return {
      pickedIndex: 0,
      candidateCount: candidates.length,
      raw: '',
      reasoning: '候補 1 枚のみ — LLM スキップ',
      prompt_version: PROMPT_VERSION,
      duration_ms: 0,
    }
  }

  const t0 = performance.now()
  try {
    const { processor, model } = await getInstances()
    onProgress?.({ stage: 'inference' })

    const content: Array<{ type: 'image' } | { type: 'text'; text: string }> = []
    for (const _ of candidates) content.push({ type: 'image' })
    content.push({ type: 'text', text: buildPrompt(candidates.length) })

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
      max_new_tokens: 144,
      do_sample: false,
    })
    const promptLen = inputs.input_ids.dims[1]
    const generated = outputs.slice(null, [promptLen, null])
    const raw = processor.batch_decode(generated, { skip_special_tokens: true })[0] as string
    const parsed = parseCoTAnswer(raw)

    // Prefer the digit on the `答え:` line; if absent, scan whole raw.
    // Multi-digit numbers (>= 10 candidates) are out of scope here — we
    // always feed K <= 4.
    const answerDigit = parsed.answer.match(/\d+/)?.[0]
    const fallbackDigit = raw.match(/\d+/)?.[0]
    const digit = answerDigit ?? fallbackDigit
    let pickedIndex = 0
    if (digit) {
      const idx = Number(digit)
      if (idx >= 0 && idx < candidates.length) pickedIndex = idx
    }
    return {
      pickedIndex,
      candidateCount: candidates.length,
      raw: raw.trim(),
      reasoning: parsed.reasoning,
      prompt_version: PROMPT_VERSION,
      duration_ms: performance.now() - t0,
    }
  } catch (err) {
    console.warn('[llm-best-frame] failed, falling back to score-best', err)
    return {
      pickedIndex: 0,
      candidateCount: candidates.length,
      raw: '',
      reasoning: `LLM error: ${String(err)}`,
      prompt_version: PROMPT_VERSION,
      duration_ms: performance.now() - t0,
    }
  }
}
