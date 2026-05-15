/**
 * Rule + spatial-heuristic field extractor for Japanese business cards.
 *
 * Input: array of YomiToku paragraphs `[{ contents, box: [x1,y1,x2,y2],
 *        direction: 'horizontal'|'vertical', order: number }]`.
 *
 * Output: { name, name_kana, company, department, title, postal, address,
 *          tel, fax, mobile, email, url, sns_handles, raw_text, language,
 *          confidence }
 *
 * Heuristics:
 *   - postal:  〒 + 7 digits anywhere
 *   - email:   first email pattern
 *   - tel/fax/mobile: see extractor-rule.mjs (digit-regex + prefix labels)
 *   - URL:     http(s):// or www.
 *   - company: a line containing 株式会社 / 有限会社 / 合同会社 / 一般社団法人
 *              / 一般財団法人 / (株) / (有) / Co.,Ltd / Inc.
 *   - title:   a line containing common title kanji (代表/取締役/社長/部長/
 *              課長/主任/マネージャー/CEO/CTO/CFO/Director/President/委員)
 *   - department: a line containing 部 / 課 / 室 / 局 / グループ + not a title
 *   - address: a line starting/containing 都|道|府|県|市|区|町|村 + digits/-
 *              (commonly directly after the postal line, but we don't rely on
 *               adjacency — we search the whole paragraph set)
 *   - name:    Japanese kanji 2-4 chars, optionally with mid-space and
 *              optional small-font kana underneath. Heuristic: pick the
 *              paragraph closest to the top-left half of the card that is
 *              NOT company/title/address and is short (≤ 8 chars).
 *
 * All of these are conservative — false-positives are worse than nulls
 * because the regex backstop already populates email/phone reliably.
 *
 * For ambiguous cases we set `confidence` < 1.
 */

import { extractRuleFields } from './extractor-rule.mjs'

const COMPANY_KEYWORDS = [
  '株式会社', '有限会社', '合同会社', '合名会社', '合資会社',
  '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人',
  '社会福祉法人', '医療法人', '学校法人', '宗教法人',
  '(株)', '（株）', '(有)', '（有)', '（有）',
  'Co.,Ltd', 'Co., Ltd', 'Inc.', 'LLC', 'Ltd.', 'Corp.', 'Company',
]
const TITLE_KEYWORDS = [
  '代表取締役', '代表者', '代表', '取締役', '社長', '副社長',
  '専務', '常務', '監査役',
  '会長', '副会長', '理事長', '理事', '顧問', '相談役',
  '本部長', '事業部長', '部長', '次長', '課長', '係長', '主任',
  '主査', '主事', '担当', '幹事',
  'マネージャー', 'マネジャー', 'Manager', 'Director', 'President',
  'CEO', 'CTO', 'CFO', 'COO', 'VP',
  '委員', '青年委員', '会員',
]
const DEPT_KEYWORDS = [
  '営業部', '営業課', '営業1部', '営業2部',
  '総務部', '総務課', '経理部', '経理課',
  '人事部', '人事課', '広報部', '広報課',
  '企画部', '企画課', '開発部', '開発課',
  '事業部', '本部', '局', 'グループ',
  '部', '課', '室', // generic fallback
]
const ADDRESS_PREFIX = /[都道府県市区町村]/
const NAME_OBVIOUS_KANJI = /^[\p{Script=Han}々ヵヶ]{2,4}(\s|　)?[\p{Script=Han}々ヵヶ]{0,4}$/u

/**
 * Lower numbers = higher up on the card (closer to header / name region).
 * Returns y-centre of bbox.
 */
function paragraphYCenter(p) {
  return (p.box[1] + p.box[3]) / 2
}
function paragraphXCenter(p) {
  return (p.box[0] + p.box[2]) / 2
}
function paragraphHeight(p) {
  return p.box[3] - p.box[1]
}

function hasAny(s, list) {
  for (const kw of list) if (s.includes(kw)) return true
  return false
}

// Sort longer keywords first so e.g. "青年委員" matches before "委員".
const COMPANY_KEYWORDS_SORTED = [...COMPANY_KEYWORDS].sort((a, b) => b.length - a.length)
const TITLE_KEYWORDS_SORTED = [...TITLE_KEYWORDS].sort((a, b) => b.length - a.length)

// Normalize "幹 事" → "幹事" so title detection survives YomiToku tracking-space.
function compactJa(s) {
  return s.replace(/\s+/g, '')
}

function looksLikeCompany(s) {
  return hasAny(compactJa(s), COMPANY_KEYWORDS_SORTED)
}
function looksLikeTitle(s) {
  // exact match to a title token works even when surrounded by other text
  return hasAny(compactJa(s), TITLE_KEYWORDS_SORTED)
}
function looksLikeDepartment(s) {
  if (looksLikeTitle(s)) return false
  return hasAny(s, DEPT_KEYWORDS)
}
function looksLikeAddress(s) {
  if (!ADDRESS_PREFIX.test(s)) return false
  if (!/\d/.test(s)) return false
  if (looksLikeCompany(s)) return false
  return true
}

/** True if a line looks like a marketing slogan / sentence rather than a name. */
function looksLikeSlogan(s) {
  if (s.length >= 12) return true
  // sentence-final particles + politeness suffixes
  if (/[をにはがでとから]$/.test(s)) return true
  if (/(ます|です|ました|してください|くださる|つなぐ|始まり)/.test(s)) return true
  // punctuation often used in marketing copy (♡, !, ?, ❤, …)
  if (/[!！?？♡❤☆★～]/.test(s)) return true
  // bullet list items / event listings
  if (/^[・·\-]/.test(s)) return true
  // contains many particles → likely a sentence
  const particleCount = (s.match(/[をにはがでとから]/g) || []).length
  if (particleCount >= 2) return true
  return false
}

const PERSON_NAME_RX = /^[\p{Script=Han}々]{1,4}[\s　]*[\p{Script=Han}々ぁ-んァ-ヶ]{1,5}$/u
const PERSON_NAME_FULL_KANJI_RX = /^[\p{Script=Han}々]{2,6}$/u

/** Score a paragraph as a potential name. Higher = more likely a name. */
function nameScore(p, allHeights) {
  const s = p.contents.replace(/\s+/g, ' ').trim()
  if (s.length === 0 || s.length > 15) return -Infinity
  if (looksLikeCompany(s) || looksLikeTitle(s) ||
      looksLikeDepartment(s) || looksLikeAddress(s)) return -Infinity
  if (looksLikeSlogan(s)) return -Infinity
  if (/[@:\d\-]/.test(s) && !/[\p{Script=Han}]/u.test(s)) return -Infinity
  if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return -Infinity
  // pure-kana lines are usually labels/captions, not names
  if (!/[\p{Script=Han}]/u.test(s)) return -Infinity

  let score = 0
  // Strong: matches 姓 (kanji 1-4) + space + 名 (kanji or kana 1-5) pattern
  if (PERSON_NAME_RX.test(s)) score += 6
  // Strong: full kanji name pattern (e.g. 込田友紀子, 高橋幸治)
  if (PERSON_NAME_FULL_KANJI_RX.test(s) && s.length >= 2 && s.length <= 5) score += 5
  if (NAME_OBVIOUS_KANJI.test(s)) score += 2
  if (s.length <= 6) score += 2

  // larger font usually means name — proxy: paragraph height vs others
  const h = paragraphHeight(p)
  const medianH = median(allHeights)
  if (h > medianH * 1.3) score += 3
  if (h > medianH * 1.7) score += 2

  return score
}

function median(arr) {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * @param {Array<{contents:string, box:number[], direction:string, order?:number}>} paragraphs
 */
export function extractHeuristic(paragraphs) {
  const lang = detectLanguage(paragraphs)
  const rawText = paragraphs.map((p) => p.contents).join('\n')
  const rule = extractRuleFields(rawText)

  const heights = paragraphs.map(paragraphHeight)

  // Per-line search: split each paragraph by newline so multi-line
  // paragraphs can yield separate role assignments.
  const lines = []
  for (const p of paragraphs) {
    const subs = p.contents.split('\n')
    for (let i = 0; i < subs.length; i++) {
      const s = subs[i].trim()
      if (!s) continue
      lines.push({ text: s, parent: p, subIndex: i })
    }
  }

  let company = null
  let companyHasIncMarker = false
  let title = null
  let department = null
  let address = null
  let url = null

  for (const ln of lines) {
    const s = ln.text
    if (looksLikeCompany(s)) {
      // Prefer lines containing an incorporated-entity marker (株/有/合同/Co.,Ltd)
      // over generic 一般社団法人 / 一般財団法人 — the former is the daily-work
      // company; the latter is usually an affiliation.
      const incMarker = /\(株\)|（株）|\(有\)|（有\)|（有）|株式会社|有限会社|合同会社|Co\.?,?\s*Ltd|Inc\./.test(compactJa(s))
      if (!company || (incMarker && !companyHasIncMarker)) {
        company = stripCompanyPrefix(s)
        companyHasIncMarker = incMarker
      }
    }
    if (!title && looksLikeTitle(s)) {
      title = extractTitleSpan(s)
    }
    if (!department && looksLikeDepartment(s) && !looksLikeTitle(s) && !looksLikeCompany(s)) {
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

  // Sometimes the same paragraph has both company and title (e.g. "中野組商事(有)取締役").
  // Strip any trailing title keyword from company regardless of where the
  // title field came from.
  if (company) {
    for (const kw of TITLE_KEYWORDS_SORTED) {
      const idx = company.lastIndexOf(kw)
      if (idx > 0 && idx + kw.length === company.length) {
        if (!title) title = kw
        company = company.slice(0, idx).replace(/\s*\/?$/, '').trim()
        break
      }
    }
  }

  // Name: best-scoring line (not just the first line of each paragraph).
  // YomiToku frequently bundles many lines into one paragraph (especially on
  // densely-laid-out cards), so the actual name line is often line 2+ and
  // would be missed if we only scored line 0.
  let name = null
  let bestNameScore = -Infinity
  for (const p of paragraphs) {
    const subs = p.contents.split('\n')
    for (const sRaw of subs) {
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

  // confidence: drop if any of name / company missing
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

function stripCompanyPrefix(s) {
  // Drop a leading "会社 / " or "会社:" pattern often seen as a label
  let out = s.replace(/^会社\s*[/:：]\s*/, '')
  // Trim trailing slash + title combined ("中野組商事(有)取締役")
  return out.trim()
}

function extractTitleSpan(s) {
  const compact = compactJa(s)
  for (const kw of TITLE_KEYWORDS_SORTED) {
    if (compact.includes(kw)) return kw
  }
  return s
}

function detectLanguage(paragraphs) {
  let ja = 0
  let other = 0
  for (const p of paragraphs) {
    for (const c of p.contents) {
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c)) ja++
      else if (/[A-Za-z]/.test(c)) other++
    }
  }
  if (ja === 0 && other > 0) return 'en'
  if (ja > 0 && other > 0 && other > ja * 0.5) return 'mixed'
  return 'ja'
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  // Real YomiToku output for /tmp/mp4-3-sample/frame-04.jpg
  const paragraphs = [
    { box: [714, 146, 1044, 232], contents: '一般社団法人 倫理研究所\n葛飾区倫理法人会', direction: 'horizontal', order: 1 },
    { box: [936, 343, 1263, 397], contents: '幹 事/青年委員', direction: 'horizontal', order: 3 },
    { box: [929, 438, 1310, 568], contents: '込田友紀子\n090-5516-1153', direction: 'horizontal', order: 4 },
    { box: [1466, 545, 1639, 583], contents: '柴又 帝釈天', direction: 'horizontal', order: 6 },
    { box: [590, 597, 1476, 808], contents: '会社 /中野組商事(有)取締役\n〒125-0042\n東京都葛飾区金町4-10-9\nTEL : 03-3609-3446 FAX : 03-3609-3454', direction: 'horizontal', order: 7 },
    { box: [1569, 779, 1697, 831], contents: '東京都倫理法人会\n葛飾区倫理法人会', direction: 'horizontal', order: 10 },
  ]
  console.log(extractHeuristic(paragraphs))
}
