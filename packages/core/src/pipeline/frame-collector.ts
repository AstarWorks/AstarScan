/**
 * `FrameCollector` — batch 収集 + クラスタリング + ベスト選抜。
 *
 * The scanner pipeline pushes every detected frame (warped page + metadata)
 * into the collector without deciding whether it's a "new page" or "the
 * best frame of the current page". When the scan ends (video end / user
 * stops camera), `selectBest()` runs once.
 *
 * Clustering strategy: online centroid assignment. For each frame, find
 * the existing cluster whose current best-scoring member has the closest
 * pHash; if the Hamming distance is within `threshold`, join that cluster,
 * otherwise start a new one. Centroid is the cluster's current winner by
 * score. This avoids the chain-merge failure of Union-Find — e.g. 20
 * shots of the same book cover at varying angles (pairwise hamming spread
 * of 60-80) would all fall within 60 of the cluster's winner hash, so
 * they collapse to one cluster instead of N mini-clusters linked by
 * transitively close neighbors.
 *
 * Within each cluster, the single frame with the highest `score`
 * (Laplacian + Tenengrad + confidence + area, weighted) is the winner.
 *
 * Batch over streaming buys us:
 *   - No "did the user turn the page yet?" heuristic needed
 *   - The commit decision sees the whole frame history at once
 *   - ~10 MB of in-memory JPEG blobs for a 60-second scan, fine in the
 *     browser
 *
 * `TBlob` is the JPEG container type — `Blob` in the browser, `Buffer`
 * in the Node eval harness. The collector treats it opaquely.
 */

import { popcount, tileDistance } from './hash.js'

export interface DetectedFrame<TBlob = unknown> {
  /** 256-bit pHash of the warped canvas. Used by `selectBest`. */
  hash: bigint
  /** 16-element tile-pHash (4×4 grid, 64-bit per tile) of the warped
   *  canvas. Used by `selectBestByTile`. Optional so callers that don't
   *  need tile clustering don't have to compute it. */
  tileHash?: bigint[]
  /** Laplacian variance of the warped canvas (grayscale). */
  sharpness: number
  /** Detector confidence in [0, 1]. 1.0 for OpenCV fallback. */
  confidence: number
  /** Fraction of the source frame covered by the detected quad. */
  areaFrac: number
  /** Composite score used for ranking within a cluster. */
  score: number
  /** JPEG-encoded warped canvas. Kept until commit; then blob is
   *  converted to a data URL for storage. */
  warpedBlob: TBlob
  /** Pixel dimensions of the warped canvas (constant across frames in
   *  practice but carried here to avoid assumptions). */
  warpedWidth: number
  warpedHeight: number
  /** Monotonic capture time (ms since page load), for tie-breaking. */
  capturedAt: number
}

const DEFAULT_CLUSTER_THRESHOLD = 40
const DEFAULT_MAX_BUFFER = 400

export interface FrameCluster<TBlob = unknown> {
  winner: DetectedFrame<TBlob>
  members: DetectedFrame<TBlob>[]
}

export class FrameCollector<TBlob = unknown> {
  #frames: DetectedFrame<TBlob>[] = []
  readonly #maxBuffer: number

  constructor(maxBuffer: number = DEFAULT_MAX_BUFFER) {
    this.#maxBuffer = maxBuffer
  }

  add(frame: DetectedFrame<TBlob>): void {
    this.#frames.push(frame)
    // Safety valve for very long live-camera sessions. We drop the
    // oldest frames first — they're the least likely to be the "best"
    // of any page still being filmed right now anyway.
    if (this.#frames.length > this.#maxBuffer) {
      this.#frames.splice(0, this.#frames.length - this.#maxBuffer)
    }
  }

  get size(): number {
    return this.#frames.length
  }

  clear(): void {
    this.#frames = []
  }

  /**
   * Cluster all collected frames by 256-bit pHash similarity against
   * per-cluster winner centroids (no transitive chains). Returns one
   * winner per cluster sorted by capture time.
   */
  selectBest(
    threshold: number = DEFAULT_CLUSTER_THRESHOLD,
  ): DetectedFrame<TBlob>[] {
    return this.#cluster(threshold, (a, b) => popcount(a.hash ^ b.hash)).map(
      (c) => c.winner,
    )
  }

  /**
   * Tile-pHash variant of `selectBest`. Uses the 80th-percentile
   * per-tile Hamming distance (`tileDistance`) instead of raw pHash
   * Hamming. Threshold ranges roughly in 4-30 (vs 0-128 for raw pHash).
   * Returns full clusters (winner + members) so a downstream merger
   * (e.g. ORB+RANSAC) can reason over membership.
   */
  selectBestByTile(threshold: number): FrameCluster<TBlob>[] {
    return this.#cluster(threshold, (a, b) => {
      if (!a.tileHash || !b.tileHash) {
        // Fall back to pHash if tileHash is missing on either side
        return popcount(a.hash ^ b.hash)
      }
      return tileDistance(a.tileHash, b.tileHash)
    })
  }

  #cluster(
    threshold: number,
    distFn: (a: DetectedFrame<TBlob>, b: DetectedFrame<TBlob>) => number,
  ): FrameCluster<TBlob>[] {
    const n = this.#frames.length
    if (n === 0) return []
    if (n === 1)
      return [{ winner: this.#frames[0]!, members: [...this.#frames] }]

    // Score-descending so the seed of each cluster is the winner;
    // tie-break by insertion order (Array.sort is stable per ES2019).
    const sorted = [...this.#frames].sort((a, b) => b.score - a.score)

    const clusters: FrameCluster<TBlob>[] = []
    for (const f of sorted) {
      let bestCluster = -1
      let bestDist = Infinity
      for (let c = 0; c < clusters.length; c += 1) {
        const d = distFn(f, clusters[c]!.winner)
        if (d <= threshold && d < bestDist) {
          bestDist = d
          bestCluster = c
        }
      }
      if (bestCluster < 0) {
        clusters.push({ winner: f, members: [f] })
      } else {
        clusters[bestCluster]!.members.push(f)
      }
    }
    clusters.sort((a, b) => a.winner.capturedAt - b.winner.capturedAt)
    return clusters
  }
}
