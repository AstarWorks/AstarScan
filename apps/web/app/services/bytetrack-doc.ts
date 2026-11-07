/**
 * ByteTrack-style identity tracker for document detections.
 *
 * TS port of `scripts/eval/lib/bytetrack-doc.mjs`. See that file for the
 * design rationale: we don't need full Kalman / Hungarian assignment since
 * our cards sit relatively still between hand movements. Centroid distance
 * + IoU within a small frame-gap window is plenty.
 *
 * Each "track" represents one physical document; when the user moves on to
 * the next card, the track ends and a new one starts.
 */

import type { Quad } from '@astarworks/scan-core'
import type { DocumentMode } from './quad-classify'
import { centroid, iou, quadArea } from './quad-geometry'

export interface TrackInput<T> {
  readonly frame_idx: number
  readonly ts_ms: number
  readonly quad: Quad
  readonly mode: DocumentMode
  readonly score: number
  readonly payload: T
}

interface TrackState<T> {
  id: number
  mode: DocumentMode
  lastFrame: number
  lastQuad: Quad
  bestScore: number
  bestInput: TrackInput<T>
  allInputs: TrackInput<T>[]
}

export interface Track<T> {
  readonly id: number
  readonly mode: DocumentMode
  readonly lastFrame: number
  readonly bestInput: TrackInput<T>
  /** All inputs that were assigned to this track, sorted by score desc. */
  readonly topKInputs: readonly TrackInput<T>[]
}

export interface DocTrackerOpts {
  /** Max gap (in frames) before a track is closed. */
  maxFrameGap?: number
  /** Centroid distance as a fraction of detected quad diameter. */
  centroidEpsRatio?: number
  /** IoU threshold to associate detections to existing tracks. */
  iouThreshold?: number
  /** Require detections to share the same mode (card/a4/…) to associate. */
  modeMustMatch?: boolean
}

const DEFAULTS: Required<DocTrackerOpts> = {
  maxFrameGap: 4,
  centroidEpsRatio: 0.15,
  iouThreshold: 0.4,
  modeMustMatch: true,
}

export class DocTracker<T> {
  readonly #opts: Required<DocTrackerOpts>
  readonly #tracks = new Map<number, TrackState<T>>()
  #nextId = 0

  constructor(opts: DocTrackerOpts = {}) {
    this.#opts = { ...DEFAULTS, ...opts }
  }

  /** Process an input, returning the assigned track id. */
  step(input: TrackInput<T>): { input: TrackInput<T>; track_id: number } {
    const open: TrackState<T>[] = []
    for (const t of this.#tracks.values()) {
      if (input.frame_idx - t.lastFrame <= this.#opts.maxFrameGap) open.push(t)
    }

    let best: TrackState<T> | null = null
    let bestIoU = 0
    for (const t of open) {
      if (this.#opts.modeMustMatch && t.mode !== input.mode) continue
      const c1 = centroid(t.lastQuad)
      const c2 = centroid(input.quad)
      const dx = c1.x - c2.x
      const dy = c1.y - c2.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      const diam = Math.sqrt(quadArea(input.quad))
      const eps = diam * this.#opts.centroidEpsRatio
      if (distance > eps * 4) continue
      const ov = iou(t.lastQuad, input.quad)
      if (ov >= this.#opts.iouThreshold && ov > bestIoU) {
        bestIoU = ov
        best = t
      }
    }

    let track: TrackState<T>
    if (best) {
      track = best
      track.lastFrame = input.frame_idx
      track.lastQuad = input.quad
      track.allInputs.push(input)
      if (input.score > track.bestScore) {
        track.bestScore = input.score
        track.bestInput = input
      }
    } else {
      track = {
        id: this.#nextId++,
        mode: input.mode,
        lastFrame: input.frame_idx,
        lastQuad: input.quad,
        bestScore: input.score,
        bestInput: input,
        allInputs: [input],
      }
      this.#tracks.set(track.id, track)
    }
    return { input, track_id: track.id }
  }

  finalize(k = 3): Track<T>[] {
    return [...this.#tracks.values()].map((t) => {
      const sorted = [...t.allInputs].sort((a, b) => b.score - a.score)
      return {
        id: t.id,
        mode: t.mode,
        lastFrame: t.lastFrame,
        bestInput: t.bestInput,
        topKInputs: sorted.slice(0, k),
      }
    })
  }
}
