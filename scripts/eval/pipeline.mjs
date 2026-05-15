/**
 * Headless eval pipeline: mirror of the in-browser flow at
 * `apps/web/app/pages/index.vue` + `apps/web/app/services/*.ts`,
 * but driven from Node so we can collect per-frame metrics
 * without a real video element.
 *
 * The detection / warp / metric / hash logic is COPY-PASTED here for
 * Phase 1 because the production code uses `window.cv` and
 * `document.createElement('canvas')`. Phase 2 will extract the
 * orchestration into a shared `services/frame-pipeline.ts` and replace
 * these copies with imports — the SAME contract on both sides will
 * stop the harness from drifting silently.
 *
 * `FrameCollector` from `apps/web/app/services/frame-collector.ts` is
 * imported directly because it has no DOM deps.
 */

import { cv } from './cv-shim.mjs'
import {
  ImageData,
  newCanvas,
  jpegToCanvas,
  canvasToJpegBuffer,
} from './canvas-utils.mjs'
import { FrameCollector } from '../../apps/web/app/services/frame-collector.ts'

// ---------------------------------------------------------------------------
// cv.imread / cv.imshow bridge for @napi-rs/canvas
// ---------------------------------------------------------------------------
// The production code calls `cv.imread(canvas)` / `cv.imshow(canvas, mat)`,
// which only work in the browser (they assume a real HTMLCanvasElement
// with a 2D context). Emscripten's bundled stubs exist in Node too but
// are no-ops. We replace them with versions that use @napi-rs/canvas's
// getImageData/putImageData. After this patch, the production functions
// run unchanged when copy-pasted below.
const originalImread = cv.imread
const originalImshow = cv.imshow
cv.imread = function bridgedImread(canvas) {
  const ctx = canvas.getContext('2d')
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const mat = new cv.Mat(id.height, id.width, cv.CV_8UC4)
  mat.data.set(id.data)
  return mat
}
cv.imshow = function bridgedImshow(canvas, mat) {
  const w = mat.cols
  const h = mat.rows
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const buf = new Uint8ClampedArray(mat.data.length)
  buf.set(mat.data)
  const id = new ImageData(buf, w, h)
  canvas.getContext('2d').putImageData(id, 0, 0)
}

// ---------------------------------------------------------------------------
// Constants — match index.vue (Phase 2 extracts these to shared module)
// ---------------------------------------------------------------------------

export const EXTRACT_W = 1200
export const EXTRACT_H = 1600
const MORPH_KERNEL = 15
const MIN_FRAME_FRACTION = 0.15
const MAX_FRAME_FRACTION = 0.97
const HASH_SIZE = 16

// ---------------------------------------------------------------------------
// Detection (port of doc-detector.ts:183-239 + helpers)
// ---------------------------------------------------------------------------

function rotatedRectCorners(rect) {
  const cx = rect.center.x
  const cy = rect.center.y
  const halfW = rect.size.width / 2
  const halfH = rect.size.height / 2
  const rad = (rect.angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const local = [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ]
  return local.map(([dx, dy]) => ({
    x: cx + dx * cos - dy * sin,
    y: cy + dx * sin + dy * cos,
  }))
}

function orderQuadCorners(pts) {
  let tl = pts[0]
  let tr = pts[0]
  let br = pts[0]
  let bl = pts[0]
  let minSum = Infinity
  let maxSum = -Infinity
  let minDiff = Infinity
  let maxDiff = -Infinity
  for (const p of pts) {
    const s = p.x + p.y
    const d = p.y - p.x
    if (s < minSum) { minSum = s; tl = p }
    if (s > maxSum) { maxSum = s; br = p }
    if (d < minDiff) { minDiff = d; tr = p }
    if (d > maxDiff) { maxDiff = d; bl = p }
  }
  return { tl, tr, br, bl }
}

export function detectWithOpenCV(frame) {
  const src = cv.imread(frame)
  const gray = new cv.Mat()
  const binary = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  const kernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(MORPH_KERNEL, MORPH_KERNEL),
  )
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU)
    cv.morphologyEx(binary, binary, cv.MORPH_CLOSE, kernel)
    cv.morphologyEx(binary, binary, cv.MORPH_OPEN, kernel)
    cv.findContours(
      binary,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    )
    const frameArea = frame.width * frame.height
    const minArea = frameArea * MIN_FRAME_FRACTION
    const maxArea = frameArea * MAX_FRAME_FRACTION
    let bestIdx = -1
    let bestArea = 0
    for (let i = 0; i < contours.size(); i += 1) {
      const c = contours.get(i)
      const area = cv.contourArea(c)
      if (area > bestArea && area >= minArea && area <= maxArea) {
        bestArea = area
        bestIdx = i
      }
      c.delete()
    }
    if (bestIdx < 0) return null
    const bestContour = contours.get(bestIdx)
    const rect = cv.minAreaRect(bestContour)
    bestContour.delete()
    return orderQuadCorners(rotatedRectCorners(rect))
  } finally {
    src.delete()
    gray.delete()
    binary.delete()
    contours.delete()
    hierarchy.delete()
    kernel.delete()
  }
}

// ---------------------------------------------------------------------------
// Warp (port of perspective-warper.ts:91-157)
// ---------------------------------------------------------------------------

export function warpPerspective(source, quad, width, height) {
  const srcMat = cv.imread(source)
  const dstMat = new cv.Mat()
  const srcPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    quad.tl.x, quad.tl.y,
    quad.tr.x, quad.tr.y,
    quad.br.x, quad.br.y,
    quad.bl.x, quad.bl.y,
  ])
  const dstPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    width, 0,
    width, height,
    0, height,
  ])
  let M = null
  try {
    M = cv.getPerspectiveTransform(srcPoints, dstPoints)
    cv.warpPerspective(
      srcMat, dstMat, M,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(),
    )
    const out = newCanvas(width, height)
    cv.imshow(out, dstMat)
    return out
  } finally {
    srcMat.delete()
    dstMat.delete()
    srcPoints.delete()
    dstPoints.delete()
    M?.delete()
  }
}

// ---------------------------------------------------------------------------
// Sharpness metrics (port of index.vue:177-235)
// ---------------------------------------------------------------------------

export function computeLaplacian(canvas) {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const lap = new cv.Mat()
  const mean = new cv.Mat()
  const stddev = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.Laplacian(gray, lap, cv.CV_64F, 1, 1, 0, cv.BORDER_DEFAULT)
    cv.meanStdDev(lap, mean, stddev)
    const sd = stddev.data64F[0] ?? 0
    return sd * sd
  } finally {
    src.delete()
    gray.delete()
    lap.delete()
    mean.delete()
    stddev.delete()
  }
}

export function computeTenengrad(canvas) {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const gx = new cv.Mat()
  const gy = new cv.Mat()
  const gx2 = new cv.Mat()
  const gy2 = new cv.Mat()
  const mag = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.Sobel(gray, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT)
    cv.Sobel(gray, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT)
    cv.multiply(gx, gx, gx2)
    cv.multiply(gy, gy, gy2)
    cv.add(gx2, gy2, mag)
    const m = cv.mean(mag)
    return Math.sqrt(m[0] ?? 0)
  } finally {
    src.delete()
    gray.delete()
    gx.delete()
    gy.delete()
    gx2.delete()
    gy2.delete()
    mag.delete()
  }
}

// ---------------------------------------------------------------------------
// pHash (port of phash-dedup.ts:53-76, with a node-side thumb canvas)
// ---------------------------------------------------------------------------

let thumbCanvas = null
function getThumbCanvas() {
  if (!thumbCanvas) thumbCanvas = newCanvas(HASH_SIZE, HASH_SIZE)
  return thumbCanvas
}

function avgHashFromImageData(data, count) {
  const gray = new Float64Array(count)
  let sum = 0
  for (let i = 0, j = 0; j < count; i += 4, j += 1) {
    const v =
      0.2126 * (data[i] ?? 0) +
      0.7152 * (data[i + 1] ?? 0) +
      0.0722 * (data[i + 2] ?? 0)
    gray[j] = v
    sum += v
  }
  const mean = sum / count
  let hash = 0n
  for (let j = 0; j < count; j += 1) {
    if ((gray[j] ?? 0) > mean) hash |= 1n << BigInt(j)
  }
  return hash
}

export function computePHash(source) {
  const ctx = getThumbCanvas().getContext('2d')
  ctx.drawImage(source, 0, 0, HASH_SIZE, HASH_SIZE)
  const { data } = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE)
  return avgHashFromImageData(data, HASH_SIZE * HASH_SIZE)
}

// ---------------------------------------------------------------------------
// Tile-based pHash — Phase 3 algorithm A (oversplit-resistant)
// ---------------------------------------------------------------------------
// Split the warped page into a 4×4 grid; hash each tile separately. The
// distance between two tile-hash arrays is the **80th-percentile** of
// per-tile Hamming distances. Rationale: a hand occluding one corner
// flips ~50 % of bits in 1-2 tiles but leaves the other 14-15 untouched.
// The 80th percentile (i.e. tile rank 12 of 16, sorted ascending) reflects
// "how well do the well-aligned tiles match," ignoring the worst-affected
// few. Same physical page → 80th percentile is low. Different page → all
// tiles are perturbed → 80th percentile is high.

const TILE_GRID = 4
const TILE_HASH_SIZE = 8
const TILE_BITS = TILE_HASH_SIZE * TILE_HASH_SIZE // 64

let tileCanvas = null
function getTileCanvas() {
  if (!tileCanvas) tileCanvas = newCanvas(TILE_HASH_SIZE, TILE_HASH_SIZE)
  return tileCanvas
}

export function computeTilePHash(source) {
  const W = source.width
  const H = source.height
  const tileW = W / TILE_GRID
  const tileH = H / TILE_GRID
  const ctx = getTileCanvas().getContext('2d')
  const hashes = []
  for (let row = 0; row < TILE_GRID; row += 1) {
    for (let col = 0; col < TILE_GRID; col += 1) {
      ctx.clearRect(0, 0, TILE_HASH_SIZE, TILE_HASH_SIZE)
      ctx.drawImage(
        source,
        col * tileW, row * tileH, tileW, tileH,
        0, 0, TILE_HASH_SIZE, TILE_HASH_SIZE,
      )
      const { data } = ctx.getImageData(0, 0, TILE_HASH_SIZE, TILE_HASH_SIZE)
      hashes.push(avgHashFromImageData(data, TILE_BITS))
    }
  }
  return hashes
}

/** 80th-percentile per-tile Hamming distance between two tile hashes. */
export function tileDistance(a, b, percentile = 0.8) {
  const dists = []
  for (let i = 0; i < a.length; i += 1) dists.push(popcount(a[i] ^ b[i]))
  dists.sort((x, y) => x - y)
  const idx = Math.min(
    dists.length - 1,
    Math.floor(percentile * (dists.length - 1)),
  )
  return dists[idx]
}

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

let orbDetector = null
function getOrb() {
  if (!orbDetector) orbDetector = new cv.ORB(500) // 500 keypoints max
  return orbDetector
}

let bfMatcher = null
function getBfMatcher() {
  if (!bfMatcher) bfMatcher = new cv.BFMatcher(cv.NORM_HAMMING, true)
  return bfMatcher
}

/**
 * Compute ORB descriptors AND keypoints for a canvas. We need both
 * for RANSAC homography. Caller owns the returned Mats/vectors and
 * must `.delete()` them all.
 *
 * Crops to the top 60% of the page before feature extraction. Multi-page
 * documents (manuals, legal docs) routinely repeat boilerplate at the
 * bottom (multilingual notices, page footers, addresses). Without
 * cropping, ORB+RANSAC would happily validate the boilerplate as a
 * planar match across two visually different pages, producing false
 * "same page" merges. The top 60% concentrates on the unique content.
 * For pages where content extends below 60% (book covers, edge-to-edge
 * photos), the crop still captures most of the distinguishing features.
 */
const ORB_CROP_TOP_FRAC = 0.6

export function computeOrbDescriptors(canvas) {
  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  const keypoints = new cv.KeyPointVector()
  const descriptors = new cv.Mat()
  let cropped = null
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    // Crop to the top fraction of the page in-place (cv.Mat.roi returns
    // a view; we clone so the descriptor extractor reads independent
    // memory without alignment surprises).
    const rect = new cv.Rect(0, 0, gray.cols, Math.floor(gray.rows * ORB_CROP_TOP_FRAC))
    cropped = gray.roi(rect).clone()
    const orb = getOrb()
    orb.detectAndCompute(cropped, new cv.Mat(), keypoints, descriptors)
    if (descriptors.rows === 0) {
      keypoints.delete()
      return null
    }
    // Clone descriptors AND copy keypoint positions out (KeyPointVector
    // can't be cloned and we'll delete it on cleanup).
    const descClone = descriptors.clone()
    const kps = []
    const n = keypoints.size()
    for (let i = 0; i < n; i += 1) {
      const k = keypoints.get(i)
      kps.push([k.pt.x, k.pt.y])
    }
    return { descriptors: descClone, keypoints: kps }
  } finally {
    src.delete()
    gray.delete()
    cropped?.delete()
    keypoints.delete()
    descriptors.delete()
  }
}

/**
 * Compute RANSAC-validated ORB inliers between two ORB results AND the
 * spatial coverage of those inliers across the page.
 *
 * Returns `{inliers, gridCoverage}` where:
 *   - `inliers`: count of matches consistent with a single homography
 *     (RANSAC, threshold 3 px). Same physical page → 30-150; different
 *     pages with shared boilerplate → varies
 *   - `gridCoverage`: count of 4×4 grid cells containing at least one
 *     inlier keypoint, based on the keypoint's location in image A's
 *     coordinate space. Range 0-16
 *
 * The gridCoverage signal is what catches boilerplate false-merges:
 *   - same page at angle: matches spread across the whole page → 10-16
 *   - boilerplate shared (multilingual notice, page footer): matches
 *     concentrate in the boilerplate region → 2-6
 * pHash and ORB-count alone can't separate these (both bands overlap
 * 30-100 inliers). gridCoverage gives a clean ≥2× separation.
 */
const ORB_GRID = 4 // 4×4 = 16 cells

export function countOrbMatches(orbA, orbB, maxDescDist = 35) {
  if (!orbA || !orbB || orbA.descriptors.rows === 0 || orbB.descriptors.rows === 0) {
    return { inliers: 0, gridCoverage: 0 }
  }
  const matches = new cv.DMatchVector()
  let srcPts = null
  let dstPts = null
  let mask = null
  let H = null
  try {
    getBfMatcher().match(orbA.descriptors, orbB.descriptors, matches)
    const goodPairs = []
    const n = matches.size()
    for (let i = 0; i < n; i += 1) {
      const m = matches.get(i)
      if (m.distance < maxDescDist) {
        goodPairs.push([orbA.keypoints[m.queryIdx], orbB.keypoints[m.trainIdx]])
      }
    }
    if (goodPairs.length < 4) {
      return { inliers: goodPairs.length, gridCoverage: 0 }
    }
    const srcArr = []
    const dstArr = []
    for (const [a, b] of goodPairs) {
      srcArr.push(a[0], a[1])
      dstArr.push(b[0], b[1])
    }
    srcPts = cv.matFromArray(goodPairs.length, 1, cv.CV_32FC2, srcArr)
    dstPts = cv.matFromArray(goodPairs.length, 1, cv.CV_32FC2, dstArr)
    mask = new cv.Mat()
    H = cv.findHomography(srcPts, dstPts, cv.RANSAC, 3.0, mask)
    if (H.rows === 0) return { inliers: 0, gridCoverage: 0 }
    // Bounding box of all keypoints (used to normalize grid cells —
    // ORB ran on the cropped region so we want coverage relative to
    // that crop, not the full page).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [a] of goodPairs) {
      if (a[0] < minX) minX = a[0]
      if (a[0] > maxX) maxX = a[0]
      if (a[1] < minY) minY = a[1]
      if (a[1] > maxY) maxY = a[1]
    }
    // Pad to avoid div/0 on degenerate cases
    const w = Math.max(1, maxX - minX)
    const h = Math.max(1, maxY - minY)
    const cellsHit = new Set()
    let inliers = 0
    for (let i = 0; i < mask.rows; i += 1) {
      if (mask.data[i] === 0) continue
      inliers += 1
      const [x, y] = goodPairs[i][0]
      const cx = Math.min(ORB_GRID - 1, Math.floor(((x - minX) / w) * ORB_GRID))
      const cy = Math.min(ORB_GRID - 1, Math.floor(((y - minY) / h) * ORB_GRID))
      cellsHit.add(cy * ORB_GRID + cx)
    }
    return { inliers, gridCoverage: cellsHit.size }
  } finally {
    matches.delete()
    srcPts?.delete()
    dstPts?.delete()
    mask?.delete()
    H?.delete()
  }
}

/**
 * Take an array of clusters (output of `clusterAccepted`) and merge any
 * pair satisfying BOTH:
 *   (a) ORB inliers ≥ `mergeMatchThreshold`
 *   (b) tile-pHash distance between cluster winners ≤ `tileMergeMax`
 *
 * The tile-distance gate is the dual-criterion safeguard: pages that
 * share boilerplate (multilingual notices, page footers) get high ORB
 * inliers because the boilerplate is a planar feature group, but their
 * tile-pHash distance reflects content difference and stays elevated.
 * Requiring agreement from both signals filters out boilerplate
 * false-merges while preserving genuine same-page merges (which agree
 * on both: high ORB inliers AND low tile distance).
 *
 * Pass `tileMergeMax = Infinity` to disable the gate (legacy behavior).
 *
 * Uses union-find for transitive merging. Caller must supply
 * `getWinnerCanvas(idx) → Canvas` so we can load the warped JPEG of each
 * winner on demand. Returns `{ merged, matchCounts }` where each entry
 * also carries `tileDist` for diagnostics.
 */
export async function mergeClustersByOrb(
  clusters,
  getWinnerCanvas,
  mergeMatchThreshold = 80,
  tileMergeMax = Infinity,
  minGridCoverage = 0,
) {
  const n = clusters.length
  if (n <= 1) return { merged: clusters, matchCounts: [] }

  // Compute descriptors for each winner once.
  const descCache = []
  for (let i = 0; i < n; i += 1) {
    const canvas = await getWinnerCanvas(clusters[i].winner.idx)
    descCache.push(computeOrbDescriptors(canvas))
  }

  // Union-find
  const parent = new Array(n).fill(0).map((_, i) => i)
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (i, j) => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[ri] = rj
  }

  const matchCounts = []
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      // Dual-criterion gate: tile distance MUST be within tileMergeMax
      // for the merge to be considered. If the cluster winners don't
      // both have tileHash, fall back to ORB-only.
      const wi = clusters[i].winner
      const wj = clusters[j].winner
      const tDist =
        wi.tileHash && wj.tileHash ? tileDistance(wi.tileHash, wj.tileHash) : 0
      const orbResult = countOrbMatches(descCache[i], descCache[j])
      matchCounts.push({
        i,
        j,
        m: orbResult.inliers,
        tileDist: tDist,
        gridCoverage: orbResult.gridCoverage,
      })
      if (
        orbResult.inliers >= mergeMatchThreshold &&
        tDist <= tileMergeMax &&
        orbResult.gridCoverage >= minGridCoverage
      ) {
        union(i, j)
      }
    }
  }

  // Group by root
  const groups = new Map()
  for (let i = 0; i < n; i += 1) {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(i)
  }

  const merged = []
  for (const idxs of groups.values()) {
    const allMembers = idxs.flatMap((i) => clusters[i].members)
    const winner = idxs
      .map((i) => clusters[i].winner)
      .reduce((best, w) => (w.score > best.score ? w : best))
    merged.push({ winner, members: allMembers })
  }
  merged.sort((a, b) => a.winner.idx - b.winner.idx)
  for (const c of merged) c.members.sort((a, b) => a.idx - b.idx)

  // Cleanup
  for (const d of descCache) d?.descriptors.delete()

  return { merged, matchCounts }
}

export { cv as _cv }

// ---------------------------------------------------------------------------
// Composite score (port of index.vue:262-271)
// ---------------------------------------------------------------------------

export function combinedScore(laplacian, tenengrad, confidence, areaFrac) {
  const normLap = Math.min(1, laplacian / 2000)
  const normTen = Math.min(1, tenengrad / 400)
  return 0.3 * normLap + 0.3 * normTen + 0.2 * areaFrac + 0.2 * confidence
}

export function quadArea(q) {
  const xs = [q.tl.x, q.tr.x, q.br.x, q.bl.x]
  const ys = [q.tl.y, q.tr.y, q.br.y, q.bl.y]
  let s = 0
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4
    s += (xs[i] ?? 0) * (ys[j] ?? 0) - (xs[j] ?? 0) * (ys[i] ?? 0)
  }
  return Math.abs(s) / 2
}

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
  }
  const quad = detectWithOpenCV(canvas)
  if (!quad) {
    trace.rejectReason = 'no-quad'
    return trace
  }
  trace.detected = true
  trace.quad = quad
  // OpenCV path returns confidence 1.0 (matches doc-detector.ts:114)
  const confidence = 1.0
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

function popcount(x) {
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

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

/** Hamming distance between two 256-bit pHash bigints. */
export function hamming(a, b) {
  return popcount(a ^ b)
}

export { FrameCollector }
