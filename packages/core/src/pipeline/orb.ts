/**
 * ORB feature matching — RANSAC-validated inliers + spatial grid coverage.
 *
 * pHash + tile-pHash both fail to separate "same physical page at a
 * different angle" from "different page" because their distance
 * distributions overlap. ORB compares actual visual features: same-page
 * pairs get 50-300+ inlier matches, different pages typically < 20.
 *
 * The gridCoverage signal is what catches boilerplate false-merges:
 * same page at angle → matches spread across the whole page (10-16 cells);
 * shared boilerplate (multilingual notice, footer) → matches concentrate
 * in one region (2-6 cells). Inlier count alone can't separate these.
 *
 * Caveat (measured): dense repetitive text defeats ORB entirely — 0-14
 * inliers on genuine same-page pairs, because repetitive glyph features
 * die in crossCheck. ORB works on covers/graphics; text pairs need the
 * OCR verifier.
 */

import type { CanvasLike, CvBFMatcher, CvMat, CvOrb, PipelineDeps } from './deps.js'
import { matFromCanvas } from './cv-canvas.js'
import {
  ORB_CROP_TOP_FRAC,
  ORB_GRID,
  ORB_MAX_DESC_DIST,
  ORB_MAX_FEATURES,
} from './constants.js'

/** Owned by the caller: `descriptors.delete()` must be called when done. */
export interface OrbResult {
  descriptors: CvMat
  keypoints: Array<[number, number]>
}

export interface OrbMatchResult {
  inliers: number
  gridCoverage: number
}

export interface OrbCluster<T> {
  winner: T
  members: T[]
}

export interface OrbMergeRecord {
  i: number
  j: number
  m: number
  tileDist: number
  gridCoverage: number
}

export interface OrbOps {
  /**
   * Compute ORB descriptors AND keypoints for a canvas (top 60 % crop —
   * see ORB_CROP_TOP_FRAC). Returns null for featureless crops. Caller
   * owns the result and must `.delete()` its descriptors.
   */
  computeOrbDescriptors(canvas: CanvasLike): OrbResult | null
  /** RANSAC-validated inlier count + 4×4 grid coverage of the inliers. */
  countOrbMatches(orbA: OrbResult | null, orbB: OrbResult | null, maxDescDist?: number): OrbMatchResult
  /** Union-find merge of hash clusters whose winners agree on ORB +
   *  tile-distance + grid coverage. */
  mergeClustersByOrb<T extends { idx: number; score: number; tileHash?: readonly bigint[] }>(
    clusters: Array<OrbCluster<T>>,
    getWinnerCanvas: (idx: number) => Promise<CanvasLike>,
    mergeMatchThreshold?: number,
    tileMergeMax?: number,
    minGridCoverage?: number,
  ): Promise<{ merged: Array<OrbCluster<T>>; matchCounts: OrbMergeRecord[] }>
}

export function createOrbOps({ cv }: PipelineDeps): OrbOps {
  let orbDetector: CvOrb | null = null
  const getOrb = (): CvOrb => {
    if (!orbDetector) orbDetector = new cv.ORB(ORB_MAX_FEATURES)
    return orbDetector
  }

  let bfMatcher: CvBFMatcher | null = null
  const getBfMatcher = (): CvBFMatcher => {
    if (!bfMatcher) bfMatcher = new cv.BFMatcher(cv.NORM_HAMMING, true)
    return bfMatcher
  }

  function computeOrbDescriptors(canvas: CanvasLike): OrbResult | null {
    const src = matFromCanvas(cv, canvas)
    const gray = new cv.Mat()
    const keypoints = new cv.KeyPointVector()
    const descriptors = new cv.Mat()
    let cropped: CvMat | null = null
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
      // Crop to the top fraction of the page (cv.Mat.roi returns a view;
      // we clone so the descriptor extractor reads independent memory
      // without alignment surprises).
      const rect = new cv.Rect(0, 0, gray.cols, Math.floor(gray.rows * ORB_CROP_TOP_FRAC))
      cropped = gray.roi(rect).clone()
      getOrb().detectAndCompute(cropped, new cv.Mat(), keypoints, descriptors)
      if (descriptors.rows === 0) {
        // No features (blank/low-texture crop). Cleanup happens in finally —
        // deleting keypoints here too double-deletes and throws BindingError.
        return null
      }
      // Clone descriptors AND copy keypoint positions out (KeyPointVector
      // can't be cloned and we'll delete it on cleanup).
      const descClone = descriptors.clone()
      const kps: Array<[number, number]> = []
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

  function countOrbMatches(
    orbA: OrbResult | null,
    orbB: OrbResult | null,
    maxDescDist: number = ORB_MAX_DESC_DIST,
  ): OrbMatchResult {
    if (!orbA || !orbB || orbA.descriptors.rows === 0 || orbB.descriptors.rows === 0) {
      return { inliers: 0, gridCoverage: 0 }
    }
    const matches = new cv.DMatchVector()
    let srcPts: CvMat | null = null
    let dstPts: CvMat | null = null
    let mask: CvMat | null = null
    let H: CvMat | null = null
    try {
      getBfMatcher().match(orbA.descriptors, orbB.descriptors, matches)
      const goodPairs: Array<[[number, number], [number, number]]> = []
      const n = matches.size()
      for (let i = 0; i < n; i += 1) {
        const m = matches.get(i)
        if (m.distance < maxDescDist) {
          const a = orbA.keypoints[m.queryIdx]
          const b = orbB.keypoints[m.trainIdx]
          if (a && b) goodPairs.push([a, b])
        }
      }
      if (goodPairs.length < 4) {
        return { inliers: goodPairs.length, gridCoverage: 0 }
      }
      const srcArr: number[] = []
      const dstArr: number[] = []
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
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const [a] of goodPairs) {
        if (a[0] < minX) minX = a[0]
        if (a[0] > maxX) maxX = a[0]
        if (a[1] < minY) minY = a[1]
        if (a[1] > maxY) maxY = a[1]
      }
      // Pad to avoid div/0 on degenerate cases
      const w = Math.max(1, maxX - minX)
      const h = Math.max(1, maxY - minY)
      const cellsHit = new Set<number>()
      let inliers = 0
      for (let i = 0; i < mask.rows; i += 1) {
        if (mask.data[i] === 0) continue
        inliers += 1
        const pair = goodPairs[i]
        if (!pair) continue
        const [x, y] = pair[0]
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

  async function mergeClustersByOrb<
    T extends { idx: number; score: number; tileHash?: readonly bigint[] },
  >(
    clusters: Array<OrbCluster<T>>,
    getWinnerCanvas: (idx: number) => Promise<CanvasLike>,
    mergeMatchThreshold = 80,
    tileMergeMax = Infinity,
    minGridCoverage = 0,
  ): Promise<{ merged: Array<OrbCluster<T>>; matchCounts: OrbMergeRecord[] }> {
    const { tileDistance } = await import('./hash.js')
    const n = clusters.length
    if (n <= 1) return { merged: clusters, matchCounts: [] }

    // Compute descriptors for each winner once.
    const descCache: Array<OrbResult | null> = []
    for (let i = 0; i < n; i += 1) {
      const canvas = await getWinnerCanvas(clusters[i]!.winner.idx)
      descCache.push(computeOrbDescriptors(canvas))
    }

    // Union-find
    const parent = new Array(n).fill(0).map((_, i) => i)
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)))
    const union = (i: number, j: number): void => {
      const ri = find(i)
      const rj = find(j)
      if (ri !== rj) parent[ri] = rj
    }

    const matchCounts: OrbMergeRecord[] = []
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        // Dual-criterion gate: tile distance MUST be within tileMergeMax
        // for the merge to be considered. If the cluster winners don't
        // both have tileHash, fall back to ORB-only.
        const wi = clusters[i]!.winner
        const wj = clusters[j]!.winner
        const tDist =
          wi.tileHash && wj.tileHash ? tileDistance(wi.tileHash, wj.tileHash) : 0
        const orbResult = countOrbMatches(descCache[i] ?? null, descCache[j] ?? null)
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
    const groups = new Map<number, number[]>()
    for (let i = 0; i < n; i += 1) {
      const r = find(i)
      if (!groups.has(r)) groups.set(r, [])
      groups.get(r)!.push(i)
    }

    const merged: Array<OrbCluster<T>> = []
    for (const idxs of groups.values()) {
      const allMembers = idxs.flatMap((i) => clusters[i]!.members)
      const winner = idxs
        .map((i) => clusters[i]!.winner)
        .reduce((best, w) => (w.score > best.score ? w : best))
      merged.push({ winner, members: allMembers })
    }
    merged.sort((a, b) => a.winner.idx - b.winner.idx)
    for (const c of merged) c.members.sort((a, b) => a.idx - b.idx)

    // Cleanup
    for (const d of descCache) d?.descriptors.delete()

    return { merged, matchCounts }
  }

  return { computeOrbDescriptors, countOrbMatches, mergeClustersByOrb }
}
