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
  /**
   * Height (page px) of the printed number as read. Unknown: taken as a
   * size the reader is sure at (see `settleBookNumbers`).
   */
  readonly px?: number
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

/**
 * Numbers a capture counts for: those read on it, and the half of a spread
 * inferred from its read half (left = right − 1). None when nothing was
 * read on it.
 */
function countedNumbers(s: BookSheet): number[] {
  return completeSpread(s.pages)
    .filter((p) => p.state === 'read' && p.number !== undefined)
    .map((p) => p.number!)
}

/** Both halves of a spread read on their own and consecutive (34・35). */
function readPair(s: BookSheet): boolean {
  const own = s.pages
  return (
    own.length === 2 &&
    own.every((p) => p.state === 'read' && !p.inferred) &&
    own[1]!.number === own[0]!.number! + 1
  )
}

/**
 * Whether two captures' numbers touch: the lowest of one is `gaps` above
 * the highest of the other — the next spread (66・67 then 68・69, whichever
 * half of each was read: 67 | 68), the next page taken one side only
 * (31, 33). Captures holding the same page (a retake) do not touch.
 */
function touching(
  a: readonly number[],
  b: readonly number[],
  gaps: readonly number[],
): boolean {
  if (a.length === 0 || b.length === 0) return false
  return (
    gaps.includes(Math.min(...b) - Math.max(...a)) ||
    gaps.includes(Math.min(...a) - Math.max(...b))
  )
}

/** Whether another of `sheets` touches `s` (its counted numbers). */
function touchesAnother(
  s: BookSheet,
  sheets: readonly BookSheet[],
  gaps: readonly number[],
): boolean {
  const own = countedNumbers(s)
  return sheets.some(
    (o) => o.id !== s.id && touching(own, countedNumbers(o), gaps),
  )
}

/**
 * Coverage of the sheets taken so far.
 *
 * A misread number must not raise a red gap (the Android check's "false
 * red"): a gap is drawn only between TRUSTED numbers — those of a capture
 *   - whose numbers another capture's touch (the next spread: 66・67 then
 *     68・69, whichever half of each was read — the half inferred from a
 *     read half counts, as 67 | 68 does; book 4's 1440×1920 spreads were
 *     read on the left one time and on the right the next, 66 and 69 three
 *     apart, and nothing was trusted), or
 *   - a spread both of whose halves were read on their own and follow each
 *     other (34・35).
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

  // Step: 2 when only single pages were taken and most of their numbers
  // (3 in 4) share a parity (one side of the book, e.g. every right page).
  const anySpread = full.some((s) => s.pages.length === 2)
  const direct = directNumbers(ordered)
  const odd = direct.filter((x) => x.n % 2 === 1).length
  const even = direct.length - odd
  const step: 1 | 2 =
    !anySpread &&
    direct.length >= 2 &&
    Math.max(odd, even) >= 0.75 * direct.length &&
    Math.min(odd, even) <= 1
      ? 2
      : 1
  const parity = odd >= even ? 1 : 0

  const trusted = new Map<number, { seq: number; byNeighbour: boolean }>()
  for (const s of ordered) {
    const own = countedNumbers(s)
    if (own.length === 0) continue
    const nb = touchesAnother(s, ordered, [step])
    if (!nb && !readPair(s)) continue
    for (const n of own) {
      if (step === 2 && n % 2 !== parity) continue
      const prev = trusted.get(n)
      if (!prev || (nb && !prev.byNeighbour))
        trusted.set(n, { seq: s.seq, byNeighbour: nb })
    }
  }

  // Captures between two trusted numbers whose number is not trusted
  // (none, or read but unconfirmed) may be the missing pages: while there
  // is one, no page of the gap can be named (book 4: 64・65 unread between
  // 61 and 66, 62・63 skipped — "62〜65" would be red on a page that was
  // taken), so the gap waits, as it does for `pending` (still being read).
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
    if (b - a - 1 > o.maxGap) continue
    const ta = trusted.get(a)!
    const tb = trusted.get(b)!
    if (b - a - 1 > 2 && !(ta.byNeighbour && tb.byNeighbour)) continue
    const { none, pending } = unnumberedBetween(ta.seq, tb.seq)
    if (pending > 0) continue // decided once those pages are read
    if (none > 0) continue // figure pages without a number, or the gap itself
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

/** Numbers read directly (not inferred) on `sheets`, with their capture. */
function directNumbers(
  sheets: readonly BookSheet[],
): { seq: number; n: number }[] {
  return sheets.flatMap((s) =>
    s.pages
      .filter(
        (p) => p.state === 'read' && !p.inferred && p.number !== undefined,
      )
      .map((p) => ({ seq: s.seq, n: p.number! })),
  )
}

/**
 * Numbers read directly on `sheets` that another of them confirms: the
 * capture's numbers touch another capture's, 1 or 2 apart (34・35 then
 * 36・37 whichever halves were read, every right page 31, 33). One capture
 * alone, even a spread whose halves follow each other, confirms nothing;
 * nor does the same page taken again.
 */
function confirmedNumbers(
  sheets: readonly BookSheet[],
): { seq: number; n: number }[] {
  return sheets
    .filter((s) => touchesAnother(s, sheets, [1, 2]))
    .flatMap((s) => directNumbers([s]))
}

/**
 * Whether the numbers read on the capture `sheetId` fit the order the book
 * has been taken in, so that they may count as pages taken. Call it again
 * for every capture once a new one is read: the captures after a page
 * judge it too.
 *
 * Pages are turned forward. Going back is to fill a gap or to a page taken
 * already — both at or above the lowest page taken so far, and below a page
 * taken before. A capture does not fit when
 *
 * 1. its number is below every number the earlier captures confirm among
 *    themselves (90〜95 taken, then "88・89"): book 2 (FreeSerif) read
 *    98・99 as 88・89 and 96・97 as 8・9, and taking them as read showed
 *    "✓ 88・89 撮れた" and hid the real 88・89 / 96・97 that were missing;
 * 2. its number is below every number read before it, confirmed or not,
 *    and far below the next confirmed number after it — more than the
 *    captures in between can turn (book 2: 205 read as 5 between 201 and
 *    209, 211, …);
 * 3. nothing before it is below it or next to it, and at least two
 *    confirmed numbers after it are below it: the book went on from below
 *    (book 1: the first page 31 read as 40, then 33, 35, …).
 *
 * Such a capture is kept, without a number (読めず): no ✓ with a number,
 * never a page marked taken. Only confirmed numbers set the bar on 1 and
 * 2's far side, so one misread capture (a lone "72・73" read for 12・13)
 * does not lock out the right numbers after it — 3 drops it instead.
 */
export function numbersFitOrder(
  sheets: readonly BookSheet[],
  sheetId: string,
): boolean {
  const s = sheets.find((x) => x.id === sheetId)
  if (!s) return true
  const own = directNumbers([s]).map((x) => x.n)
  if (own.length === 0) return true
  const lo = Math.min(...own)
  const hi = Math.max(...own)
  const earlier = sheets.filter((x) => x.seq < s.seq)
  const before = confirmedNumbers(earlier).map((x) => x.n)
  if (before.length > 0 && lo < Math.min(...before)) return false

  const others = sheets.filter((x) => x.id !== s.id)
  const laterConfirmed = confirmedNumbers(others).filter((x) => x.seq > s.seq)
  const allBefore = directNumbers(earlier).map((x) => x.n)
  if (laterConfirmed.length > 0 && allBefore.length > 0) {
    const nextSeq = Math.min(...laterConfirmed.map((x) => x.seq))
    const next = Math.min(
      ...laterConfirmed.filter((x) => x.seq === nextSeq).map((x) => x.n),
    )
    // Captures from this one to the next confirmed one, each turning at
    // most a spread (2 pages), and one spread more of slack.
    const between = sheets.filter(
      (x) => x.seq > s.seq && x.seq <= nextSeq,
    ).length
    if (lo < Math.min(...allBefore) && next - hi > 2 * between + 2) return false
  }
  const below = new Set(
    laterConfirmed.filter((x) => x.n < lo).map((x) => x.seq),
  )
  if (below.size >= 2 && !allBefore.some((n) => n <= hi + 2)) return false
  return true
}

export const BOOK_NUMBER_DEFAULTS = {
  /**
   * A spread whose number nothing else confirms is taken as read only when
   * both halves were read on their own at this height (page px) or more.
   * At 720×960 an upright spread's numbers are 4–5 px: the browser read
   * them wrong as often as right there (books 1–3, run5: 4 right / 6 wrong
   * pages among the numbers read), always on a spread no other capture
   * confirmed; at 1920×1080 (≈ 12 px) none was wrong.
   */
  surePx: 8,
}

/**
 * Whether a capture's numbers may count as the pages taken (✓ with the
 * number) — the numbers kept as read, judged again for every capture once
 * a new one is read:
 *
 *  - `order`: they do not fit the order the book is taken in
 *    (`numbersFitOrder`);
 *  - `unsure`: a spread whose number nothing makes sure of. A spread's
 *    number is sure when
 *      · another capture confirms it (its numbers touch, 1–2 pages off:
 *        the next / previous spread, whichever half of each was read), or
 *      · both halves were read on their own (not one inferred from the
 *        other), follow each other, and are at least `surePx` tall;
 *    and its left page has the parity the book's confirmed spreads have
 *    (left even, right odd — or the other way round, per book).
 *    Book 1 4・5 read as 1・2 (the right half "第二" from the body text,
 *    the left inferred), book 3 318・319 as 328・329 (the left half
 *    alone) and 324・325 as 824・825, book 2 96・97 as 8・9 — all at
 *    720×960, with no other number to judge them by, were shown as
 *    "✓ 1・2 撮れた" and listed under those numbers;
 *  - `ok`: shown and counted.
 *
 * Single pages keep the order rule only (their numbers are read at twice a
 * spread's size). A capture held back as `unsure` comes back as `ok` once
 * a later capture confirms it.
 */
export function settleBookNumbers(
  sheets: readonly BookSheet[],
  opts: Partial<typeof BOOK_NUMBER_DEFAULTS> = {},
): Map<string, 'ok' | 'unsure' | 'order'> {
  const o = { ...BOOK_NUMBER_DEFAULTS, ...opts }
  const out = new Map<string, 'ok' | 'unsure' | 'order'>()
  for (const s of sheets) out.set(s.id, 'ok')

  // Out of order, until nothing more drops (a dropped capture no longer
  // confirms the ones round it).
  const none: BookPageRead = { state: 'none' }
  let work: BookSheet[] = [...sheets]
  for (let pass = 0; pass <= sheets.length; pass++) {
    const drop = work.filter(
      (s) => directNumbers([s]).length > 0 && !numbersFitOrder(work, s.id),
    )
    if (drop.length === 0) break
    for (const s of drop) out.set(s.id, 'order')
    work = work.map((s) =>
      out.get(s.id) === 'order' ? { ...s, pages: s.pages.map(() => none) } : s,
    )
  }

  const confirmed = (s: BookSheet) => touchesAnother(s, work, [1, 2])
  const spreads = work.filter(
    (s) => s.pages.length === 2 && directNumbers([s]).length > 0,
  )
  const leftOf = (s: BookSheet) => {
    const l = completeSpread(s.pages)[0]
    return l?.state === 'read' ? l.number : undefined
  }
  // The book's left-page parity, from the OTHER spreads other captures
  // confirm (a misread spread must not vote for itself).
  const sure = spreads.filter(confirmed)
  const parityBut = (s: BookSheet): 0 | 1 | null => {
    const lefts = sure
      .filter((x) => x.id !== s.id)
      .map(leftOf)
      .filter((n): n is number => n !== undefined)
    const even = lefts.filter((n) => n % 2 === 0).length
    const most = Math.max(even, lefts.length - even)
    if (lefts.length < 2 || most < 0.75 * lefts.length) return null
    return even >= lefts.length - even ? 0 : 1
  }

  for (const s of spreads) {
    if (out.get(s.id) === 'order') continue
    const left = leftOf(s)
    const parity = parityBut(s)
    const parityOk =
      parity === null || left === undefined || left % 2 === parity
    const [l, r] = s.pages as [BookPageRead, BookPageRead]
    const tall = (p: BookPageRead) => p.px === undefined || p.px >= o.surePx
    const pair =
      l.state === 'read' &&
      r.state === 'read' &&
      !l.inferred &&
      !r.inferred &&
      r.number === l.number! + 1 &&
      tall(l) &&
      tall(r)
    out.set(s.id, parityOk && (confirmed(s) || pair) ? 'ok' : 'unsure')
  }
  return out
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
