/**
 * LLM pair-comparison dedup using Gemma 4 vision.
 *
 * Where canonical-key dedup (email/phone) + pHash visual dedup leave
 * residual duplicates (e.g. same physical card filmed at different
 * angles with shared OCR fragments), this asks Gemma 4 directly:
 * "are these two images the same physical card?"
 *
 * Used as a post-process on items pHash-close in the ambiguous band
 * (Hamming ≥ 30 AND ≤ 80), where pHash alone is inconclusive.
 *
 * WebGPU required (matches llm-extractor-gemma.ts). Caller should
 * already have ensured the model is loaded via `ensureLlmReady()`.
 */

import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  load_image,
} from '@huggingface/transformers'

import { ensureLlmReady } from './llm-extractor-gemma'
import { parseCoTAnswer } from './llm-parse-cot'

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX'

// Re-use a separate processor/model instance for pair work. The
// vision encoder accepts multiple images per inference so we feed
// both crops in one call.
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

export interface PairResult {
  readonly same: boolean
  readonly confidence: number
  readonly raw: string
  readonly reasoning: string      // CoT 「理由:」部分
  readonly prompt_version: string // "v2-cot"
  readonly duration_ms: number
}

const PROMPT_VERSION = 'v2-cot'

const PROMPT = `これら 2 枚の画像を比較してください。同じ物理的な名刺を別の角度・距離・タイミングで撮影したものか、それとも別のカードか、判断してください。

判断材料:
- 主要な文字 (氏名・会社名・電話番号・メール) が一致するか
- ロゴ・配色・レイアウトが一致するか
- 単なる撮影条件の違い (角度・トリミング) か、内容自体が違うか

以下の形式で必ず 2 行出力してください:
理由: <2-3 文で比較>
答え: <yes または no>`

/**
 * Ask Gemma 4 whether two cropped card images are the same physical
 * card. Returns { same, confidence } where confidence is a coarse
 * 0..1 (1.0 if the model's reply is unambiguous "yes"/"no", 0.5 if
 * we couldn't parse a clear answer).
 *
 * On any failure: returns { same: false, confidence: 0 } so the
 * caller defaults to keeping items separate (no over-merge).
 */
export async function arePairSameCard(
  imageDataUrlA: string,
  imageDataUrlB: string,
): Promise<PairResult> {
  const t0 = performance.now()
  try {
    const { processor, model } = await getInstances()
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image' },
          { type: 'image' },
          { type: 'text', text: PROMPT },
        ],
      },
    ]
    const prompt = processor.apply_chat_template(messages, {
      add_generation_prompt: true,
    })
    const [imgA, imgB] = await Promise.all([
      load_image(imageDataUrlA),
      load_image(imageDataUrlB),
    ])
    const inputs = await processor(prompt, [imgA, imgB], null, {
      add_special_tokens: false,
    })
    const outputs = await model.generate({
      ...inputs,
      max_new_tokens: 144,
      do_sample: false,
    })
    const promptLen = inputs.input_ids.dims[1]
    const generated = outputs.slice(null, [promptLen, null])
    const raw = processor.batch_decode(generated, {
      skip_special_tokens: true,
    })[0] as string
    const parsed = parseCoTAnswer(raw)
    // Prefer the answer line; fall back to scanning the whole raw (v1).
    const target = parsed.answer.length > 0 ? parsed.answer : raw
    const lower = target.toLowerCase().trim()
    const same = /^\s*yes\b|はい|同じ/.test(lower)
    const confident = /^(yes|no|はい|いいえ|同じ|違う)\b/.test(lower)
    const confidence = confident ? 1.0 : 0.5
    return {
      same,
      confidence,
      raw: raw.trim(),
      reasoning: parsed.reasoning,
      prompt_version: PROMPT_VERSION,
      duration_ms: performance.now() - t0,
    }
  } catch (err) {
    console.warn('[llm-card-pair] failed:', err)
    return {
      same: false,
      confidence: 0,
      raw: String(err),
      reasoning: `LLM error: ${String(err)}`,
      prompt_version: PROMPT_VERSION,
      duration_ms: performance.now() - t0,
    }
  }
}
