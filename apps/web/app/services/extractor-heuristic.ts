/**
 * Rule + spatial-heuristic field extractor for Japanese business cards.
 *
 * TS port of `scripts/eval/lib/extractor-heuristic.mjs`. Operates on an
 * OCR-output paragraph list (whatever the browser OCR backend produces —
 * NDLOCR-Lite, YomiToku, etc., as long as it gives `{ contents, box,
 * direction, order? }`).
 *
 * The `extractRuleFields` regex backstop runs unconditionally to populate
 * phone/email/postal/URL; the heuristic side handles name/company/title/
 * department/address with layout + keyword cues.
 */

import { extractRuleFields } from './extractor-rule'

export interface OcrParagraph {
  readonly contents: string
  readonly box: readonly [number, number, number, number]
  readonly direction: 'horizontal' | 'vertical' | string
  readonly order?: number
}

export interface HeuristicFields {
  name: string | null
  name_kana: string | null
  company: string | null
  department: string | null
  title: string | null
  postal: string | null
  address: string | null
  tel: string | null
  fax: string | null
  mobile: string | null
  email: string | null
  url: string | null
  sns_handles: string[]
  raw_text: string
  language: 'ja' | 'en' | 'mixed'
  confidence: number
}

const COMPANY_KEYWORDS = [
  '株式会社',
  '有限会社',
  '合同会社',
  '合名会社',
  '合資会社',
  '一般社団法人',
  '一般財団法人',
  '公益社団法人',
  '公益財団法人',
  '社会福祉法人',
  '医療法人',
  '学校法人',
  '宗教法人',
  '(株)',
  '（株）',
  '(有)',
  '（有)',
  '（有）',
  'Co.,Ltd',
  'Co., Ltd',
  'Inc.',
  'LLC',
  'Ltd.',
  'Corp.',
  'Company',
]
const TITLE_KEYWORDS = [
  '代表取締役',
  '代表者',
  '代表',
  '取締役',
  '社長',
  '副社長',
  '専務',
  '常務',
  '監査役',
  '会長',
  '副会長',
  '理事長',
  '理事',
  '顧問',
  '相談役',
  '本部長',
  '事業部長',
  '部長',
  '次長',
  '課長',
  '係長',
  '主任',
  '主査',
  '主事',
  '担当',
  '幹事',
  'マネージャー',
  'マネジャー',
  'Manager',
  'Director',
  'President',
  'CEO',
  'CTO',
  'CFO',
  'COO',
  'VP',
  '委員',
  '青年委員',
  '会員',
]
const DEPT_KEYWORDS = [
  '営業部',
  '営業課',
  '営業1部',
  '営業2部',
  '総務部',
  '総務課',
  '経理部',
  '経理課',
  '人事部',
  '人事課',
  '広報部',
  '広報課',
  '企画部',
  '企画課',
  '開発部',
  '開発課',
  '事業部',
  '本部',
  '局',
  'グループ',
  '部',
  '課',
  '室',
]
const ADDRESS_PREFIX = /[都道府県市区町村]/
const NAME_OBVIOUS_KANJI =
  /^[\p{Script=Han}々ヵヶ]{2,4}(\s|\u3000)?[\p{Script=Han}々ヵヶ]{0,4}$/u

const COMPANY_KEYWORDS_SORTED = [...COMPANY_KEYWORDS].sort(
  (a, b) => b.length - a.length,
)
const TITLE_KEYWORDS_SORTED = [...TITLE_KEYWORDS].sort(
  (a, b) => b.length - a.length,
)

function compactJa(s: string): string {
  return s.replace(/\s+/g, '')
}

function hasAny(s: string, list: readonly string[]): boolean {
  for (const kw of list) if (s.includes(kw)) return true
  return false
}

function paragraphHeight(p: OcrParagraph): number {
  return p.box[3] - p.box[1]
}

function looksLikeCompany(s: string): boolean {
  return hasAny(compactJa(s), COMPANY_KEYWORDS_SORTED)
}
function looksLikeTitle(s: string): boolean {
  return hasAny(compactJa(s), TITLE_KEYWORDS_SORTED)
}
function looksLikeDepartment(s: string): boolean {
  if (looksLikeTitle(s)) return false
  return hasAny(s, DEPT_KEYWORDS)
}
function looksLikeAddress(s: string): boolean {
  if (!ADDRESS_PREFIX.test(s)) return false
  if (!/\d/.test(s)) return false
  if (looksLikeCompany(s)) return false
  return true
}

function looksLikeSlogan(s: string): boolean {
  if (s.length >= 12) return true
  if (/[をにはがでとから]$/.test(s)) return true
  if (/(ます|です|ました|してください|くださる|つなぐ|始まり)/.test(s))
    return true
  if (/[!！?？♡❤☆★～]/.test(s)) return true
  if (/^[・·-]/.test(s)) return true
  const particleCount = (s.match(/[をにはがでとから]/g) || []).length
  if (particleCount >= 2) return true
  return false
}

const PERSON_NAME_RX =
  /^[\p{Script=Han}々]{1,4}[\s\u3000]*[\p{Script=Han}々ぁ-んァ-ヶ]{1,5}$/u
const PERSON_NAME_FULL_KANJI_RX = /^[\p{Script=Han}々]{2,6}$/u

function median(arr: readonly number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function nameScore(p: OcrParagraph, allHeights: readonly number[]): number {
  const s = p.contents.replace(/\s+/g, ' ').trim()
  if (s.length === 0 || s.length > 15) return -Infinity
  if (
    looksLikeCompany(s) ||
    looksLikeTitle(s) ||
    looksLikeDepartment(s) ||
    looksLikeAddress(s)
  )
    return -Infinity
  if (looksLikeSlogan(s)) return -Infinity
  if (/[@:\d-]/.test(s) && !/[\p{Script=Han}]/u.test(s)) return -Infinity
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s))
    return -Infinity
  if (!/[\p{Script=Han}]/u.test(s)) return -Infinity

  let score = 0
  if (PERSON_NAME_RX.test(s)) score += 6
  if (PERSON_NAME_FULL_KANJI_RX.test(s) && s.length >= 2 && s.length <= 5)
    score += 5
  if (NAME_OBVIOUS_KANJI.test(s)) score += 2
  if (s.length <= 6) score += 2

  const h = paragraphHeight(p)
  const medianH = median(allHeights)
  if (h > medianH * 1.3) score += 3
  if (h > medianH * 1.7) score += 2

  return score
}

function stripCompanyPrefix(s: string): string {
  return s.replace(/^会社\s*[/:：]\s*/, '').trim()
}

function extractTitleSpan(s: string): string {
  const compact = compactJa(s)
  for (const kw of TITLE_KEYWORDS_SORTED) {
    if (compact.includes(kw)) return kw
  }
  return s
}

function detectLanguage(
  paragraphs: readonly OcrParagraph[],
): 'ja' | 'en' | 'mixed' {
  let ja = 0
  let other = 0
  for (const p of paragraphs) {
    for (const c of p.contents) {
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c))
        ja++
      else if (/[A-Za-z]/.test(c)) other++
    }
  }
  if (ja === 0 && other > 0) return 'en'
  if (ja > 0 && other > 0 && other > ja * 0.5) return 'mixed'
  return 'ja'
}

export function extractHeuristic(
  paragraphs: readonly OcrParagraph[],
): HeuristicFields {
  const lang = detectLanguage(paragraphs)
  const rawText = paragraphs.map((p) => p.contents).join('\n')
  const rule = extractRuleFields(rawText)

  const heights = paragraphs.map(paragraphHeight)

  const lines: { text: string; parent: OcrParagraph }[] = []
  for (const p of paragraphs) {
    const subs = p.contents.split('\n')
    for (const sub of subs) {
      const s = sub.trim()
      if (!s) continue
      lines.push({ text: s, parent: p })
    }
  }

  let company: string | null = null
  let companyHasIncMarker = false
  let title: string | null = null
  let department: string | null = null
  let address: string | null = null
  let url: string | null = null

  for (const ln of lines) {
    const s = ln.text
    if (looksLikeCompany(s)) {
      const incMarker =
        /\(株\)|（株）|\(有\)|（有\)|（有）|株式会社|有限会社|合同会社|Co\.?,?\s*Ltd|Inc\./.test(
          compactJa(s),
        )
      if (!company || (incMarker && !companyHasIncMarker)) {
        company = stripCompanyPrefix(s)
        companyHasIncMarker = incMarker
      }
    }
    if (!title && looksLikeTitle(s)) {
      title = extractTitleSpan(s)
    }
    if (
      !department &&
      looksLikeDepartment(s) &&
      !looksLikeTitle(s) &&
      !looksLikeCompany(s)
    ) {
      department = s
    }
    if (!address && looksLikeAddress(s)) {
      address = s.replace(/^〒\s*\d{3}-?\d{4}\s*/, '')
    }
    if (!url && /(https?:\/\/|www\.)/i.test(s)) {
      const m = s.match(/(https?:\/\/[^\s<>"')]+|www\.[A-Za-z0-9.\-/_?=&%]+)/)
      if (m) url = m[0]
    }
  }

  // Strip trailing title keyword from company (e.g. "中野組商事(有)取締役" → "中野組商事(有)")
  if (company) {
    for (const kw of TITLE_KEYWORDS_SORTED) {
      const idx = company.lastIndexOf(kw)
      if (idx > 0 && idx + kw.length === company.length) {
        if (!title) title = kw
        company = company
          .slice(0, idx)
          .replace(/\s*\/?$/, '')
          .trim()
        break
      }
    }
  }

  // Name: best-scoring line across all paragraph contents (incl. multi-line)
  let name: string | null = null
  let bestNameScore = -Infinity
  for (const p of paragraphs) {
    for (const sRaw of p.contents.split('\n')) {
      const s = sRaw.trim()
      if (!s) continue
      const sc = nameScore({ ...p, contents: s }, heights)
      if (sc > bestNameScore) {
        bestNameScore = sc
        name = s
      }
    }
  }
  if (bestNameScore < 0) name = null

  let confidence = 1.0
  if (!name) confidence -= 0.3
  if (!company) confidence -= 0.2
  if (!rule.email && !rule.tel && !rule.mobile) confidence -= 0.3
  confidence = Math.max(0, confidence)

  return {
    name,
    name_kana: null,
    company,
    department,
    title,
    postal: rule.postal,
    address,
    tel: rule.tel,
    fax: rule.fax,
    mobile: rule.mobile,
    email: rule.email,
    url: url ?? rule.url,
    sns_handles: [],
    raw_text: rawText,
    language: lang,
    confidence,
  }
}
