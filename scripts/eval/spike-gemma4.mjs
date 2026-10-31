/**
 * Phase 0d: Gemma 4 E4B vision spike on Node CPU.
 *
 * Goal: measure if Gemma 4 can extract Japanese business-card fields directly
 * from a cropped image, on a 16-core CPU (no GPU), with quality competitive
 * with YomiToku + post-extraction.
 *
 * Output: JSON to stdout + timing.
 *
 * Run:  bun scripts/eval/spike-gemma4.mjs <imagePath> [E2B|E4B]
 */

import process from 'node:process'
import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  TextStreamer,
  load_image,
} from '@huggingface/transformers'

const [, , imagePath = '/tmp/mp4-3-sample/frame-04.jpg', size = 'E4B'] =
  process.argv
const modelId = `onnx-community/gemma-4-${size}-it-ONNX`

console.log(`[spike-gemma4] image=${imagePath} model=${modelId}`)
console.log('[spike-gemma4] loading processor…')
const t0 = Date.now()
const processor = await AutoProcessor.from_pretrained(modelId)
console.log(`[spike-gemma4] processor loaded in ${Date.now() - t0} ms`)

console.log('[spike-gemma4] loading model (q4, cpu)…')
const t1 = Date.now()
const model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
  dtype: 'q4',
  device: 'cpu',
})
console.log(`[spike-gemma4] model loaded in ${Date.now() - t1} ms`)

const SCHEMA_INSTRUCTION = `この画像は日本語の名刺です。以下の JSON schema で fields を抽出してください。
読めない field は null。電話・FAX・携帯は数字とハイフンのみ。
出力は JSON のみ。説明や前置きは禁止。

{
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
  "url": string|null,
  "language": "ja"|"en"|"mixed"
}`

const messages = [
  {
    role: 'user',
    content: [
      { type: 'image' },
      { type: 'text', text: SCHEMA_INSTRUCTION },
    ],
  },
]

console.log('[spike-gemma4] preparing inputs…')
const prompt = processor.apply_chat_template(messages, {
  enable_thinking: false,
  add_generation_prompt: true,
})
const image = await load_image(imagePath)
const inputs = await processor(prompt, image, null, {
  add_special_tokens: false,
})

console.log('[spike-gemma4] generating…')
const t2 = Date.now()
await model.generate({
  ...inputs,
  max_new_tokens: 512,
  do_sample: false,
  streamer: new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
  }),
})
const dt = Date.now() - t2
console.log(`\n[spike-gemma4] generation: ${dt} ms`)
console.log(`[spike-gemma4] total: ${Date.now() - t0} ms`)
