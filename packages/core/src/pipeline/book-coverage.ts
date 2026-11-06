/**
 * Book coverage: which printed pages have been captured, which are missing,
 * in page order — the strip under the capture screen and the list after it.
 *
 * Unlike `checkPageSequence` (capture order: a lower number than the last
 * one is "out of order"), this works on the SET of pages taken so far, so a
 * user who skipped 38・39, went on to 40・41 and then went back fills the
 * gap: the red range turns green the moment 38・39 is read.
 *
 * Pure logic; the caller reads the numbers (OCR) and keeps the sheets.
 */

/** One page of a capture: its printed number as far as it is known. */
export interface BookPageRead {
  /**
   * `read`: `number` is the printed number. `pending`: still being read.
   * `none`: read, no number found (figure pages, blank pages, unreadable).
   */
  readonly state: 'read' | 'pending' | 'none'
  readonly number?: number
  /** The number was not read but follows from the facing page's (±1). */
  readonly inferred?: boolean
}

/** One automatic capture: a single page, or a spread (left, right). */
export interface BookSheet {
  readonly id: string
  /** Capture order (increasing). */
  readonly seq: number
  readonly pages: readonly BookPageRead[]
}

export interface BookGap {
  readonly from: number
  readonly to: number
  /** 2 when only every other page is taken (one side of the book). */
  readonly step: 1 | 2
}

export type BookStripItem =
  | {
      readonly kind: 'sheet'
      readonly sheetId: string
      /** Printed number of each page of the sheet (null: none / pending). */
      readonly numbers: readonly (number | null)[]
      readonly state: 'ok' | 'pending' | 'nonum'
    }
  | ({ readonly kind: 'gap' } & BookGap)

export interface BookCoverage {
  /** Sheets and red gaps in page order. */
  readonly items: readonly BookStripItem[]
  /** Pages known missing (red). */
  readonly gaps: readonly BookGap[]
  readonly step: 1 | 2
  /** Pages taken (a spread counts 2). */
  readonly pageCount: number
}

export const BOOK_COVERAGE_DEFAULTS = {
  /** A jump wider than this is a misread, not a gap. */
  maxGap: 20,
}

/** Fill a spread's unread half from its read half (left = right − 1). */
export function completeSpread(pages: readonly BookPageRead[]): BookPageRead[] {
  if (pages.length !== 2) return [...pages]
  const [l, r] = pages as [BookPageRead, BookPageRead]
  if (l.state === 'read' && r.state === 'none' && l.number !== undefined)
    return [l, { state: 'read', number: l.number + 1, inferred: true }]
  if (
    r.state === 'read' &&
    l.state === 'none' &&
    r.number !== undefined &&
    r.number > 1
  )
    return [{ state: 'read', number: r.number - 1, inferred: true }, r]
  return [l, r]
}

interface NumberedAt {
  number: number
  seq: number
}

/** Coverage of the sheets taken so far. */
export function bookCoverage(
  sheets: readonly BookSheet[],
  opts: Partial<typeof BOOK_COVERAGE_DEFAULTS> = {},
): BookCoverage {
  const o = { ...BOOK_COVERAGE_DEFAULTS, ...opts }
  const ordered = [...sheets].sort((a, b) => a.seq - b.seq)
  const full = ordered.map((s) => ({ ...s, pages: completeSpread(s.pages) }))

  const numbered: NumberedAt[] = []
  for (const s of full)
    for (const p of s.pages)
      if (p.state === 'read' && p.number !== undefined)
        numbered.push({ number: p.number, seq: s.seq })

  // Step: 2 when only single pages were taken and every number has the
  // same parity (one side of the book, e.g. every right page).
  const anySpread = full.some((s) => s.pages.length === 2)
  const nums = [...new Set(numbered.map((n) => n.number))].sort((a, b) => a - b)
  const sameParity =
    nums.length >= 2 && nums.every((n) => n % 2 === nums[0]! % 2)
  const step: 1 | 2 = !anySpread && sameParity ? 2 : 1

  const seqOf = new Map<number, number>()
  for (const n of numbered) if (!seqOf.has(n.number)) seqOf.set(n.number, n.seq)

  // Unnumbered pages per capture: `none` covers a gap, `pending` defers it.
  const unnumberedBetween = (s0: number, s1: number) => {
    const lo = Math.min(s0, s1)
    const hi = Math.max(s0, s1)
    let none = 0
    let pending = 0
    for (const s of full) {
      if (s.seq <= lo || s.seq >= hi) continue
      for (const p of s.pages) {
        if (p.state === 'none') none++
        else if (p.state === 'pending') pending++
      }
    }
    return { none, pending }
  }

  const gaps: BookGap[] = []
  for (let i = 1; i < nums.length; i++) {
    const a = nums[i - 1]!
    const b = nums[i]!
    if (b - a <= step) continue
    if (step === 2 && (b - a) % 2 !== 0) continue
    const count = (b - a) / step - 1
    if (b - a - 1 > o.maxGap) continue
    const { none, pending } = unnumberedBetween(seqOf.get(a)!, seqOf.get(b)!)
    if (pending > 0) continue // decided once those pages are read
    if (none >= count) continue // figure pages without a number
    gaps.push({ from: a + step, to: b - step, step })
  }

  // Strip: numbered sheets at their (lowest) number; unnumbered ones right
  // after the sheet taken before them.
  type Placed = { key: number; seq: number; item: BookStripItem }
  const placed: Placed[] = []
  let lastKey = -Infinity
  for (const s of full) {
    const numbers = s.pages.map((p) =>
      p.state === 'read' && p.number !== undefined ? p.number : null,
    )
    const known = numbers.filter((n): n is number => n !== null)
    const pending = s.pages.some((p) => p.state === 'pending')
    const state: 'ok' | 'pending' | 'nonum' =
      known.length > 0 ? 'ok' : pending ? 'pending' : 'nonum'
    const key =
      known.length > 0
        ? Math.min(...known)
        : lastKey === -Infinity
          ? -1e9 + s.seq
          : lastKey + 1e-3
    lastKey = key
    placed.push({
      key,
      seq: s.seq,
      item: { kind: 'sheet', sheetId: s.id, numbers, state },
    })
  }
  for (const g of gaps)
    placed.push({ key: g.from, seq: -1, item: { kind: 'gap', ...g } })
  placed.sort((x, y) => x.key - y.key || x.seq - y.seq)

  return {
    items: placed.map((p) => p.item),
    gaps,
    step,
    pageCount: full.reduce((n, s) => n + s.pages.length, 0),
  }
}

/**
 * Sheet already holding one of `numbers` (the same page taken again), or
 * null. Used to drop a re-capture and say "撮影済み".
 */
export function sheetWithNumbers(
  sheets: readonly BookSheet[],
  numbers: readonly number[],
  exceptId?: string,
): BookSheet | null {
  if (numbers.length === 0) return null
  for (const s of sheets) {
    if (s.id === exceptId) continue
    for (const p of completeSpread(s.pages))
      if (
        p.state === 'read' &&
        p.number !== undefined &&
        !p.inferred &&
        numbers.includes(p.number)
      )
        return s
  }
  return null
}

/** Gaps in `after` that were not in `before` (a page was just skipped). */
export function newGaps(
  before: readonly BookGap[],
  after: readonly BookGap[],
): BookGap[] {
  return after.filter(
    (g) => !before.some((b) => b.from <= g.from && b.to >= g.to),
  )
}

/** Gaps of `before` that `after` no longer has, fully or partly (filled). */
export function filledGaps(
  before: readonly BookGap[],
  after: readonly BookGap[],
): BookGap[] {
  return before.filter(
    (b) => !after.some((g) => g.from === b.from && g.to === b.to),
  )
}

/** "38・39" / "46" / "38〜41" for a range of pages. */
export function pageRangeLabel(
  from: number,
  to: number,
  step: 1 | 2 = 1,
): string {
  if (from === to) return String(from)
  if (step === 1 && to === from + 1) return `${from}・${to}`
  if (step === 2 && to === from + 2) return `${from}・${to}`
  return `${from}〜${to}`
}
