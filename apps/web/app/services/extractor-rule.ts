/**
 * Regex backstop for Japanese business-card field extraction.
 *
 * TS port of `scripts/eval/lib/extractor-rule.mjs`. Pulls out the
 * high-confidence numeric fields (email, phone, FAX, mobile, postal, URL,
 * 〒) from raw OCR text. Never produces a name or company — those need
 * the heuristic layer.
 *
 * The Node side proved that regex is more reliable than LLM on these
 * fields (LLMs missed mobile when 090-… was wedged next to a name).
 */

export interface RuleFields {
  readonly tel: string | null
  readonly fax: string | null
  readonly mobile: string | null
  readonly email: string | null
  readonly url: string | null
  readonly postal: string | null
}

const RE_EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g
const RE_EMAIL_LOCALPART_ONLY = /([A-Za-z0-9._%+\-]+)@(?!\S*\.\w{2,})/g
const RE_DOMAIN_FRAGMENT =
  /\b((?:[A-Za-z0-9\-]+\.){1,3}(?:com|jp|net|org|co\.jp|or\.jp|ne\.jp|ac\.jp|go\.jp|gr\.jp|edu|info|biz|app|dev|io|me))\b/gi

const RE_PHONE_JP =
  /(?:\+81[-－―]?[1-9]|0\d{1,4})[-－―]\d{1,4}[-－―]\d{3,4}/g
const RE_PHONE_PARENS =
  /(?:\+81|0)\(?\d{1,4}\)?[-－―\s]?\d{1,4}[-－―\s]?\d{3,4}/g

const RE_POSTAL_JP = /〒\s*(\d{3}|[０-９]{3})[-－―ー]?\s*(\d{4}|[０-９]{4})/g

const RE_URL =
  /https?:\/\/[^\s<>"'）)]+|(?<![\w/])(?:www\.)[A-Za-z0-9.\-/_?=&%]+/g

const PHONE_DIGITS = '[\\+\\d\\-－―\\s()（）]+'
const PREFIX_TEL = new RegExp(`(?:TEL|Tel|tel|電話|☎|℡)[:：]?\\s*(${PHONE_DIGITS})`, 'g')
const PREFIX_FAX = new RegExp(`(?:FAX|Fax|fax|ＦＡＸ)[:：]?\\s*(${PHONE_DIGITS})`, 'g')
const PREFIX_MOBILE = new RegExp(`(?:Mobile|MOBILE|mobile|携帯|Cell|cell|CELL)[:：]?\\s*(${PHONE_DIGITS})`, 'g')

function normalizeDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－―ー]/g, '-')
    .replace(/[()（）]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null
  const d = normalizeDigits(raw)
  const m = d.match(/(\+?\d[\d\-]{7,18}\d)/)
  return m ? m[1]! : null
}

function pickFirst(re: RegExp, text: string): string | null {
  const m = text.match(re)
  return m ? m[0] : null
}

function pickPrefix(re: RegExp, text: string): string | null {
  re.lastIndex = 0
  const m = re.exec(text)
  if (!m || !m[1]) return null
  return normalizePhone(m[1])
}

function isMobile(phoneStr: string | null): boolean {
  if (!phoneStr) return false
  const n = phoneStr.replace(/\D/g, '')
  return /^0[789]0\d{8}$/.test(n) || /^\+810[789]0\d{8}$/.test(n)
}

export function extractRuleFields(
  input: string | Array<{ contents: string }>,
): RuleFields {
  let text: string
  if (Array.isArray(input)) {
    text = input.map((p) => p.contents ?? '').join('\n')
  } else {
    text = String(input ?? '')
  }
  text = text.replace(/\r/g, '')

  let email = pickFirst(RE_EMAIL, text)
  const url = pickFirst(RE_URL, text)

  // Broken-email reconstruction (OCR splits "info@offisis.co.jp" into pieces)
  if (!email) {
    RE_EMAIL_LOCALPART_ONLY.lastIndex = 0
    const localMatch = RE_EMAIL_LOCALPART_ONLY.exec(text)
    if (localMatch && localMatch[1]) {
      const localpart = localMatch[1]
      const domainMatches: string[] = []
      RE_DOMAIN_FRAGMENT.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = RE_DOMAIN_FRAGMENT.exec(text)) !== null) {
        if (m[1]) domainMatches.push(m[1])
      }
      let urlHost: string | null = null
      if (url) {
        const um =
          url.match(/https?:\/\/(?:www\.)?([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/) ||
          url.match(/(?:www\.)?([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/)
        if (um && um[1]) urlHost = um[1].toLowerCase()
      }
      const candidate = urlHost ?? domainMatches[0]
      if (candidate) {
        const synthesized = `${localpart}@${candidate}`
        if (/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(synthesized)) {
          email = synthesized
        }
      }
    }
  }

  // Postal
  let postal: string | null = null
  RE_POSTAL_JP.lastIndex = 0
  const pm = RE_POSTAL_JP.exec(text)
  if (pm && pm[1] && pm[2]) {
    const a = normalizeDigits(pm[1])
    const b = normalizeDigits(pm[2])
    postal = `${a}-${b}`
  }

  const telPrefixed = pickPrefix(PREFIX_TEL, text)
  const faxPrefixed = pickPrefix(PREFIX_FAX, text)
  const mobPrefixed = pickPrefix(PREFIX_MOBILE, text)

  const allBare: string[] = []
  let m: RegExpExecArray | null
  RE_PHONE_JP.lastIndex = 0
  while ((m = RE_PHONE_JP.exec(text)) !== null) {
    allBare.push(normalizeDigits(m[0]))
  }
  RE_PHONE_PARENS.lastIndex = 0
  while ((m = RE_PHONE_PARENS.exec(text)) !== null) {
    const n = normalizeDigits(m[0])
    if (n.replace(/\D/g, '').length >= 9 && !allBare.includes(n)) allBare.push(n)
  }

  const usedSet = new Set(
    [telPrefixed, faxPrefixed, mobPrefixed]
      .filter((v): v is string => v !== null)
      .map((s) => s.replace(/\D/g, '')),
  )
  const unused = allBare.filter((n) => !usedSet.has(n.replace(/\D/g, '')))

  let mobile = mobPrefixed
  if (!mobile) {
    const idx = unused.findIndex(isMobile)
    if (idx >= 0) {
      mobile = unused[idx]!
      unused.splice(idx, 1)
    }
  }

  let tel = telPrefixed
  if (!tel) {
    const idx = unused.findIndex((n) => !isMobile(n))
    if (idx >= 0) {
      tel = unused[idx]!
      unused.splice(idx, 1)
    }
  }

  let fax = faxPrefixed
  if (!fax) {
    const idx = unused.findIndex((n) => !isMobile(n))
    if (idx >= 0) {
      fax = unused[idx]!
      unused.splice(idx, 1)
    }
  }

  return {
    tel: tel ?? null,
    fax: fax ?? null,
    mobile: mobile ?? null,
    email: email ?? null,
    url: url ?? null,
    postal: postal ?? null,
  }
}
