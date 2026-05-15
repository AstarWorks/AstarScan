/**
 * Phase 1d spike: Gemma 4 E2B text-only LLM, no image.
 *
 * Feed YomiToku-extracted paragraphs as plain text, ask Gemma 4 to emit
 * JSON. This skips the vision encoder which was the main cost in the prior
 * Phase 0d spike (586s/card).
 *
 * Run: bun scripts/eval/spike-gemma4-text.mjs
 */

import {
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
} from '@huggingface/transformers'

const MODEL_ID = 'onnx-community/gemma-4-E2B-it-ONNX'

// Real YomiToku output for /tmp/mp4-3-sample/frame-04.jpg (込田友紀子の名刺)
const SAMPLE_PARAGRAPHS = `[order=1, dir=horizontal] 一般社団法人 倫理研究所
葛飾区倫理法人会
[order=3, dir=horizontal] 幹 事/青年委員
[order=4, dir=horizontal] 込田友紀子
090-5516-1153
[order=6, dir=horizontal] 柴又 帝釈天
[order=7, dir=horizontal] 会社 /中野組商事(有)取締役
〒125-0042
東京都葛飾区金町4-10-9
TEL : 03-3609-3446 FAX : 03-3609-3454
[order=10, dir=horizontal] 東京都倫理法人会
葛飾区倫理法人会`

const PROMPT = `次は日本語の名刺画像から OCR で抽出したテキストです。各行は [order=N, dir=...] で paragraph の順番と方向が示されています。

${SAMPLE_PARAGRAPHS}

このテキストから名刺の field を JSON で抽出してください。読めない field は null。電話・FAX・携帯は数字とハイフンのみ。住所は postal/address に分離。Slogan や事業説明文ではなく実在の人物名・会社名を name/company にしてください。

出力は JSON のみ:
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
  "url": string|null
}`

console.log(`[spike-text] model=${MODEL_ID}`)

console.log('[spike-text] loading tokenizer…')
const t0 = Date.now()
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
console.log(`[spike-text] tokenizer loaded ${Date.now() - t0} ms`)

console.log('[spike-text] loading model (q4, cpu, text-only)…')
const t1 = Date.now()
// Force text-only inference by NOT loading vision_encoder/audio_encoder
const model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
  dtype: 'q4',
  device: 'cpu',
})
console.log(`[spike-text] model loaded ${Date.now() - t1} ms`)

const messages = [
  { role: 'user', content: PROMPT },
]
const inputs = tokenizer.apply_chat_template(messages, {
  add_generation_prompt: true,
  return_tensor: true,
  return_dict: true,
})

console.log('[spike-text] generating…')
const t2 = Date.now()
const outputs = await model.generate({
  ...inputs,
  max_new_tokens: 384,
  do_sample: false,
  streamer: new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
  }),
})
const dtGen = Date.now() - t2

// Decode the new tokens only
const promptLen = inputs.input_ids.dims[1]
const generated = outputs.slice(null, [promptLen, null])
const text = tokenizer.batch_decode(generated, { skip_special_tokens: true })[0]

console.log()
console.log(`[spike-text] generation: ${dtGen} ms`)
console.log(`[spike-text] total: ${Date.now() - t0} ms`)
console.log('--- raw output ---')
console.log(text)
