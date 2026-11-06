import { describe, expect, it } from 'vitest'
import {
  bookCoverage,
  newGaps,
  numbersFitOrder,
  pageRangeLabel,
  sheetWithNumbers,
  type BookPageRead,
  type BookSheet,
} from '../src/pipeline/book-coverage.js'
import {
  applyHomography,
  findEdgeGutter,
  findSpreadGutter,
  quadAspect,
  splitSpreadQuad,
  trimQuadSides,
  unitToQuad,
} from '../src/pipeline/gutter.js'

const read = (n: number): BookPageRead => ({ state: 'read', number: n })
const none: BookPageRead = { state: 'none' }
const pending: BookPageRead = { state: 'pending' }
let seq = 0
const sheet = (...pages: BookPageRead[]): BookSheet => ({
  id: `s${++seq}`,
  seq,
  pages,
})

describe('bookCoverage (the mock ideal-capture.html flow)', () => {
  it('a skipped spread is red, and going back fills it', () => {
    const a = sheet(read(34), read(35))
    const b = sheet(read(36), read(37))
    const c = sheet(read(40), read(41))
    const before = bookCoverage([a, b]).gaps
    const after = bookCoverage([a, b, c])
    expect(after.gaps).toEqual([{ from: 38, to: 39, step: 1 }])
    expect(newGaps(before, after.gaps)).toEqual([{ from: 38, to: 39, step: 1 }])
    expect(
      after.items.map((i) => (i.kind === 'gap' ? 'gap' : i.numbers.join('・'))),
    ).toEqual(['34・35', '36・37', 'gap', '40・41'])
    const d = sheet(read(38), read(39))
    const filled = bookCoverage([a, b, c, d])
    expect(filled.gaps).toEqual([])
    expect(
      filled.items.map((i) => (i.kind === 'sheet' ? i.numbers[0] : 'gap')),
    ).toEqual([34, 36, 38, 40])
    expect(pageRangeLabel(38, 39)).toBe('38・39')
  })

  it('pages without a number between read ones are not a gap', () => {
    const s = [
      sheet(read(40), read(41)),
      sheet(none, none),
      sheet(read(44), read(45)),
    ]
    const c = bookCoverage(s)
    expect(c.gaps).toEqual([])
    expect(c.items.map((i) => (i.kind === 'sheet' ? i.state : 'gap'))).toEqual([
      'ok',
      'nonum',
      'ok',
    ])
  })

  it('waits while a page between is still being read', () => {
    expect(
      bookCoverage([
        sheet(read(10), read(11)),
        sheet(pending, pending),
        sheet(read(14), read(15)),
      ]).gaps,
    ).toEqual([])
  })

  it('a spread with one number read infers the other', () => {
    const c = bookCoverage([
      sheet(read(2), read(3)),
      sheet(none, read(5)),
      sheet(read(6), none),
    ])
    expect(c.gaps).toEqual([])
    expect(c.pageCount).toBe(6)
  })

  it('a spread with one half read confirms through its inferred half (book 2: 50・51 skipped after a half-read 48・49)', () => {
    // 48 unread (inferred from 49) next to 47; 52・53 a pair.
    const a = [
      sheet(read(44), read(45)),
      sheet(read(46), read(47)),
      sheet(none, none),
      sheet(none, read(49)),
      sheet(read(52), read(53)),
    ]
    expect(bookCoverage(a).gaps).toEqual([{ from: 50, to: 51, step: 1 }])
    // 53 unread (inferred from 52), confirmed once 54・55 follow.
    const b = [
      sheet(read(46), read(47)),
      sheet(read(48), read(49)),
      sheet(read(52), none),
    ]
    expect(bookCoverage(b).gaps).toEqual([])
    expect(bookCoverage([...b, sheet(read(54), read(55))]).gaps).toEqual([
      { from: 50, to: 51, step: 1 },
    ])
  })

  it('one side of the book only (every right page) is not a gap; a skipped one is', () => {
    const s = [
      sheet(read(31)),
      sheet(read(33)),
      sheet(read(35)),
      sheet(read(39)),
    ]
    // 39 has no neighbour yet: not trusted, no red until 41 confirms it.
    expect(bookCoverage(s).gaps).toEqual([])
    const c = bookCoverage([...s, sheet(read(41))])
    expect(c.step).toBe(2)
    expect(c.gaps).toEqual([{ from: 37, to: 37, step: 2 }])
  })

  it('single pages taken one after the other (46, 47) step by one', () => {
    const c = bookCoverage([
      sheet(read(46)),
      sheet(read(47)),
      sheet(read(49)),
      sheet(read(50)),
    ])
    expect(c.step).toBe(1)
    expect(c.gaps).toEqual([{ from: 48, to: 48, step: 1 }])
  })

  it('a misread does not raise a red gap', () => {
    // 10・11 misread as 18・19 after 8・9: a pair alone does not trust a
    // jump wider than one spread.
    const c = bookCoverage([
      sheet(read(6), read(7)),
      sheet(read(8), read(9)),
      sheet(read(18), read(19)),
    ])
    expect(c.gaps).toEqual([])
    // A lone misread single (16 among 13, 15, 17) is not trusted on one side.
    const d = bookCoverage([
      sheet(read(13)),
      sheet(read(15)),
      sheet(read(16)),
      sheet(read(17)),
    ])
    expect(d.step).toBe(2)
    expect(d.gaps).toEqual([])
  })

  it('a number below every page taken before is not taken (book 2: 98・99 read as 88・89)', () => {
    const s = [
      sheet(read(90), read(91)),
      sheet(read(92), read(93)),
      sheet(read(94), read(95)),
    ]
    const misread = sheet(read(88), read(89))
    expect(numbersFitOrder([...s, misread], misread.id)).toBe(false)
    // 96・97 read as 8・9 is the same.
    const short = sheet(read(8), read(9))
    expect(numbersFitOrder([...s, short], short.id)).toBe(false)
    // Going back to fill a skipped spread, or a page taken already, fits.
    const s2 = [
      sheet(read(44), read(45)),
      sheet(read(46), read(47)),
      sheet(read(48), read(49)),
      sheet(read(52), read(53)),
    ]
    const back = sheet(read(50), read(51))
    expect(numbersFitOrder([...s2, back], back.id)).toBe(true)
    const again = sheet(read(44), read(45))
    expect(numbersFitOrder([...s2, again], again.id)).toBe(true)
    // Forward, and the first captures, fit.
    const next = sheet(read(54), read(55))
    expect(numbersFitOrder([...s2, next], next.id)).toBe(true)
    expect(numbersFitOrder([s2[0]!], s2[0]!.id)).toBe(true)
  })

  it('one misread capture does not lock out the right numbers after it', () => {
    // 12・13 read as 72・73 first: nothing confirms 72, so 14・15 fits.
    const wrong = sheet(read(72), read(73))
    const right = sheet(read(14), read(15))
    expect(numbersFitOrder([wrong, right], right.id)).toBe(true)
    // Single pages, every right one: 31, 33 confirm each other; 21 is back
    // before them; a page without a number never fails.
    const r = [sheet(read(31)), sheet(read(33))]
    const low = sheet(read(21))
    expect(numbersFitOrder([...r, low], low.id)).toBe(false)
    const blank = sheet(none)
    expect(numbersFitOrder([...r, blank], blank.id)).toBe(true)
  })

  it('the captures after a number judge it too', () => {
    // Book 2 single-top: 205 read as 5 between 201 and 209, 211.
    const a = sheet(read(201))
    const gap = sheet(none)
    const five = sheet(read(5))
    const after = [sheet(none), sheet(read(209)), sheet(read(211))]
    const all = [a, gap, five, ...after]
    expect(numbersFitOrder(all, five.id)).toBe(false)
    expect(numbersFitOrder(all, a.id)).toBe(true)
    // Book 1 single-land-white: the first page 31 read as 40, then 33, 35.
    const forty = sheet(read(40))
    const run = [sheet(read(33)), sheet(read(35)), sheet(read(37))]
    expect(numbersFitOrder([forty, ...run], forty.id)).toBe(false)
    expect(numbersFitOrder([forty, ...run], run[0]!.id)).toBe(true)
    // ...but not before the run below it is confirmed.
    expect(numbersFitOrder([forty, run[0]!], forty.id)).toBe(true)
    // A lone misread spread first (72・73 for 12・13) is dropped once the
    // right numbers after it confirm each other; they still fit.
    const wrong = sheet(read(72), read(73))
    const right = [sheet(read(14), read(15)), sheet(read(16), read(17))]
    expect(numbersFitOrder([wrong, ...right], wrong.id)).toBe(false)
    expect(numbersFitOrder([wrong, ...right], right[0]!.id)).toBe(true)
  })

  it('skipping a spread and going back fits (holds 0,1,2,4,3,5,6)', () => {
    const order = [44, 46, 48, 52, 50, 54, 56].map((n) =>
      sheet(read(n), read(n + 1)),
    )
    for (const s of order) expect(numbersFitOrder(order, s.id)).toBe(true)
    // Two spreads skipped, both taken after going back.
    const two = [44, 46, 52, 48, 50, 54].map((n) => sheet(read(n), read(n + 1)))
    for (const s of two) expect(numbersFitOrder(two, s.id)).toBe(true)
  })

  it('a far jump is a misread, not a gap', () => {
    expect(
      bookCoverage([sheet(read(4), read(5)), sheet(read(94), read(95))]).gaps,
    ).toEqual([])
  })

  it('finds the sheet that already holds a page', () => {
    const a = sheet(read(40), read(41))
    expect(sheetWithNumbers([a], [40, 41])?.id).toBe(a.id)
    expect(sheetWithNumbers([a], [42, 43])).toBeNull()
  })
})

/** Luminance image: paper 200, a dark fold at `fold(y)` (x share), print noise. */
function spreadImage(
  w: number,
  h: number,
  fold: (y: number) => number,
): Uint8Array {
  const img = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const fx = fold(y / h) * w
    for (let x = 0; x < w; x++) {
      let v = 200
      const d = Math.abs(x - fx)
      if (d < w * 0.03) v = 200 - 90 * (1 - d / (w * 0.03))
      if (y % 9 < 2 && x % 40 < 30 && d > w * 0.05) v = 90 // text lines
      img[y * w + x] = v
    }
  }
  return img
}

describe('findSpreadGutter', () => {
  it('finds a straight fold off the middle', () => {
    const g = findSpreadGutter(
      spreadImage(400, 280, () => 0.46),
      400,
      280,
    )
    expect(g.top).toBeCloseTo(0.46, 1)
    expect(g.bottom).toBeCloseTo(0.46, 1)
    expect(g.depth).toBeGreaterThan(0.2)
  })

  it('follows a slanted fold', () => {
    const g = findSpreadGutter(
      spreadImage(400, 280, (y) => 0.45 + 0.08 * y),
      400,
      280,
    )
    expect(g.top).toBeCloseTo(0.45, 1)
    expect(g.bottom).toBeCloseTo(0.53, 1)
  })

  it('falls back to the middle when there is no fold', () => {
    const flat = new Uint8Array(400 * 280).fill(200)
    expect(findSpreadGutter(flat, 400, 280)).toEqual({
      top: 0.5,
      bottom: 0.5,
      depth: 0,
    })
  })
})

describe('findEdgeGutter', () => {
  it('finds the fold of a page framed past the gutter', () => {
    const w = 300
    const h = 420
    const img = spreadImage(w, h, () => 0.1)
    const cut = findEdgeGutter(img, w, h)
    expect(cut.left).toBeGreaterThan(0.07)
    expect(cut.left).toBeLessThan(0.13)
    expect(cut.right).toBe(0)
  })

  it('leaves a clean page alone', () => {
    const w = 300
    const h = 420
    const img = spreadImage(w, h, () => 2) // fold outside the page
    expect(findEdgeGutter(img, w, h)).toEqual({ left: 0, right: 0 })
  })

  it('a dark line in one half only (a figure frame) is not a fold (single-port-wood p7)', () => {
    const w = 300
    const h = 420
    const img = spreadImage(w, h, () => 2)
    // A figure's frame in the lower half, its right border 14 % in from
    // the right side, paper beyond it.
    const x0 = Math.round(0.1 * w)
    const x1 = Math.round(0.86 * w)
    for (let y = Math.round(0.55 * h); y < Math.round(0.85 * h); y++)
      for (let x = x0; x <= x1; x++) {
        const edge = x - x0 < 3 || x1 - x < 3
        if (edge) img[y * w + x] = 30
      }
    expect(findEdgeGutter(img, w, h)).toEqual({ left: 0, right: 0 })
    // p5: a figure in each half, their borders in line — a printed line,
    // not a fold's shadow.
    for (let y = Math.round(0.12 * h); y < Math.round(0.38 * h); y++)
      for (let x = x0; x <= x1; x++)
        if (x - x0 < 3 || x1 - x < 3) img[y * w + x] = 30
    expect(findEdgeGutter(img, w, h)).toEqual({ left: 0, right: 0 })
  })
})

describe('splitSpreadQuad', () => {
  const quad = {
    tl: { x: 100, y: 120 },
    tr: { x: 1500, y: 80 },
    br: { x: 1560, y: 980 },
    bl: { x: 90, y: 1000 },
  }

  it('maps the unit square onto the quad', () => {
    const H = unitToQuad(quad)
    const p = applyHomography(H, { x: 1, y: 1 })
    expect(p.x).toBeCloseTo(1560, 6)
    expect(p.y).toBeCloseTo(980, 6)
  })

  it('splits at the gutter into two portrait pages that share the fold', () => {
    const { left, right } = splitSpreadQuad(quad, {
      top: 0.5,
      bottom: 0.5,
      depth: 0.3,
    })
    expect(left.tr).toEqual(right.tl)
    expect(left.br).toEqual(right.bl)
    expect(quadAspect(quad)).toBeGreaterThan(1)
    expect(quadAspect(left)).toBeLessThan(1)
    expect(quadAspect(right)).toBeLessThan(1)
  })

  it('trims a side', () => {
    const t = trimQuadSides(quad, 0.1, 0)
    expect(t.tr.x).toBeCloseTo(quad.tr.x, 6)
    expect(t.tr.y).toBeCloseTo(quad.tr.y, 6)
    expect(t.tl.x).toBeGreaterThan(quad.tl.x)
  })
})

describe('fitPageEdges (PageFlatten.kt edge fit)', () => {
  it('finds a page whose top and bottom edges bow outward', async () => {
    const { flattenGeometry, fitPageEdges, curveAt } =
      await import('../src/pipeline/page-flatten.js')
    const g = flattenGeometry(400, 560, 0.05)
    const bow = 12 // px at the middle
    const top = (u: number) => g.my - bow * 4 * u * (1 - u)
    const bottom = (u: number) => g.my + g.oh + bow * 4 * u * (1 - u)
    const lum = new Uint8Array(g.ew * g.eh)
    for (let y = 0; y < g.eh; y++)
      for (let x = 0; x < g.ew; x++) {
        const u = (x - g.mx) / g.ow
        lum[y * g.ew + x] = y >= top(u) && y <= bottom(u) ? 210 : 60
      }
    const r = fitPageEdges(lum, g, false)
    expect(r.why).toBe('')
    expect(r.edges).not.toBeNull()
    expect(Math.abs(curveAt(r.edges!.top, 0.5) - top(0.5))).toBeLessThan(5)
    expect(Math.abs(curveAt(r.edges!.bottom, 0.5) - bottom(0.5))).toBeLessThan(
      5,
    )
    expect(r.edges!.topBow).toBeGreaterThan(0.015)
  })

  it('gives up on a picture without paper edges', async () => {
    const { flattenGeometry, fitPageEdges } =
      await import('../src/pipeline/page-flatten.js')
    const g = flattenGeometry(400, 560, 0.05)
    const flat = new Uint8Array(g.ew * g.eh).fill(200)
    expect(fitPageEdges(flat, g, false).edges).toBeNull()
  })
})

describe('folioZone', () => {
  it('names the outer corner per side and learns the place', async () => {
    const { folioZone, learnedFolioZone } =
      await import('../src/pipeline/page-numbers.js')
    expect(folioZone(0.1, 0.95, 'L')).toBe('bo')
    expect(folioZone(0.9, 0.95, 'R')).toBe('bo')
    expect(folioZone(0.5, 0.05, 'S')).toBe('tc')
    expect(learnedFolioZone(new Map([['bo', 1]]))).toBeNull()
    expect(
      learnedFolioZone(
        new Map([
          ['bo', 3],
          ['tc', 1],
        ]),
      ),
    ).toBeNull()
    expect(
      learnedFolioZone(
        new Map([
          ['bo', 4],
          ['tc', 1],
        ]),
      ),
    ).toBe('bo')
  })
})
