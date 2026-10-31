import { describe, expect, it } from 'vitest'
import {
  shingles,
  textSimilarity,
  verifySameText,
} from '../src/pipeline/text-similarity.js'

const LONG_A = 'この製品を使用する前に必ず取扱説明書をお読みください安全上の注意事項'
const LONG_B = 'この製品を使用する前に必ず取扱説明書をお読みください警告表示について'

describe('shingles', () => {
  it('produces character 3-grams', () => {
    expect([...shingles('abcd')]).toEqual(['abc', 'bcd'])
  })
})

describe('textSimilarity', () => {
  it('identical texts → jaccard 1', () => {
    const { jaccard, containment } = textSimilarity(LONG_A, LONG_A)
    expect(jaccard).toBe(1)
    expect(containment).toBe(1)
  })

  it('prefix-contained text → containment 1, diluted jaccard', () => {
    const prefix = LONG_A.slice(0, 15)
    const { jaccard, containment } = textSimilarity(prefix, LONG_A)
    expect(containment).toBe(1)
    expect(jaccard).toBeLessThan(0.6)
  })
})

describe('verifySameText', () => {
  it('abstains (null) on missing or short texts', () => {
    expect(verifySameText(null, LONG_A)).toBeNull()
    expect(verifySameText('短い', LONG_A)).toBeNull()
  })

  it('same page: shared majority content passes the jaccard threshold', () => {
    const v = verifySameText(LONG_A, LONG_B)
    expect(v).not.toBeNull()
    expect(v?.same).toBe(true)
  })

  it('different page: disjoint content fails', () => {
    const other = '請求書発行日二〇二六年六月十二日合計金額税込壱萬円也株式会社アスター'
    const v = verifySameText(LONG_A, other, 10)
    expect(v?.same).toBe(false)
  })

  it('containment shortcut only applies at small gaps', () => {
    // Header-only crop: contained but low jaccard
    const header = LONG_A.slice(0, 15) + 'ヘッダー領域のみの切り抜きでほぼ別物'
    const near = verifySameText(header, LONG_A, 1.0)
    const far = verifySameText(header, LONG_A, 3.0)
    expect(near?.containment).toBeGreaterThanOrEqual(far?.containment ?? 0)
    if (near && near.containment >= 0.5 && near.jaccard < 0.2) {
      expect(near.same).toBe(true)
      expect(far?.same).toBe(false)
    }
  })
})
