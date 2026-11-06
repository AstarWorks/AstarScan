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
  inferred: boolean
  /** Both halves of its spread were read and follow each other. */
  pair: boolean
}

/**
 * Coverage of the sheets taken so far.
 *
 * A misread number must not raise a red gap (the Android check's "false
 * red"): a gap is drawn only between TRUSTED numbers —
 *   - a number another capture's number follows or precedes (n ± step), or
 *   - both halves of a spread read on their own and consecutive (34・35).
 * A gap wider than one spread (> 2 pages) also needs its upper bound
 * trusted by a neighbour, not only by its own pair (a pair misread as
 * 18・19 after 8・9 waits instead of turning 10〜17 red). Single pages taken
 * one side only (31, 33, 35) step by 2, decided by the parity of most of
 * their numbers; a number of the other parity is then not trusted.
 */
export function bookCoverage(
  sheets: readonly BookSheet[],
  opts: Partial<typeof BOOK_COVERAGE_DEFAULTS> = {},
): BookCoverage {
  const o = { ...BOOK_COVERAGE_DEFAULTS, ...opts }
  const ordered = [...sheets].sort((a, b) => a.seq - b.seq)
  const full = ordered.map((s) => ({ ...s, pages: completeSpread(s.pages) }))

  const numbered: NumberedAt[] = []
  for (const s of ordered) {
    const own = s.pages
    const pair =
      own.length === 2 &&
      own.every((p) => p.state === 'read' && !p.inferred) &&
      own[1]!.number === own[0]!.number! + 1
    for (const p of completeSpread(own))
      if (p.state === 'read' && p.number !== undefined)
        numbered.push({
          number: p.number,
          seq: s.seq,
          inferred: !!p.inferred,
          pair,
        })
  }

  // Step: 2 when only single pages were taken and most of their numbers
  // (3 in 4) share a parity (one side of the book, e.g. every right page).
  const anySpread = full.some((s) => s.pages.length === 2)
  const direct = numbered.filter((n) => !n.inferred)
  const odd = direct.filter((n) => n.number % 2 === 1).length
  const even = direct.length - odd
  const step: 1 | 2 =
    !anySpread &&
    direct.length >= 2 &&
    Math.max(odd, even) >= 0.75 * direct.length &&
    Math.min(odd, even) <= 1
      ? 2
      : 1
  const parity = odd >= even ? 1 : 0

  /** n is followed / preceded by a number of ANOTHER capture. */
  const neighbour = (x: NumberedAt) =>
    numbered.some(
      (y) =>
        y.seq !== x.seq &&
        !y.inferred &&
        Math.abs(y.number - x.number) === step,
    )
  const trusted = new Map<number, { seq: number; byNeighbour: boolean }>()
  for (const x of numbered) {
    if (x.inferred && !x.pair) {
      // An inferred half counts only through its read half's trust.
      continue
    }
    if (step === 2 && x.number % 2 !== parity) continue
    const nb = neighbour(x)
    if (!nb && !x.pair) continue
    const prev = trusted.get(x.number)
    if (!prev || (nb && !prev.byNeighbour))
      trusted.set(x.number, { seq: x.seq, byNeighbour: nb })
  }
  // The inferred half of a trusted spread is trusted with it.
  for (const s of ordered) {
    const full2 = completeSpread(s.pages)
    if (full2.length !== 2) continue
    const nums = full2.map((p) => (p.state === 'read' ? p.number : undefined))
    if (nums[0] === undefined || nums[1] === undefined) continue
    const t0 = trusted.get(nums[0])
    const t1 = trusted.get(nums[1])
    if (t0 && !t1) trusted.set(nums[1], { seq: s.seq, byNeighbour: false })
    if (t1 && !t0) trusted.set(nums[0], { seq: s.seq, byNeighbour: false })
  }

  // Captures between two trusted numbers whose number is not trusted
  // (none, or read but unconfirmed) may be the missing pages: they cover a
  // gap of their count; `pending` (still being read) defers it.
  const trustedSeqNums = new Set(
    [...trusted.entries()].map(([n, t]) => `${t.seq}:${n}`),
  )
  const unnumberedBetween = (s0: number, s1: number) => {
    const lo = Math.min(s0, s1)
    const hi = Math.max(s0, s1)
    let none = 0
    let pending = 0
    for (const s of full) {
      if (s.seq <= lo || s.seq >= hi) continue
      for (const p of s.pages) {
        if (p.state === 'pending') pending++
        else if (p.state === 'none') none++
        else if (
          p.number !== undefined &&
          !trustedSeqNums.has(`${s.seq}:${p.number}`)
        )
          none++
      }
    }
    return { none, pending }
  }

  const nums = [...trusted.keys()].sort((a, b) => a - b)
  const gaps: BookGap[] = []
  for (let i = 1; i < nums.length; i++) {
    const a = nums[i - 1]!
    const b = nums[i]!
    if (b - a <= step) continue
    if (step === 2 && (b - a) % 2 !== 0) continue
    const count = (b - a) / step - 1
    if (b - a - 1 > o.maxGap) continue
    const ta = trusted.get(a)!
    const tb = trusted.get(b)!
    if (b - a - 1 > 2 && !(ta.byNeighbour && tb.byNeighbour)) continue
    const { none, pending } = unnumberedBetween(ta.seq, tb.seq)
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

/**
 * Numbers read directly (not inferred) on `sheets` that another of them
 * confirms: a number of another capture within 2 (34 next to 35, the next
 * spread's 36, or every right page 31, 33). One capture alone, even a spread
 * whose halves follow each other, confirms nothing.
 */
function confirmedNumbers(sheets: readonly BookSheet[]): number[] {
  const direct = sheets.flatMap((s) =>
    s.pages
      .filter((p) => p.state === 'read' && !p.inferred && p.number !== undefined)
      .map((p) => ({ seq: s.seq, n: p.number! })),
  )
  return direct
    .filter((x) =>
      direct.some((y) => y.seq !== x.seq && Math.abs(y.n - x.n) <= 2),
    )
    .map((x) => x.n)
}

/**
 * Whether the numbers read on the capture `sheetId` fit the order the book
 * has been taken in, so that they may count as pages taken.
 *
 * Pages are turned forward. Going back is to fill a gap or to a page taken
 * already — both at or above the lowest page taken so far. A number below
 * every number the earlier captures confirm among themselves (90〜95 taken,
 * then "88・89") is a misread far more often than a user going back before
 * the first page: book 2 (FreeSerif) read 98・99 as 88・89 and 96・97 as
 * 8・9, and taking them as read showed "✓ 88・89 撮れた" and hid the real
 * 88・89 / 96・97 that were missing. Such a capture is kept, without a
 * number (読めず): no ✓ with a number, never a page marked taken.
 *
 * Only numbers confirmed by another capture set the bar, so one misread
 * capture (a lone "72・73" read for 12・13) does not lock out the right
 * numbers after it.
 */
export function numbersFitOrder(
  sheets: readonly BookSheet[],
  sheetId: string,
): boolean {
  const s = sheets.find((x) => x.id === sheetId)
  if (!s) return true
  const own = s.pages
    .filter((p) => p.state === 'read' && !p.inferred && p.number !== undefined)
    .map((p) => p.number!)
  if (own.length === 0) return true
  const before = confirmedNumbers(sheets.filter((x) => x.seq < s.seq))
  if (before.length === 0) return true
  return Math.min(...own) >= Math.min(...before)
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
