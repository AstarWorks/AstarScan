/**
 * Printed page numbers ("ノンブル") — read them from OCR lines in the top /
 * bottom margins, then check a captured sequence for missing and
 * duplicated pages.
 *
 * Pure logic: the caller runs OCR (NDLOCR in the web app) and passes the
 * recognised lines with their centres normalised to the page.
 */

export interface PageNumberLine {
  readonly text: string
  /** Line centre, 0..1 from the page's left edge. */
  readonly cx: number
  /** Line centre, 0..1 from the page's top edge. */
  readonly cy: number
}

export interface PageNumberToken {
  readonly value: number
  /** `arabic` / `kanji`: the whole line is the number (with decorations).
   *  `edge`: a number at the start or end of a running head. */
  readonly kind: 'arabic' | 'kanji' | 'edge'
}

const MAX_PAGE_NUMBER = 3000

/** Decorations commonly printed around a page number: "- 12 -", "(12)", "〈12〉". */
const DECORATION =
  /^[\s\-–—―‐ー~〜・.,:()（）[\]［］<>〈〉《》「」|｜*]+|[\s\-–—―‐ー~〜・.,:()（）[\]［］<>〈〉《》「」|｜*]+$/g

const KANJI_DIGIT: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}
const KANJI_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

/** "一二三" → 123, "百二十三" → 123, "十" → 10. null when not a kanji numeral. */
export function kanjiToNumber(s: string): number | null {
  if (s.length === 0) return null
  const chars = [...s]
  if (!chars.every((c) => c in KANJI_DIGIT || c in KANJI_UNIT)) return null
  if (!chars.some((c) => c in KANJI_UNIT)) {
    // Positional: 一二三 = 123.
    return chars.reduce((n, c) => n * 10 + KANJI_DIGIT[c]!, 0)
  }
  let total = 0
  let digit: number | null = null
  for (const c of chars) {
    const unit = KANJI_UNIT[c]
    if (unit !== undefined) {
      total += (digit ?? 1) * unit
      digit = null
    } else {
      if (digit !== null) return null // "二三十" is not a numeral
      digit = KANJI_DIGIT[c]!
    }
  }
  return total + (digit ?? 0)
}

function valid(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE_NUMBER
}

/** Read one OCR line as a page number, or null when it is not one. */
export function parsePageNumberToken(text: string): PageNumberToken | null {
  const raw = text.normalize('NFKC').trim()
  if (raw.length === 0) return null
  const core = raw.replace(DECORATION, '').replace(/\s+/g, '')

  let m = /^(?:p\.?|P\.?)?(\d{1,4})$/.exec(core)
  if (!m) m = /^第?(\d{1,4})(?:頁|ページ)$/.exec(core)
  if (m) {
    const v = Number(m[1])
    return valid(v) ? { value: v, kind: 'arabic' } : null
  }

  const kanji = /^第?([〇零一二三四五六七八九十百千]{1,6})(?:頁|ページ)?$/.exec(
    core,
  )
  if (kanji) {
    const v = kanjiToNumber(kanji[1]!)
    return v !== null && valid(v) ? { value: v, kind: 'kanji' } : null
  }

  // Running head with the number at one end: "12 契約の成立" / "契約の成立 12".
  const edge = /^(\d{1,4})\s+\S/.exec(raw) ?? /\S\s+(\d{1,4})$/.exec(raw)
  if (edge) {
    const v = Number(edge[1])
    return valid(v) ? { value: v, kind: 'edge' } : null
  }
  return null
}

const KIND_SCORE = { arabic: 3, kanji: 2, edge: 1 } as const

interface Candidate {
  value: number
  score: number
  cx: number
  top: boolean
}

/**
 * Pick the printed page number(s) of one captured image. Only lines whose
 * centre lies in the top or bottom `marginFrac` of the page are considered.
 * Returns one number, two numbers for a two-page spread (one number in each
 * half, differing by one), or none.
 */
export function pickPageNumbers(
  lines: readonly PageNumberLine[],
  marginFrac = 0.15,
): number[] {
  const cands: Candidate[] = []
  for (const l of lines) {
    const top = l.cy <= marginFrac
    const bottom = l.cy >= 1 - marginFrac
    if (!top && !bottom) continue
    const tok = parsePageNumberToken(l.text)
    if (!tok) continue
    // Nearer the page edge wins ties (body text near the margin loses).
    const edgeDist = top ? l.cy : 1 - l.cy
    cands.push({
      value: tok.value,
      score: KIND_SCORE[tok.kind] + (marginFrac - edgeDist) / marginFrac,
      cx: l.cx,
      top,
    })
  }
  if (cands.length === 0) return []
  cands.sort((a, b) => b.score - a.score)
  const best = cands[0]!

  // Spread: a strong number on the other half, same band, ±1 apart.
  const other = cands.find(
    (c) =>
      c.score >= KIND_SCORE.kanji &&
      c.top === best.top &&
      c.cx < 0.5 !== best.cx < 0.5 &&
      Math.abs(c.value - best.value) === 1,
  )
  if (best.score >= KIND_SCORE.kanji && other) {
    return [
      Math.min(best.value, other.value),
      Math.max(best.value, other.value),
    ]
  }
  return [best.value]
}

export type PageNumberState = 'ok' | 'duplicate' | 'unread' | 'outOfOrder'

export interface PageNumberCheck {
  readonly state: PageNumberState
  /** Index of the earlier capture carrying the same number (`duplicate`). */
  readonly duplicateOf: number | null
}

export interface MissingPageRange {
  readonly from: number
  readonly to: number
  /** The gap sits just before the capture at this index. */
  readonly beforeIndex: number
  /** The gap is wider than `maxGap` — more likely a misread than a miss. */
  readonly suspect: boolean
}

export interface PageSequenceCheck {
  readonly pages: readonly PageNumberCheck[]
  readonly missing: readonly MissingPageRange[]
}

/**
 * Check the printed numbers of captures in capture order. `[]` means the
 * number could not be read. Numbers are expected to increase; a number
 * seen before is a duplicate, a lower number than the last one is out of
 * order, and a jump leaves a missing range.
 */
export function checkPageSequence(
  pages: readonly (readonly number[])[],
  maxGap = 20,
): PageSequenceCheck {
  const seen = new Map<number, number>()
  const out: PageNumberCheck[] = []
  const missing: MissingPageRange[] = []
  let last: number | null = null

  pages.forEach((nums, i) => {
    if (nums.length === 0) {
      out.push({ state: 'unread', duplicateOf: null })
      return
    }
    const sorted = [...nums].sort((a, b) => a - b)
    const lo = sorted[0]!
    const hi = sorted[sorted.length - 1]!
    const dup = sorted.find((n) => seen.has(n))
    if (dup !== undefined) {
      out.push({ state: 'duplicate', duplicateOf: seen.get(dup)! })
      return
    }
    for (const n of sorted) seen.set(n, i)
    if (last !== null && lo < last) {
      out.push({ state: 'outOfOrder', duplicateOf: null })
      return
    }
    if (last !== null && lo > last + 1) {
      missing.push({
        from: last + 1,
        to: lo - 1,
        beforeIndex: i,
        suspect: lo - 1 - last > maxGap,
      })
    }
    last = hi
    out.push({ state: 'ok', duplicateOf: null })
  })

  return { pages: out, missing }
}
