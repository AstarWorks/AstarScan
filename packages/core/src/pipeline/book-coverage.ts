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
 * Gaps at which two captures' numbers follow each other. The next spread
 * is always 1 off (whichever half of each was read: the other half is
 * inferred and counted), single pages taken one side only are 2 off (31,
 * 33), and a single page beside a spread may be either. Two spreads 2
 * apart have a page between them that neither holds: book 3's upright
 * spread at 720×960 read 322・323 as "321・322" at 6 px, and 318・319 two
 * below it confirmed the misread.
 */
function followGaps(a: BookSheet, b: BookSheet): number[] {
  return a.pages.length === 2 && b.pages.length === 2 ? [1] : [1, 2]
}

/** Whether the numbers of two captures follow each other (`followGaps`). */
function follows(a: BookSheet, b: BookSheet): boolean {
  return touching(countedNumbers(a), countedNumbers(b), followGaps(a, b))
}

/**
 * Numbers read directly on `sheets` that another of them confirms: the
 * capture's numbers follow another capture's (34・35 then 36・37 whichever
 * halves were read, every right page 31, 33). One capture alone, even a
 * spread whose halves follow each other, confirms nothing; nor does the
 * same page taken again.
 */
function confirmedNumbers(
  sheets: readonly BookSheet[],
): { seq: number; n: number }[] {
  return sheets
    .filter((s) => sheets.some((o) => o.id !== s.id && follows(s, o)))
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
  return orderVerdict(sheets, sheetId) === 'ok'
}

/**
 * `numbersFitOrder` with the rule that failed: `below` (rules 1 and 2:
 * below the pages taken before) or `overtaken` (rule 3: the book went on
 * from below). `settleBookNumbers` drops the `below` captures first: two
 * misreads that happen to follow each other (book 1's "— 33 —" read as
 * "3" and "— 47 —" as "4") confirm each other, and judged together with
 * the right first page 31 they overtook it — all three dropped at once,
 * and 31 stayed out though its two accusers were gone.
 */
function orderVerdict(
  sheets: readonly BookSheet[],
  sheetId: string,
): 'ok' | 'below' | 'overtaken' {
  const s = sheets.find((x) => x.id === sheetId)
  if (!s) return 'ok'
  const own = directNumbers([s]).map((x) => x.n)
  if (own.length === 0) return 'ok'
  const lo = Math.min(...own)
  const hi = Math.max(...own)
  const earlier = sheets.filter((x) => x.seq < s.seq)
  const before = confirmedNumbers(earlier).map((x) => x.n)
  if (before.length > 0 && lo < Math.min(...before)) return 'below'

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
    if (lo < Math.min(...allBefore) && next - hi > 2 * between + 2)
      return 'below'
  }
  const below = new Set(
    laterConfirmed.filter((x) => x.n < lo).map((x) => x.seq),
  )
  if (below.size >= 2 && !allBefore.some((n) => n <= hi + 2)) return 'overtaken'
  return 'ok'
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
 *      · other captures confirm it (their numbers follow this one's, see
 *        `followGaps`: the next / previous spread, whichever half of each
 *        was read) —
 *        one of them read at `surePx` or more, or two of them, or
 *      · both halves were read on their own (not one inferred from the
 *        other), follow each other, and are at least `surePx` tall;
 *    and its left page has the parity the book's confirmed spreads have
 *    (left even, right odd — or the other way round, per book). Of two
 *    captures holding the same page only the one in sequence with its
 *    neighbours in capture order counts.
 *    Book 1 4・5 read as 1・2 (the right half "第二" from the body text,
 *    the left inferred), book 3 318・319 as 328・329 (the left half
 *    alone) and 324・325 as 824・825, book 2 96・97 as 8・9 — all at
 *    720×960, with no other number to judge them by, were shown as
 *    "✓ 1・2 撮れた" and listed under those numbers;
 *  - `ok`: shown and counted.
 *
 * Single pages are read at twice a spread's size and keep the order rule,
 * and one more: a single page's number that nothing confirms is `unsure`
 * when it jumps further from the numbered capture before or after it (in
 * capture order) than those captures could turn — more than 2 pages a
 * capture (a leaf), counting the captures between whose number was not
 * read. A folio "17 |" read as 171, 191, 211 … (a bar read as a 1, 20
 * apart, the order kept) showed "✓ 171 撮れた" on every page: each jumps
 * 20 from its neighbours and nothing confirms any. A page 39 taken after
 * 35 (37 skipped) jumps 4 and waits for 41 to confirm it; 41 after 37, ?
 * (unread), 45 jumps 4 over two captures and counts.
 * A capture held back as `unsure` comes back as `ok` once a later capture
 * confirms it.
 */
export function settleBookNumbers(
  sheets: readonly BookSheet[],
  opts: Partial<typeof BOOK_NUMBER_DEFAULTS> = {},
): Map<string, 'ok' | 'unsure' | 'order'> {
  const o = { ...BOOK_NUMBER_DEFAULTS, ...opts }
  const out = new Map<string, 'ok' | 'unsure' | 'order'>()
  for (const s of sheets) out.set(s.id, 'ok')

  // Out of order, until nothing more drops (a dropped capture no longer
  // confirms the ones round it). Captures below the pages taken before go
  // first; only when none is left does a capture the book overtook from
  // below go (see orderVerdict: the overtakers may be misreads themselves).
  const none: BookPageRead = { state: 'none' }
  let work: BookSheet[] = [...sheets]
  for (let pass = 0; pass <= 2 * sheets.length; pass++) {
    const verdicts = work
      .filter((s) => directNumbers([s]).length > 0)
      .map((s) => ({ s, v: orderVerdict(work, s.id) }))
    let drop = verdicts.filter((x) => x.v === 'below')
    if (drop.length === 0) drop = verdicts.filter((x) => x.v === 'overtaken')
    if (drop.length === 0) break
    for (const { s } of drop) out.set(s.id, 'order')
    work = work.map((s) =>
      out.get(s.id) === 'order' ? { ...s, pages: s.pages.map(() => none) } : s,
    )
  }

  const tall = (p: BookPageRead) => p.px === undefined || p.px >= o.surePx
  /** A capture with a number read at `surePx` or more. */
  const tallRead = (s: BookSheet) =>
    s.pages.some((p) => p.state === 'read' && !p.inferred && tall(p))
  /** The other captures whose numbers follow this one's (`followGaps`). */
  const partners = (s: BookSheet) =>
    work.filter((x) => x.id !== s.id && follows(s, x))
  // A read under surePx is wrong as often as right; one such read agreeing
  // with another is weak evidence (book 2 720×960: 94・95 read as 98・99
  // at 6 px beside a right 96・97 at 6 px, both shown, 94・95 red). It
  // counts when a tall read touches it, or two captures do.
  const confirmed = (s: BookSheet) => {
    const ps = partners(s)
    return ps.length >= 2 || ps.some(tallRead)
  }
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

  // Single pages: a number that jumps further than the captures between
  // could turn, and that nothing confirms (see above).
  const bySeq = [...work].sort((a, b) => a.seq - b.seq)
  const numbered = bySeq.filter(
    (s) => out.get(s.id) === 'ok' && directNumbers([s]).length > 0,
  )
  const jumps = (a: BookSheet, b: BookSheet): boolean => {
    const between = bySeq.filter((x) => x.seq > a.seq && x.seq < b.seq).length
    const na = countedNumbers(a)
    const nb = countedNumbers(b)
    const gap = Math.max(
      Math.min(...nb) - Math.max(...na),
      Math.min(...na) - Math.max(...nb),
    )
    return gap > 2 * (between + 1)
  }
  for (const [i, s] of numbered.entries()) {
    if (s.pages.length !== 1 || partners(s).length > 0) continue
    const prev = numbered[i - 1]
    const next = numbered[i + 1]
    if ((prev && jumps(prev, s)) || (next && jumps(s, next)))
      out.set(s.id, 'unsure')
  }

  // Room for the captures between: every capture is a page of its own
  // (the hold's picture test keeps a page taken again from being taken),
  // so a capture's numbers lie at least one page above the nearest earlier
  // capture numbered below it for every capture taken between them whose
  // number is not known. Book 4 at 720×960 (run18): 58・59, 60・61 (unread),
  // 64・65, then 66・67 read as "60・61" — one page above 59 with a capture
  // between — and 68・69 as "66・67", one page above 65 with that capture
  // between; each was confirmed by its neighbour and shown. Going back to
  // fill a gap keeps its room: 62・63 taken after 64・65 is three above 59
  // with 60・61 (unread) between.
  for (const s of bySeq) {
    if (out.get(s.id) !== 'ok') continue
    const own = countedNumbers(s)
    if (own.length === 0) continue
    const lo = Math.min(...own)
    const prev = bySeq
      .filter(
        (x) =>
          x.seq < s.seq &&
          out.get(x.id) === 'ok' &&
          countedNumbers(x).length > 0 &&
          Math.max(...countedNumbers(x)) < lo,
      )
      .pop()
    if (!prev) continue
    const between = bySeq.filter(
      (x) =>
        x.seq > prev.seq &&
        x.seq < s.seq &&
        !(out.get(x.id) === 'ok' && countedNumbers(x).length > 0),
    ).length
    if (lo - Math.max(...countedNumbers(prev)) < 1 + between)
      out.set(s.id, 'unsure')
  }

  // Two captures holding the same page (a retake the picture test let
  // through, or one of them misread onto the other's number): at most one
  // counts — the one in sequence with the captures just before and after
  // it (pages are turned forward: 96・97 then 98・99 then 100・101), the
  // earlier one on a tie. The other is held.
  const shown = work.filter(
    (s) => out.get(s.id) === 'ok' && countedNumbers(s).length > 0,
  )
  const inSequence = (s: BookSheet) => {
    const i = bySeq.findIndex((x) => x.id === s.id)
    let n = 0
    for (const j of [i - 1, i + 1]) {
      const x = bySeq[j]
      if (x && follows(s, x)) n++
    }
    return n
  }
  for (let i = 0; i < shown.length; i++)
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i]!
      const b = shown[j]!
      if (out.get(a.id) !== 'ok' || out.get(b.id) !== 'ok') continue
      const na = countedNumbers(a)
      const nb = countedNumbers(b)
      if (!na.some((n) => nb.includes(n))) continue
      const sa = inSequence(a)
      const sb = inSequence(b)
      const loser = sa > sb ? b : sb > sa ? a : a.seq < b.seq ? b : a
      out.set(loser.id, 'unsure')
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
