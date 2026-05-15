/**
 * Regex backstop for Japanese business-card field extraction.
 *
 * Runs on YomiToku-style raw paragraph text and pulls out the high-confidence
 * fields (email, phone, FAX, mobile, postal, URL, 〒). Never produces a name
 * or company — those need LLM or layout-rules.
 *
 * Purpose: always-on safety net under the LLM. If the LLM mis-orders or
 * hallucinates a phone number, regex output overrides it. If the LLM drops
 * a field, regex fills it in.
 *
 * Input: a `text` string (concatenated paragraphs, line-broken) OR a
 *        YomiToku JSON-style array of paragraphs { contents }.
 * Output: { tel, fax, mobile, email, url, postal } with null for missing.
 */

const RE_EMAIL =
  /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g

// Broken-email indicators: YomiToku often splits "info@offisis.co.jp" into
// "info@" + "0" + "si" + "is.co.jp" or similar fragments separated by
// newlines. We detect "<localpart>@" alone and a separate ".tld"-bearing
// fragment, then attempt to stitch with the domain from a URL or company.
const RE_EMAIL_LOCALPART_ONLY = /([A-Za-z0-9._%+\-]+)@(?!\S*\.\w{2,})/g
const RE_DOMAIN_FRAGMENT =
  /\b((?:[A-Za-z0-9\-]+\.){1,3}(?:com|jp|net|org|co\.jp|or\.jp|ne\.jp|ac\.jp|go\.jp|gr\.jp|edu|info|biz|app|dev|io|me))\b/gi

// JP phone forms:
//   0X-XXXX-XXXX (固定)        e.g. 03-3609-3446
//   0X-XXX-XXXX  (一部地方)
//   0XX-XXX-XXXX (北海道など)
//   0XXX-XX-XXXX (より細かい)
//   090/080/070-XXXX-XXXX (携帯)
//   +81-X-XXXX-XXXX (国際)
//   (03) 6908 3210  (parens + spaces — common on cards)
const RE_PHONE_JP =
  /(?:\+81[-－―]?[1-9]|0\d{1,4})[-－―]\d{1,4}[-－―]\d{3,4}/g
const RE_PHONE_PARENS =
  /(?:\+81|0)\(?\d{1,4}\)?[-－―\s]?\d{1,4}[-－―\s]?\d{3,4}/g

// 〒 + 3-4 digits. Require 〒 to avoid eating the first 7 digits of a phone
// number like "090-5516-1153". Cards lacking 〒 will miss postal — acceptable
// false-negative rate; LLM stage covers the remainder.
const RE_POSTAL_JP =
  /〒\s*(\d{3}|[０-９]{3})[-－―ー]?\s*(\d{4}|[０-９]{4})/g

// URL — generous, drops trailing punctuation
const RE_URL =
  /https?:\/\/[^\s<>"'）)]+|(?<![\w/])(?:www\.)[A-Za-z0-9.\-/_?=&%]+/g

// "TEL:", "FAX:", "Mobile:", "携帯:" prefix capture. Allow parens for forms
// like "TEL:(03) 6908 3210" common on JP cards.
const PHONE_DIGITS = `[\\+\\d\\-－―\\s()（）]+`
const PREFIX_TEL = new RegExp(`(?:TEL|Tel|tel|電話|☎|℡)[:：]?\\s*(${PHONE_DIGITS})`, 'g')
const PREFIX_FAX = new RegExp(`(?:FAX|Fax|fax|ＦＡＸ)[:：]?\\s*(${PHONE_DIGITS})`, 'g')
const PREFIX_MOBILE = new RegExp(`(?:Mobile|MOBILE|mobile|携帯|Cell|cell|CELL)[:：]?\\s*(${PHONE_DIGITS})`, 'g')

function normalizeDigits(s) {
  // full-width → half-width digits; normalize separators to '-'; collapse runs.
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－―ー]/g, '-')
    .replace(/[()（）]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizePhone(raw) {
  if (!raw) return null
  const d = normalizeDigits(raw)
  const m = d.match(/(\+?\d[\d\-]{7,18}\d)/)
  return m ? m[1] : null
}

function pickFirst(re, text) {
  const m = text.match(re)
  return m ? m[0] : null
}

function pickPrefix(re, text) {
  re.lastIndex = 0
  const m = re.exec(text)
  if (!m) return null
  return normalizePhone(m[1])
}

/**
 * Phone numbers that look like mobile (start with 070/080/090 after normalize).
 */
function isMobile(phoneStr) {
  if (!phoneStr) return false
  const n = phoneStr.replace(/\D/g, '')
  return /^0[789]0\d{8}$/.test(n) || /^\+810[789]0\d{8}$/.test(n)
}

/**
 * @param {string|Array<{contents:string}>} input
 */
export function extractRuleFields(input) {
  let text
  if (Array.isArray(input)) {
    text = input.map((p) => p.contents ?? '').join('\n')
  } else {
    text = String(input ?? '')
  }
  text = text.replace(/\r/g, '')

  let email = pickFirst(RE_EMAIL, text)
  const url = pickFirst(RE_URL, text)

  // Broken-email reconstruction: when YomiToku splits the email across
  // paragraphs we get "info@" on one line and ".offisis.co.jp" or
  // "is.co.jp" on another. Find an orphan localpart@ and pair it with
  // either (a) a domain fragment elsewhere in the text or (b) the URL host.
  if (!email) {
    RE_EMAIL_LOCALPART_ONLY.lastIndex = 0
    const localMatch = RE_EMAIL_LOCALPART_ONLY.exec(text)
    if (localMatch) {
      const localpart = localMatch[1]
      // Strategy 1: any complete domain fragment in the text
      RE_DOMAIN_FRAGMENT.lastIndex = 0
      const domainMatches = []
      let m
      while ((m = RE_DOMAIN_FRAGMENT.exec(text)) !== null) {
        domainMatches.push(m[1])
      }
      // Strategy 2: derive domain from URL hostname
      let urlHost = null
      if (url) {
        const um = url.match(/https?:\/\/(?:www\.)?([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/) ||
          url.match(/(?:www\.)?([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/)
        if (um) urlHost = um[1].toLowerCase()
      }
      // Prefer the URL host (more reliable) over loose domain fragments
      const candidate = urlHost ?? domainMatches[0]
      if (candidate) {
        const synthesized = `${localpart}@${candidate}`
        // Sanity check: re-match against the full email regex
        if (RE_EMAIL.test(synthesized)) {
          email = synthesized
        }
        RE_EMAIL.lastIndex = 0
      }
    }
  }

  // Postal: pick the first 3+4 group
  let postal = null
  RE_POSTAL_JP.lastIndex = 0
  const pm = RE_POSTAL_JP.exec(text)
  if (pm) {
    const a = normalizeDigits(pm[1])
    const b = normalizeDigits(pm[2])
    postal = `${a}-${b}`
  }

  // Phone-like things:
  //   1) explicit prefixed (TEL:/FAX:/Mobile:)
  //   2) fall through to first/second bare match if prefix missing
  const telPrefixed = pickPrefix(PREFIX_TEL, text)
  const faxPrefixed = pickPrefix(PREFIX_FAX, text)
  const mobPrefixed = pickPrefix(PREFIX_MOBILE, text)

  const allBare = []
  let m
  RE_PHONE_JP.lastIndex = 0
  while ((m = RE_PHONE_JP.exec(text)) !== null) {
    allBare.push(normalizeDigits(m[0]))
  }
  // Also try parens form like "(03) 6908 3210"; dedupe against allBare.
  RE_PHONE_PARENS.lastIndex = 0
  while ((m = RE_PHONE_PARENS.exec(text)) !== null) {
    const n = normalizeDigits(m[0])
    if (n.replace(/\D/g, '').length >= 9 && !allBare.includes(n)) allBare.push(n)
  }

  // Disambiguate: a bare number already matched by prefix should not be re-assigned.
  const usedSet = new Set(
    [telPrefixed, faxPrefixed, mobPrefixed].filter(Boolean).map((s) => s.replace(/\D/g, ''))
  )
  const unused = allBare.filter((n) => !usedSet.has(n.replace(/\D/g, '')))

  // mobile bias: any unused mobile-prefix number goes to mobile slot
  let mobile = mobPrefixed
  if (!mobile) {
    const idx = unused.findIndex(isMobile)
    if (idx >= 0) {
      mobile = unused[idx]
      unused.splice(idx, 1)
    }
  }

  // tel: prefix wins, else first non-mobile remaining
  let tel = telPrefixed
  if (!tel) {
    const idx = unused.findIndex((n) => !isMobile(n))
    if (idx >= 0) {
      tel = unused[idx]
      unused.splice(idx, 1)
    }
  }

  // fax: prefix wins, else second non-mobile remaining
  let fax = faxPrefixed
  if (!fax) {
    const idx = unused.findIndex((n) => !isMobile(n))
    if (idx >= 0) {
      fax = unused[idx]
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

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const sample1 = `込田友紀子
090-5516-1153
会社 /中野組商事(有)取締役
〒125-0042
東京都葛飾区金町4-10-9
TEL : 03-3609-3446 FAX : 03-3609-3454`

  const sample2 = `野口 明雄
Mobile:080-2673-6319
Email:akionoguchi7@gmail.com`

  console.log('--- sample 1 (込田) ---')
  console.log(extractRuleFields(sample1))
  console.log('--- sample 2 (野口) ---')
  console.log(extractRuleFields(sample2))
}
