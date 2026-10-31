/**
 * Headless eval pipeline: Node-side facade over the SHARED implementation
 * in `@astarworks/scan-core` (packages/core/src/pipeline/), imported as
 * TS source (Bun runs it natively, no build step). The browser binds the
 * same code to DOM canvases + OpenCV.js; here it's @napi-rs/canvas + the
 * Node OpenCV runtime — one contract on both sides, so the harness can't
 * drift from production silently.
 *
 * Only the eval-specific orchestration lives in this file: per-frame
 * trace records (`processFrame`), the legacy hash-clustering reproduction
 * (`clusterAccepted`), and the raw-frame link-distance diagnostic.
 */

import { cv } from './cv-shim.mjs'
import {
  newCanvas,
  canvasToJpegBuffer,
} from './canvas-utils.mjs'
import {
  hamming,
  popcount,
  tileDistance,
} from '../../packages/core/src/pipeline/hash.ts'
import { combinedScore } from '../../packages/core/src/pipeline/score.ts'
import { QuadSmoother, quadArea } from '../../packages/core/src/pipeline/quad-smoother.ts'
import { FrameCollector } from '../../packages/core/src/pipeline/frame-collector.ts'
import { createPipelineOps } from '../../packages/core/src/pipeline/index.ts'

// ---------------------------------------------------------------------------
// Shared pipeline ops (cv + canvas injected) — the SAME implementations the
// browser uses, bound here to @napi-rs/canvas and the Node OpenCV runtime.
// scan-core bridges canvas↔Mat through the 2D context itself, so no
// cv.imread/imshow patching is needed anymore.
// ---------------------------------------------------------------------------
const ops = createPipelineOps({ cv, createCanvas: newCanvas })

// ---------------------------------------------------------------------------
// Constants — shared values live in scan-core pipeline/constants.ts
// ---------------------------------------------------------------------------

import { EXTRACT_W, EXTRACT_H } from '../../packages/core/src/pipeline/constants.ts'
export { EXTRACT_W, EXTRACT_H }

// ---------------------------------------------------------------------------
// Detection / warp / sharpness — unified in @astarworks/scan-core
// (pipeline/detect-otsu.ts, warp.ts, sharpness.ts)
// ---------------------------------------------------------------------------

export const detectWithOpenCV = ops.detectWithOpenCV
export const warpPerspective = ops.warpPerspective
export const computeLaplacian = ops.computeLaplacian
export const computeTenengrad = ops.computeTenengrad

// ---------------------------------------------------------------------------
// pHash + tile-pHash — unified in @astarworks/scan-core (pipeline/hash.ts)
// ---------------------------------------------------------------------------

export const computePHash = ops.computePHash
export const computeTilePHash = ops.computeTilePHash
export { tileDistance }

// ---------------------------------------------------------------------------
// ORB feature matching — Phase 3 algorithm B (post-hoc cluster merger)
// ---------------------------------------------------------------------------
// pHash + tile-pHash both fail to separate "same physical page at
// different angle" from "different page" because their distance
// distributions overlap (same: 8-27, different: 28-40 in tile-pHash).
// ORB compares actual visual features and gives a much sharper signal:
// same-page pairs get 50-300+ inlier matches, different pages typically
// < 20.
//
// We use this as a POST-HOC cluster-merge step, not a primary clustering
// metric, because pairwise ORB on N=150 frames is O(N²) and slow.
// Instead: cluster with a fast hash first (oversplits), then for each
// pair of cluster winners compute ORB match count and merge pairs above
// MERGE_MATCH_THRESHOLD.

export const computeOrbDescriptors = ops.computeOrbDescriptors
export const countOrbMatches = ops.countOrbMatches
export const mergeClustersByOrb = ops.mergeClustersByOrb

export { cv as _cv }

// ---------------------------------------------------------------------------
// Composite score — unified in @astarworks/scan-core (pipeline/score.ts)
// ---------------------------------------------------------------------------

export { combinedScore }

/**
 * Content-change distance between two consecutive RAW frames, measured
 * over the intersection bbox of their detected quads.
 *
 * Why raw frames: warped-crop hashes are poisoned by crop jitter (the
 * quad's relative coverage of the page shifts frame to frame), and ORB
 * fails on dense repetitive text. Two raw frames 100 ms apart, however,
 * show the page at almost the same pixels — comparing the SAME rectangle
 * (quad-intersection bbox) on both frames removes crop jitter from the
 * equation entirely. A page hold yields a small distance; a page turn
 * swaps the content inside the rectangle and yields a large one.
 *
 * Uses the 16-tile percentile distance so a moving hand or glare patch
 * (localized change) doesn't masquerade as a page turn.
 *
 * `makeCanvas(w, h)` is injected so this stays runtime-agnostic.
 */
export function rawLinkDistance(prevCanvas, prevQuad, curCanvas, curQuad, makeCanvas) {
  const bbox = (q) => {
    const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x]
    const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y]
    return {
      x0: Math.max(0, Math.min(...xs)),
      y0: Math.max(0, Math.min(...ys)),
      x1: Math.min(prevCanvas.width, Math.max(...xs)),
      y1: Math.min(prevCanvas.height, Math.max(...ys)),
    }
  }
  const A = bbox(prevQuad)
  const B = bbox(curQuad)
  const x0 = Math.max(A.x0, B.x0)
  const y0 = Math.max(A.y0, B.y0)
  const x1 = Math.min(A.x1, B.x1)
  const y1 = Math.min(A.y1, B.y1)
  const w = Math.floor(x1 - x0)
  const h = Math.floor(y1 - y0)
  if (w < 32 || h < 32) return null // quads barely overlap — no link signal
  const crop = (src) => {
    const c = makeCanvas(256, 256)
    c.getContext('2d').drawImage(src, x0, y0, w, h, 0, 0, 256, 256)
    return c
  }
  const ta = computeTilePHash(crop(prevCanvas))
  const tb = computeTilePHash(crop(curCanvas))
  return Number(tileDistance(ta, tb))
}

// QuadSmoother / quadArea — unified in @astarworks/scan-core
// (pipeline/quad-smoother.ts)
export { QuadSmoother, quadArea }

// ---------------------------------------------------------------------------
// Per-frame orchestration (port of index.vue:320-423 processFrame)
// ---------------------------------------------------------------------------

/**
 * Process one extracted video frame:
 *   detect → confidence-gate → warp → pHash + sharpness → score →
 *   ten-gate → push into collector.
 *
 * Returns a per-frame trace record regardless of whether the frame was
 * accepted, so the harness can log the full decision history.
 */
export function processFrame({
  canvas,
  idx,
  t_s,
  collector,
  minConfidence,
  minTenengrad,
  detection,
}) {
  const trace = {
    idx,
    t_s,
    detected: false,
    confidence: 0,
    lap: 0,
    ten: 0,
    areaFrac: 0,
    score: 0,
    hashHex: null,
    accepted: false,
    rejectReason: null,
    quad: null,
    visibility: null,
  }
  // `detection` lets the caller supply a precomputed detection (e.g. the
  // async YOLO backend): `{ quad, confidence, visibility? }`, or `null` if
  // that detector found nothing. When the key is absent (undefined) we run
  // the built-in synchronous OpenCV detector — confidence 1.0, matching
  // doc-detector.ts:114.
  let det
  if (detection !== undefined) {
    det = detection
  } else {
    const q = detectWithOpenCV(canvas)
    det = q ? { quad: q, confidence: 1.0 } : null
  }
  if (!det) {
    trace.rejectReason = 'no-quad'
    return trace
  }
  const quad = det.quad
  trace.detected = true
  trace.quad = quad
  if (det.visibility) trace.visibility = det.visibility
  const confidence = det.confidence
  trace.confidence = confidence
  if (confidence < minConfidence) {
    trace.rejectReason = 'low-conf'
    return trace
  }
  const warped = warpPerspective(canvas, quad, EXTRACT_W, EXTRACT_H)
  const hash = computePHash(warped)
  const tileHash = computeTilePHash(warped)
  const lap = computeLaplacian(warped)
  const ten = computeTenengrad(warped)
  const areaFrac = quadArea(quad) / (canvas.width * canvas.height)
  const score = combinedScore(lap, ten, confidence, areaFrac)
  trace.lap = lap
  trace.ten = ten
  trace.areaFrac = areaFrac
  trace.score = score
  trace.hashHex = hash.toString(16).padStart(64, '0')
  trace.tileHashHex = tileHash.map((h) => h.toString(16).padStart(16, '0'))
  trace.tileHash = tileHash // bigint[16]; stripped before jsonl emit
  trace.warped = warped // canvas; caller must strip before jsonl emit
  if (ten < minTenengrad) {
    trace.rejectReason = 'blur-gate'
    return trace
  }
  // Use canvas index as deterministic capturedAt — the production code
  // uses performance.now() which is non-deterministic.
  const warpedBuf = canvasToJpegBuffer(warped, 0.75)
  collector.add({
    hash,
    sharpness: lap,
    confidence,
    areaFrac,
    score,
    warpedBlob: warpedBuf, // Buffer; FrameCollector treats it opaquely
    warpedWidth: warped.width,
    warpedHeight: warped.height,
    capturedAt: idx,
  })
  trace.accepted = true
  trace.warpedBuf = warpedBuf
  return trace
}

// ---------------------------------------------------------------------------
// Cluster reproduction with membership (mirrors FrameCollector.selectBest
// but also returns which frames joined each cluster — needed for the HTML
// summary and clusters.jsonl output)
// ---------------------------------------------------------------------------

/**
 * Same algorithm as `FrameCollector.selectBest` (score-descending centroid
 * assignment, no transitive chains), but returns cluster membership too.
 * Each frame in `acceptedFrames` must have `{idx, hash, score}` plus any
 * additional metadata you want to surface; cluster output preserves the
 * full record.
 *
 * `distanceFn(a, b)` defaults to `popcount(a ^ b)` for backward compat
 * (256-bit pHash). Pass `tileDistance` + a `hashKey` of `'tileHash'` to
 * cluster on tile-based hashes instead.
 */
export function clusterAccepted(
  acceptedFrames,
  threshold,
  { hashKey = 'hash', distanceFn = (a, b) => popcount(a ^ b) } = {},
) {
  if (acceptedFrames.length === 0) return []
  if (acceptedFrames.length === 1) {
    return [{ winner: acceptedFrames[0], members: [acceptedFrames[0]] }]
  }
  // Tie-break by idx ASC for determinism (production uses insertion order
  // since `Array.prototype.sort` is stable as of ES2019).
  const sorted = [...acceptedFrames].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.idx - b.idx,
  )
  const clusters = []
  for (const f of sorted) {
    let bestC = -1
    let bestD = Infinity
    for (let c = 0; c < clusters.length; c += 1) {
      const d = distanceFn(f[hashKey], clusters[c].winner[hashKey])
      if (d <= threshold && d < bestD) {
        bestD = d
        bestC = c
      }
    }
    if (bestC < 0) {
      clusters.push({ winner: f, members: [f] })
    } else {
      clusters[bestC].members.push(f)
    }
  }
  // Final order: by winner.idx (ascending) — matches FrameCollector.
  clusters.sort((a, b) => a.winner.idx - b.winner.idx)
  // Within each cluster sort members by idx for readability.
  for (const c of clusters) c.members.sort((a, b) => a.idx - b.idx)
  return clusters
}

export { hamming, FrameCollector }
