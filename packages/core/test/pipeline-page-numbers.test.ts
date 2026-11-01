import { describe, expect, it } from 'vitest'
import {
  checkPageSequence,
  kanjiToNumber,
  parsePageNumberToken,
  pickPageNumbers,
} from '../src/pipeline/page-numbers.js'

describe('kanjiToNumber', () => {
  it('reads positional and unit forms', () => {
    expect(kanjiToNumber('一二三')).toBe(123)
    expect(kanjiToNumber('百二十三')).toBe(123)
    expect(kanjiToNumber('十')).toBe(10)
    expect(kanjiToNumber('二十')).toBe(20)
    expect(kanjiToNumber('契約')).toBeNull()
  })
})

describe('parsePageNumberToken', () => {
  it('reads decorated and full-width numbers', () => {
    expect(parsePageNumberToken('- 12 -')).toEqual({
      value: 12,
      kind: 'arabic',
    })
    expect(parsePageNumberToken('（３４）')).toEqual({
      value: 34,
      kind: 'arabic',
    })
    expect(parsePageNumberToken('p.5')).toEqual({ value: 5, kind: 'arabic' })
    expect(parsePageNumberToken('第7頁')).toEqual({ value: 7, kind: 'arabic' })
    expect(parsePageNumberToken('一二')).toEqual({ value: 12, kind: 'kanji' })
  })

  it('reads a number at the end of a running head', () => {
    expect(parsePageNumberToken('契約の成立 45')).toEqual({
      value: 45,
      kind: 'edge',
    })
  })

  it('rejects body text, chapter numbers and zero', () => {
    expect(parsePageNumberToken('第3章 契約')).toBeNull()
    expect(parsePageNumberToken('証拠書類は提出の順に')).toBeNull()
    expect(parsePageNumberToken('0')).toBeNull()
    expect(parsePageNumberToken('2026年')).toBeNull()
  })
})

describe('pickPageNumbers', () => {
  it('ignores numbers in the body', () => {
    expect(pickPageNumbers([{ text: '12', cx: 0.5, cy: 0.5 }])).toEqual([])
  })

  it('prefers a bare number over a running head', () => {
    expect(
      pickPageNumbers([
        { text: '第2章 契約 9', cx: 0.5, cy: 0.04 },
        { text: '- 10 -', cx: 0.5, cy: 0.95 },
      ]),
    ).toEqual([10])
  })

  it('returns both numbers of a spread', () => {
    expect(
      pickPageNumbers([
        { text: '24', cx: 0.1, cy: 0.96 },
        { text: '25', cx: 0.9, cy: 0.96 },
      ]),
    ).toEqual([24, 25])
  })
})

describe('checkPageSequence', () => {
  it('finds a gap and a duplicate', () => {
    const r = checkPageSequence([[1], [2], [4], [4], [], [5]])
    expect(r.pages.map((p) => p.state)).toEqual([
      'ok',
      'ok',
      'ok',
      'duplicate',
      'unread',
      'ok',
    ])
    expect(r.pages[3]!.duplicateOf).toBe(2)
    expect(r.missing).toEqual([
      { from: 3, to: 3, beforeIndex: 2, suspect: false },
    ])
  })

  it('handles spreads and flags implausible jumps', () => {
    const r = checkPageSequence([[10, 11], [12, 13], [140]])
    expect(r.pages.map((p) => p.state)).toEqual(['ok', 'ok', 'ok'])
    expect(r.missing).toEqual([
      { from: 14, to: 139, beforeIndex: 2, suspect: true },
    ])
  })

  it('marks a lower number as out of order', () => {
    const r = checkPageSequence([[5], [3], [6]])
    expect(r.pages.map((p) => p.state)).toEqual(['ok', 'outOfOrder', 'ok'])
    expect(r.missing).toEqual([])
  })
})
