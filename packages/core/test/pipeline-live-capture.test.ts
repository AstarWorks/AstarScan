import { describe, expect, it } from 'vitest'
import {
  LIVE_CAPTURE_DEFAULTS,
  LiveCaptureJudge,
  buildCaptureReport,
  quadMotion,
  type LiveCaptureEvent,
  type LiveFrame,
} from '../src/pipeline/live-capture.js'
import type { Quad } from '../src/types.js'

const W = 720
const H = 1280
const quad = (dx = 0): Quad => ({
  tl: { x: 100 + dx, y: 200 },
  tr: { x: 600 + dx, y: 200 },
  br: { x: 600 + dx, y: 1000 },
  bl: { x: 100 + dx, y: 1000 },
})
/** Page pictures far apart in pHash space (256 bits). */
const PAGE_A = 0n
const PAGE_B = (1n << 256n) - 1n

function frame(
  t: number,
  hash: bigint | null,
  opts: Partial<LiveFrame<number>> = {},
): LiveFrame<number> {
  return {
    t,
    confidence: 0.8,
    quad: quad(),
    frameW: W,
    frameH: H,
    areaFrac: 0.3,
    score: 0.5,
    hash,
    data: Math.round(t * 10),
    ...opts,
  }
}

function run(frames: LiveFrame<number>[]): LiveCaptureEvent<number>[] {
  const j = new LiveCaptureJudge<number>()
  const ev = frames.flatMap((f) => j.push(f))
  return [...ev, ...j.finish(frames[frames.length - 1]?.t ?? 0)]
}

/** 10 fps samples over [from, to). */
const span = (
  from: number,
  to: number,
  mk: (t: number) => LiveFrame<number>,
) => {
  const out: LiveFrame<number>[] = []
  for (let i = Math.round(from * 10); i < Math.round(to * 10); i += 1)
    out.push(mk(i / 10))
  return out
}

describe('LiveCaptureJudge', () => {
  it('captures a still page after holdS, picking the best frame of the hold', () => {
    const ev = run(
      span(0, 1.5, (t) => frame(t, PAGE_A, { score: t === 0.3 ? 0.9 : 0.4 })),
    )
    const caps = ev.filter((e) => e.type === 'captured')
    expect(caps).toHaveLength(1)
    const c = caps[0]!
    if (c.type !== 'captured') throw new Error('unreachable')
    expect(c.t).toBeCloseTo(LIVE_CAPTURE_DEFAULTS.holdS + 0.1, 5)
    expect(c.best.t).toBeCloseTo(0.3, 5)
    expect(ev.some((e) => e.type === 'hold')).toBe(true)
  })

  it('gives no ✓ while the quad covers too little of the detector box', () => {
    const low = LIVE_CAPTURE_DEFAULTS.minBoxAgreement - 0.1
    const ev = run(span(0, 1.5, (t) => frame(t, PAGE_A, { boxAgreement: low })))
    expect(ev.filter((e) => e.type === 'captured')).toHaveLength(0)
    const ok = run(
      span(0, 1.5, (t) =>
        frame(t, PAGE_A, {
          boxAgreement: LIVE_CAPTURE_DEFAULTS.minBoxAgreement,
        }),
      ),
    )
    expect(ok.filter((e) => e.type === 'captured')).toHaveLength(1)
    const j = new LiveCaptureJudge()
    expect(j.isPage({ confidence: 0.8, areaFrac: 0.3, hash: 0n })).toBe(true)
  })

  it('does not gate on sharpness: a low-score page is still captured', () => {
    const ev = run(span(0, 1.5, (t) => frame(t, PAGE_A, { score: 0.05 })))
    expect(ev.filter((e) => e.type === 'captured')).toHaveLength(1)
  })

  it('does not capture while the page keeps moving', () => {
    const ev = run(
      span(0, 2, (t) =>
        frame(t, PAGE_A, { quad: quad(Math.round(t * 10) % 2 ? 200 : 0) }),
      ),
    )
    expect(ev.filter((e) => e.type === 'captured')).toHaveLength(0)
    expect(ev.filter((e) => e.type === 'missed')).toHaveLength(1)
  })

  it('a persisting picture change is a new page; a blip is not', () => {
    const frames = [
      ...span(0, 1.0, (t) => frame(t, PAGE_A)),
      frame(1.0, PAGE_B), // 1-frame blip
      ...span(1.1, 1.5, (t) => frame(t, PAGE_A)),
      ...span(1.5, 3.0, (t) => frame(t, PAGE_B)),
    ]
    const caps = run(frames).filter((e) => e.type === 'captured')
    expect(caps).toHaveLength(2)
  })

  const moving = (t: number) =>
    frame(t, PAGE_A, { quad: quad(Math.round(t * 10) % 2 ? 200 : 0) })
  const gone = (t: number) => frame(t, null, { confidence: 0.05 })

  it('reports a page that left the view without ✓ as missed, once it has left', () => {
    const { leaveS } = LIVE_CAPTURE_DEFAULTS
    const frames = [
      ...span(0, 1.0, moving),
      ...span(1.0, 1.0 + leaveS + 0.3, gone),
      ...span(1.0 + leaveS + 0.3, 3.5 + leaveS, (t) => frame(t, PAGE_B)),
    ]
    const j = new LiveCaptureJudge<number>()
    const timed = frames.flatMap((f) => j.push(f).map((e) => ({ e, at: f.t })))
    const missed = timed.filter((x) => x.e.type === 'missed')
    expect(missed).toHaveLength(1)
    // Not while the page is still in view: only after leaveS without it.
    expect(missed[0]!.at).toBeGreaterThan(0.9 + leaveS)
    const m = missed[0]!.e
    if (m.type !== 'missed') throw new Error('unreachable')
    expect(m.startT).toBe(0)
    expect(m.endT).toBeCloseTo(0.9, 5)
    expect(timed.filter((x) => x.e.type === 'captured')).toHaveLength(1)
  })

  it('does not flag a page that settles and is then captured (picture flicker while placing)', () => {
    const frames = [
      ...span(0, 1.0, moving),
      // pHash jumps while the page is still being placed …
      ...span(1.0, 1.3, (t) =>
        frame(t, PAGE_B, { quad: quad(Math.round(t * 3000)) }),
      ),
      // … then it settles and gets its ✓.
      ...span(1.3, 3.0, (t) => frame(t, PAGE_B)),
    ]
    const ev = run(frames)
    expect(ev.filter((e) => e.type === 'captured')).toHaveLength(1)
    expect(ev.filter((e) => e.type === 'missed')).toHaveLength(0)
  })

  it('does not flag a captured page that is re-gripped (picture flicker after ✓)', () => {
    const frames = [
      ...span(0, 1.2, (t) => frame(t, PAGE_A)),
      // Re-grip: the picture drifts away from the captured one and the
      // page keeps moving, so this part is never captured itself.
      ...span(1.2, 2.5, (t) =>
        frame(t, PAGE_B, { quad: quad(Math.round(t * 10) % 2 ? 200 : 0) }),
      ),
      ...span(2.5, 5.0, gone),
    ]
    const ev = run(frames)
    expect(ev.filter((e) => e.type === 'captured')).toHaveLength(1)
    expect(ev.filter((e) => e.type === 'missed')).toHaveLength(0)
  })

  it('a stretch shorter than missMinS is not a miss', () => {
    const ev = run([...span(0, 0.4, moving), ...span(0.4, 3.0, gone)])
    expect(ev.filter((e) => e.type === 'missed')).toHaveLength(0)
  })

  it('continues the same page across a short detection gap', () => {
    const frames = [
      ...span(0, 1.2, (t) => frame(t, PAGE_A)),
      ...span(1.2, 2.2, (t) => frame(t, null, { confidence: 0.1 })),
      ...span(2.2, 3.5, (t) => frame(t, PAGE_A)),
    ]
    const caps = run(frames).filter((e) => e.type === 'captured')
    expect(caps).toHaveLength(1)
  })

  it('pages exposes the span of each captured page', () => {
    const j = new LiveCaptureJudge<number>()
    for (const f of span(0, 1.5, (t) => frame(t, PAGE_A))) j.push(f)
    expect(j.pages).toEqual([{ pageNo: 1, startT: 0, endT: 1.4 }])
  })
})

describe('quadMotion', () => {
  it('is 0 for identical quads and scales with the frame diagonal', () => {
    expect(quadMotion(quad(), quad(), W, H)).toBe(0)
    expect(quadMotion(quad(), quad(10), W, H)).toBeCloseTo(
      10 / Math.hypot(W, H),
      6,
    )
  })
})

describe('buildCaptureReport', () => {
  const cl = (key: number, from: number, to: number) => ({
    key,
    memberT: span(from, to, (t) => frame(t, PAGE_A)).map((f) => f.t),
  })

  it('separates captured, duplicate, recovered and missed rows', () => {
    const rows = buildCaptureReport(
      [
        { pageNo: 1, startT: 0, endT: 1 },
        { pageNo: 2, startT: 1.5, endT: 2 },
        { pageNo: 3, startT: 9, endT: 10 },
      ],
      [
        { startT: 4, endT: 5 }, // recovered later by cluster 30
        { startT: 6.5, endT: 7 }, // nothing found → missed
        { startT: 9.2, endT: 9.4 }, // overlaps a ✓ → dropped
      ],
      [cl(10, 0, 2.1), cl(30, 4, 5.5), cl(40, 9, 10)],
    )
    expect(rows.map((r) => r.kind)).toEqual([
      'captured',
      'duplicate',
      'recovered',
      'missed',
      'captured',
    ])
    expect(rows[1]!.duplicateOf).toBe(1)
    expect(rows[2]!.missSpan).toEqual({ startT: 4, endT: 5 })
  })

  it('keeps a live page that no cluster contains', () => {
    const rows = buildCaptureReport(
      [{ pageNo: 1, startT: 3, endT: 4 }],
      [],
      [cl(10, 0, 1)],
    )
    expect(rows.map((r) => r.kind)).toEqual(['recovered', 'captured'])
    expect(rows[1]!.livePageNo).toBe(1)
  })
})
