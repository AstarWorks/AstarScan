/**
 * Gemma 4 E2B vision extractor — WebGPU-accelerated card → JSON.
 *
 * Replaces the NDLOCR + heuristic stack with a single multimodal-LLM call
 * per cropped card. Strengths over the classical pipeline:
 *   - reads kanji names YomiToku splits into single characters
 *   - distinguishes "company" from "organization affiliation" semantically
 *   - skips OCR entirely (no NDLOCR weakness)
 *
 * Trade-offs:
 *   - first call triggers a ~3 GB model download (cached in IndexedDB)
 *   - per-card latency: ~10-30s on consumer GPU via WebGPU, ~7 min on CPU
 *   - WebGPU required (Chrome/Edge 113+, Safari 18+, no Firefox yet)
 *
 * Model: `onnx-community/gemma-4-E2B-it-ONNX`, q4f16 quantization.
 *
 * The companion CPU-only path in `extractor-heuristic.ts` stays available
 * as a fallback for non-WebGPU devices; `batch-pipeline.ts` picks between
 * them based on the user's UI toggle.
 */

import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  load_image,
} from '@huggingface/transformers'

import type { HeuristicFields } from './extractor-heuristic'
import { extractRuleFields } from './extractor-rule'

export interface LlmProgress {
  readonly stage: 'load' | 'inference'
  readonly file?: string
  readonly progress?: number // 0..1
  readonly note?: string
}

export type LlmProgressCallback = (p: LlmProgress) => void

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX'

interface LlmState {
  processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any
}

let state: LlmState | null = null
let loadPromise: Promise<LlmState> | null = null

export function isLlmReady(): boolean {
  return state !== null
}

export async function ensureLlmReady(
  onProgress?: LlmProgressCallback,
): Promise<void> {
  if (state) return
  if (loadPromise) {
    await loadPromise
    return
  }

  loadPromise = (async () => {
    onProgress?.({ stage: 'load', note: 'tokenizer / processor' })
    const processor = await AutoProcessor.from_pretrained(MODEL_ID)
    onProgress?.({ stage: 'load', note: 'model weights (~3 GB)' })

    const model = await Gemma4ForConditionalGeneration.from_pretrained(
      MODEL_ID,
      {
        dtype: 'q4f16',
        device: 'webgpu',
        // transformers.js progress_callback is loosely typed; cast through any
        progress_callback: ((p: unknown) => {
          const info = p as { file?: string; progress?: number }
          onProgress?.({
            stage: 'load',
            file: info.file,
            progress:
              typeof info.progress === 'number'
                ? info.progress / 100
                : undefined,
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      },
    )
    const s: LlmState = { processor, model }
    state = s
    return s
  })()

  try {
    await loadPromise
  } finally {
    loadPromise = null
  }
}

const SYSTEM = `あなたは日本語の名刺から情報を抽出するアシスタントです。
画像の名刺を読み取り、以下 JSON schema で出力します。
- name: 実在する人物名のみ。会社スローガンや事業説明文は name にしない。
- company: 会社・組織名。複数候補があれば株式会社/有限会社/合同会社/(株)/(有)/Inc./Co.,Ltd 等の incorporated entity を優先。
- 電話番号: 070/080/090 始まりは mobile。"TEL:" は tel。"FAX:" は fax。数字とハイフンのみで正規化。
- name_kana: 画像に明示的に書かれた読み仮名のみ。書かれていなければ null (推測しない)。
- 読めない field は null。出力は JSON のみ、説明文や前置きは禁止。`

const SCHEMA_HINT = `{
  "name": string|null,
  "name_kana": string|null,
  "company": string|null,
  "department": string|null,
  "title": string|null,
  "postal": string|null,
  "address": string|null,
  "tel": string|null,
  "fax": string|null,
  "mobile": string|null,
  "email": string|null,
  "url": string|null
}`

export interface LlmExtractResult {
  fields: HeuristicFields
  raw_response: string
  duration_ms: number
}

/**
 * Extract structured fields from a single cropped card image.
 *
 * `imageDataUrl` is a data: URL produced by canvas.toDataURL('image/jpeg').
 *
 * The result schema mirrors `HeuristicFields` so downstream code (dedup,
 * UI rendering) doesn't care which extractor was used. Regex backstop
 * still runs on the LLM's raw response to repair phone/email/postal in
 * case the LLM misses or hallucinates them.
 */
export async function extractWithLlm(
  imageDataUrl: string,
  onProgress?: LlmProgressCallback,
): Promise<LlmExtractResult> {
  await ensureLlmReady(onProgress)
  if (!state) throw new Error('LLM not initialized')

  onProgress?.({ stage: 'inference' })
  const t0 = performance.now()

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image' },
        { type: 'text', text: `${SYSTEM}\n\nschema:\n${SCHEMA_HINT}` },
      ],
    },
  ]
  const prompt = state.processor.apply_chat_template(messages, {
    add_generation_prompt: true,
  })
  const image = await load_image(imageDataUrl)
  const inputs = await state.processor(prompt, image, null, {
    add_special_tokens: false,
  })

  const outputs = await state.model.generate({
    ...inputs,
    max_new_tokens: 384,
    do_sample: false,
  })
  const duration_ms = performance.now() - t0

  const promptLen = inputs.input_ids.dims[1]
  const generated = outputs.slice(null, [promptLen, null])
  const raw = state.processor.batch_decode(generated, {
    skip_special_tokens: true,
  })[0] as string

  // Try to parse JSON out of the model's response (it sometimes wraps in
  // ```json fences, sometimes prepends prose). Pick the first balanced
  // brace-pair we can JSON.parse.
  const parsed = parseLlmJson(raw)

  // Regex backstop — overwrite phone/email/postal/url if regex finds clean
  // values; trust LLM for name/company/title/department/address.
  const rule = extractRuleFields(raw)

  const fields: HeuristicFields = {
    name: parsed.name ?? null,
    name_kana: parsed.name_kana ?? null,
    company: parsed.company ?? null,
    department: parsed.department ?? null,
    title: parsed.title ?? null,
    postal: rule.postal ?? parsed.postal ?? null,
    address: parsed.address ?? null,
    tel: rule.tel ?? parsed.tel ?? null,
    fax: rule.fax ?? parsed.fax ?? null,
    mobile: rule.mobile ?? parsed.mobile ?? null,
    email: rule.email ?? parsed.email ?? null,
    url: rule.url ?? parsed.url ?? null,
    sns_handles: Array.isArray(parsed.sns_handles) ? parsed.sns_handles : [],
    raw_text: raw,
    language: 'ja',
    confidence:
      parsed.name && (rule.email || rule.tel || rule.mobile) ? 0.9 : 0.5,
  }
  return { fields, raw_response: raw, duration_ms }
}

interface ParsedLlmFields {
  name?: string | null
  name_kana?: string | null
  company?: string | null
  department?: string | null
  title?: string | null
  postal?: string | null
  address?: string | null
  tel?: string | null
  fax?: string | null
  mobile?: string | null
  email?: string | null
  url?: string | null
  sns_handles?: string[]
}

function parseLlmJson(text: string): ParsedLlmFields {
  // strip ```json ... ``` fences
  const fence = text.match(/```(?:json)?\s*([\s\S]+?)```/i)
  const candidates: string[] = []
  if (fence && fence[1]) candidates.push(fence[1])
  // also try the first {...} balanced block
  const braceMatch = text.match(/\{[\s\S]+\}/)
  if (braceMatch) candidates.push(braceMatch[0])
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c)
      if (typeof obj === 'object' && obj !== null) return obj as ParsedLlmFields
    } catch {
      // try next
    }
  }
  return {}
}
