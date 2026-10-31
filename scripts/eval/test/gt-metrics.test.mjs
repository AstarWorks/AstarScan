import { describe, it, expect } from 'bun:test'

import { computeGtMetrics } from '../lib/gt-match.mjs'

const manifest = {
  pages: [
    { id: 'p1' },
    { id: 'p2' },
    { id: 'p3' },
    { id: 'blank', optional: true },
  ],
}

const assign = (pageId, extra = {}) => ({ pageId, mergeSuspect: false, ...extra })

describe('computeGtMetrics', () => {
  it('computes per-page recall over non-optional pages only', () => {
    const m = computeGtMetrics(manifest, [assign('p1'), assign('p2')])
    expect(m.gtPages).toBe(3)
    expect(m.perPageRecall).toBeCloseTo(2 / 3)
    expect(m.missedPages).toEqual(['p3'])
  })

  it('counts duplicates past the first claim of a page', () => {
    const m = computeGtMetrics(manifest, [
      assign('p1'),
      assign('p1'),
      assign('p1'),
      assign('p2'),
    ])
    expect(m.duplicates).toBe(2)
    expect(m.duplicateRate).toBeCloseTo(0.5)
  })

  it('counts unmatched winners as false positives', () => {
    const m = computeGtMetrics(manifest, [assign('p1'), assign(null)])
    expect(m.falsePositives).toBe(1)
    expect(m.falsePositiveRate).toBeCloseTo(0.5)
  })

  it('matching an optional page is neither recall nor FP', () => {
    const m = computeGtMetrics(manifest, [
      assign('p1'),
      assign('p2'),
      assign('p3'),
      assign('blank'),
    ])
    expect(m.perPageRecall).toBe(1)
    expect(m.falsePositives).toBe(0)
    expect(m.duplicates).toBe(0)
  })

  it('surfaces merge suspects and flags', () => {
    const m = computeGtMetrics(manifest, [
      assign('p1', { mergeSuspect: true }),
      assign('p2', { flag: 'visual-disagrees:p3(orb=60)', idx: 42 }),
    ])
    expect(m.mergeErrors).toBe(1)
    expect(m.flags).toEqual([{ idx: 42, flag: 'visual-disagrees:p3(orb=60)' }])
  })

  it('handles an empty winner set (recall 0, no division by zero)', () => {
    const m = computeGtMetrics(manifest, [])
    expect(m.perPageRecall).toBe(0)
    expect(m.duplicateRate).toBe(0)
    expect(m.falsePositiveRate).toBe(0)
  })
})
