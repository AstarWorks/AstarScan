/**
 * Light-weight ByteTrack-style identity tracker specialized for document
 * quads detected one-per-frame on sequential video.
 *
 * We don't need full Kalman / Hungarian assignment — the use case is a
 * static-ish card on a desk, so a frame-to-frame "is this the same
 * rectangle?" check using centroid distance + IoU + frame gap is enough.
 *
 * Each track represents one physical document. When the user moves to the
 * next card, the track ends and a fresh one starts. When the same card
 * re-appears later (e.g. user picked it up again), it gets a new track
 * id — that case is handled by the downstream canonical-key dedup
 * (`canonical-dedup.mjs`), which collapses them via shared OCR fields.
 *
 * Inputs: stream of { frame_idx, ts_ms, quad, score, mode } in time order.
 * Output: same items annotated with { track_id }.
 *
 * Tracker state:
 *   - tracks: Map<id, { id, mode, lastFrame, lastQuad, bestScore, bestItem }>
 *   - per item, try to associate to an open track; else open new
 */

import { centroid, iou, quadArea } from './quad-geometry.mjs'

const DEFAULTS = {
  maxFrameGap: 4, // frames; at 5 FPS that's 0.8 s
  centroidEpsRatio: 0.15, // a fraction of average quad diameter
  iouThreshold: 0.4, // tracks must overlap by ≥ this to associate
  modeMustMatch: true, // only merge same-mode (card/a4/...)
}

export class DocTracker {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts }
    this.tracks = new Map()
    this.nextId = 0
  }

  /** Process an item. Returns the item augmented with track_id. */
  step(item) {
    const open = []
    for (const t of this.tracks.values()) {
      if (item.frame_idx - t.lastFrame <= this.opts.maxFrameGap) open.push(t)
    }

    let best = null
    let bestIoU = 0
    for (const t of open) {
      if (this.opts.modeMustMatch && t.mode !== item.mode) continue
      const c1 = centroid(t.lastQuad)
      const c2 = centroid(item.quad)
      const dx = c1.x - c2.x
      const dy = c1.y - c2.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const diam = Math.sqrt(quadArea(item.quad))
      const eps = diam * this.opts.centroidEpsRatio
      if (dist > eps * 4) continue // far apart in any case
      const ov = iou(t.lastQuad, item.quad)
      if (ov >= this.opts.iouThreshold && ov > bestIoU) {
        bestIoU = ov
        best = t
      }
    }

    let track
    if (best) {
      track = best
      track.lastFrame = item.frame_idx
      track.lastQuad = item.quad
      track.allItems.push(item)
      if ((item.score ?? 0) > (track.bestScore ?? -Infinity)) {
        track.bestScore = item.score
        track.bestItem = item
      }
    } else {
      track = {
        id: this.nextId++,
        mode: item.mode,
        lastFrame: item.frame_idx,
        lastQuad: item.quad,
        bestScore: item.score ?? 0,
        bestItem: item,
        allItems: [item],
      }
      this.tracks.set(track.id, track)
    }
    return { ...item, track_id: track.id }
  }

  /** Return tracks (one per identity), each with bestItem + topK candidates. */
  finalize(k = 3) {
    return [...this.tracks.values()].map((t) => {
      const sorted = [...t.allItems].sort(
        (a, b) => (b.score ?? 0) - (a.score ?? 0),
      )
      return {
        id: t.id,
        mode: t.mode,
        bestItem: t.bestItem,
        topKItems: sorted.slice(0, k),
        lastFrame: t.lastFrame,
      }
    })
  }
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const tr = new DocTracker()
  // 3 frames same card, 2 frames different card
  const inputs = [
    {
      frame_idx: 0,
      mode: 'card',
      score: 80,
      quad: mkQuad(100, 100, 660, 100, 660, 460, 100, 460),
    },
    {
      frame_idx: 1,
      mode: 'card',
      score: 95,
      quad: mkQuad(105, 102, 665, 100, 660, 462, 102, 460),
    },
    {
      frame_idx: 2,
      mode: 'card',
      score: 70,
      quad: mkQuad(110, 110, 670, 110, 670, 470, 110, 470),
    },
    // gap to new card
    {
      frame_idx: 10,
      mode: 'card',
      score: 60,
      quad: mkQuad(800, 600, 1400, 600, 1400, 960, 800, 960),
    },
    {
      frame_idx: 11,
      mode: 'card',
      score: 88,
      quad: mkQuad(802, 602, 1402, 600, 1400, 962, 800, 962),
    },
  ]
  for (const item of inputs) {
    const out = tr.step(item)
    console.log('frame', out.frame_idx, '→ track_id', out.track_id)
  }
  console.log('finalize:')
  for (const t of tr.finalize()) {
    console.log(
      `  track ${t.id}: bestScore=${t.bestItem.score} frame=${t.bestItem.frame_idx}`,
    )
  }
}

function mkQuad(tlx, tly, trx, tryy, brx, bry, blx, bly) {
  return {
    tl: { x: tlx, y: tly },
    tr: { x: trx, y: tryy },
    br: { x: brx, y: bry },
    bl: { x: blx, y: bly },
  }
}
