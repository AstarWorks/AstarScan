/**
 * Phase 1d-2: compare small text-only LLMs on the YomiToku → JSON task.
 *
 * Run: bun scripts/eval/spike-small-llm.mjs <model_id>
 *   model_id examples:
 *     onnx-community/Qwen2.5-0.5B-Instruct
 *     onnx-community/Qwen2.5-1.5B-Instruct
 *     onnx-community/gemma-3-1b-it-ONNX
 *     HuggingFaceTB/SmolLM2-1.7B-Instruct
 *
 * Inputs: 3 sample cards from the actual mp4 (real YomiToku output).
 */

import {
  AutoTokenizer,
  AutoModelForCausalLM,
} from '@huggingface/transformers'

const modelId = process.argv[2] ?? 'onnx-community/Qwen2.5-0.5B-Instruct'

const SAMPLE_CARDS = [
  {
    name: 'komida (込田友紀子)',
    expected: { name: '込田友紀子', mobile: '090-5516-1153', tel: '03-3609-3446', fax: '03-3609-3454', postal: '125-0042', company_must_contain: '中野組商事' },
    text: `一般社団法人 倫理研究所
葛飾区倫理法人会
幹 事/青年委員
込田友紀子
090-5516-1153
柴又 帝釈天
会社 /中野組商事(有)取締役
〒125-0042
東京都葛飾区金町4-10-9
TEL : 03-3609-3446 FAX : 03-3609-3454
東京都倫理法人会
葛飾区倫理法人会`,
  },
  {
    name: 'shindo (進藤みゆき / Offisis — has slogan as biggest text)',
    expected: { name: '進藤みゆき', email: 'info@offisis.co.jp', company_must_contain: 'Offisis' },
    text: `あなたのオフィスにオアシスを
Offisis
https://www.offisis.co.jp/
マーケティング部
進藤 みゆき
Miyuki Shindo
info@offisis.co.jp
株式会社Offisis
〒169-0075
東京都新宿区高田馬場二丁目14-2 新陽ビル1102号室ICS
TEL:(03) 6908 3210
FAX:(03) 6908 3210`,
  },
  {
    name: 'noguchi (野口明雄, OCR misread 野→里予)',
    expected: { mobile: '080-2673-6319', email: 'akionoguchi7@gmail.com' },
    text: `里予 1 明雄
Mobile:080-2673-6319
Email:akionoguchi7@gmail.com`,
  },
]

const PROMPT_TEMPLATE = (text) => `次は日本語の名刺画像から OCR で抽出したテキストです。各 paragraph は読み順に並んでいます。

${text}

このテキストから以下 JSON schema で field を抽出してください。

注意点:
- name: 実在する人物名 (姓名)。会社スローガンやキャッチコピー、事業説明文は name にしない。
- name_kana: テキスト内に明示的に書かれた読み仮名のみ。書かれていなければ null (推測禁止)。
- company: 会社・組織名。複数ある場合は (株)/(有)/株式会社/Co., Ltd. 等の incorporated entity を優先。
- 電話番号: 070/080/090 始まりは mobile。"TEL:" は tel。"FAX:" は fax。
- 全 field 必須、不明は null。

出力は JSON のみ、説明禁止:
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
  "email": string|null
}`

console.log(`[spike-llm] model=${modelId}`)

console.log('[spike-llm] loading tokenizer + model (q4, cpu)…')
const tLoad = Date.now()
const tokenizer = await AutoTokenizer.from_pretrained(modelId)
const model = await AutoModelForCausalLM.from_pretrained(modelId, {
  dtype: 'q4',
  device: 'cpu',
})
console.log(`[spike-llm] loaded ${Date.now() - tLoad} ms`)

for (const sample of SAMPLE_CARDS) {
  console.log(`\n[spike-llm] === ${sample.name} ===`)
  const messages = [{ role: 'user', content: PROMPT_TEMPLATE(sample.text) }]
  const inputs = tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_tensor: true,
    return_dict: true,
  })
  const t0 = Date.now()
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 384,
    do_sample: false,
  })
  const dt = Date.now() - t0

  const promptLen = inputs.input_ids.dims[1]
  const generated = outputs.slice(null, [promptLen, null])
  const text = tokenizer.batch_decode(generated, { skip_special_tokens: true })[0]
  console.log(`[spike-llm] generation ${dt} ms`)
  console.log(text)

  // score against expected
  try {
    const jsonMatch = text.match(/```json\s*([\s\S]+?)```|(\{[\s\S]+\})/)
    const jsonText = jsonMatch ? (jsonMatch[1] ?? jsonMatch[2]) : null
    if (jsonText) {
      const parsed = JSON.parse(jsonText)
      const hits = []
      const misses = []
      for (const [k, v] of Object.entries(sample.expected)) {
        if (k === 'company_must_contain') {
          const c = (parsed.company ?? '').toString()
          if (c.includes(v)) hits.push(`company⊇'${v}'`)
          else misses.push(`company expected ⊇ '${v}' got '${c}'`)
        } else {
          if (parsed[k] === v) hits.push(k)
          else misses.push(`${k}: expected '${v}' got '${parsed[k]}'`)
        }
      }
      console.log(`[spike-llm] HITS  : ${hits.join(', ')}`)
      console.log(`[spike-llm] MISSES: ${misses.join(' | ')}`)
    } else {
      console.log('[spike-llm] could not parse JSON from output')
    }
  } catch (e) {
    console.log(`[spike-llm] parse error: ${e.message}`)
  }
}
