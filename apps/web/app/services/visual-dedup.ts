/**
 * Visual embedding-based page deduplication (final pass).
 *
 * Uses a SigLIP vision encoder (ONNX, ~55MB q4f16) to extract semantic
 * embeddings for each captured page, then runs agglomerative clustering
 * to merge pages that are visually similar beyond what SSIM can detect.
 *
 * This is a post-processing step — it runs AFTER capture is complete
 * (e.g., when a video ends or the user taps "重複除去"). The model is
 * loaded lazily on first use and cached by the browser.
 *
 * Pipeline proven in Python: SigLIP-384 with cosine threshold 0.15
 * achieved ±1 accuracy on a 21-page eval set across 2 test videos.
 * The browser uses SigLIP-base-224 (smaller, 224px input) at q4f16
 * quantization for browser-feasible size (~55MB).
 */

import { loadOrtSession, canvasToTensor, ort } from './ort-model-loader'

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

/**
 * SigLIP base patch16 224 — vision encoder only, q4f16 quantized.
 * Source: Xenova/siglip-base-patch16-224 on HuggingFace.
 * Embedding dim: 768, input: 224×224, ~55MB.
 */
const MODEL_URL = '/models/siglip-vision-q4f16.onnx'
const INPUT_SIZE = 224
const EMBEDDING_DIM = 768

/** SigLIP normalization: mean=0.5, std=0.5 for all channels */
const NORMALIZE = {
  mean: [0.5, 0.5, 0.5] as const,
  std: [0.5, 0.5, 0.5] as const,
}

/**
 * Cosine distance threshold for merging. Pages with cosine distance
 * below this are considered the same document. Calibrated to 0.15 in
 * the Python eval (SigLIP-384); may need slight adjustment for the
 * 224px base variant.
 */
export const VISUAL_DEDUP_THRESHOLD = 0.15

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let session: ort.InferenceSession | null = null
let loading = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DedupResult = {
  /** Indices of pages to keep (one representative per cluster). */
  keepIndices: number[]
  /** Total clusters found. */
  clusterCount: number
  /** For each input page, its cluster label. */
  labels: number[]
}

/**
 * Check if the visual dedup model is loaded and ready.
 */
export function isVisualDedupReady(): boolean {
  return session !== null
}

/**
 * Load the SigLIP vision encoder. Downloads ~55MB on first call,
 * cached by the browser afterwards. Safe to call multiple times.
 */
export async function initVisualDedup(
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (session || loading) return
  loading = true
  try {
    onProgress?.('SigLIP モデル読み込み中 (~55MB、初回のみ)...')
    session = await loadOrtSession(MODEL_URL)
    onProgress?.('SigLIP モデル準備完了')
  } finally {
    loading = false
  }
}

/**
 * Extract a 768-dim normalized embedding from a page image (data URL).
 */
async function extractEmbedding(dataUrl: string): Promise<Float32Array> {
  if (!session) throw new Error('Visual dedup model not initialized')

  // Load image into a canvas
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('Failed to load image for embedding'))
    el.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  canvas.getContext('2d')?.drawImage(img, 0, 0)

  // Convert to tensor: 1×3×224×224, normalized with mean/std = 0.5
  const tensor = canvasToTensor(canvas, INPUT_SIZE, NORMALIZE)

  // Run inference — SigLIP vision encoder outputs pooled embedding
  const feeds: Record<string, ort.Tensor> = {}
  const inputNames = session.inputNames
  // The input name varies by export: "pixel_values", "input", etc.
  feeds[inputNames[0]!] = tensor

  const results = await session.run(feeds)

  // Get the output — could be "image_embeds", "last_hidden_state", etc.
  const outputNames = session.outputNames
  // Try common output names; fall back to first available
  let outputTensor: ort.Tensor | undefined
  for (const name of [
    'image_embeds',
    'pooler_output',
    'last_hidden_state',
    ...outputNames,
  ]) {
    if (results[name]) {
      outputTensor = results[name]
      break
    }
  }
  if (!outputTensor) throw new Error('No embedding output from model')

  // If we got last_hidden_state (batch × seq × dim), mean-pool over seq
  const data = outputTensor.data as Float32Array
  let embedding: Float32Array
  if (data.length > EMBEDDING_DIM) {
    // Mean pool: average over the sequence dimension
    embedding = new Float32Array(EMBEDDING_DIM)
    const seqLen = data.length / EMBEDDING_DIM
    for (let d = 0; d < EMBEDDING_DIM; d++) {
      let sum = 0
      for (let s = 0; s < seqLen; s++) {
        sum += data[s * EMBEDDING_DIM + d]!
      }
      embedding[d] = sum / seqLen
    }
  } else {
    embedding = new Float32Array(data)
  }

  // L2 normalize
  let norm = 0
  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i]! * embedding[i]!
  }
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i]! /= norm
    }
  }

  return embedding
}

/**
 * Compute cosine distance between two L2-normalized embeddings.
 * Returns a value in [0, 2] where 0 = identical.
 */
function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
  }
  return 1 - dot
}

/**
 * Agglomerative clustering (average linkage) on a precomputed distance
 * matrix. Returns cluster labels for each item.
 *
 * Simple O(n³) implementation — fine for n < 200 pages.
 */
function agglomerativeClustering(
  dist: Float64Array[],
  threshold: number,
): number[] {
  const n = dist.length
  const labels = Array.from({ length: n }, (_, i) => i)

  // Average-linkage: merge closest pair until threshold exceeded
  while (true) {
    const activeClusters = [...new Set(labels)]
    if (activeClusters.length <= 1) break

    let bestDist = Infinity
    let bestA = -1
    let bestB = -1

    // Find closest pair of clusters (average linkage)
    for (let ci = 0; ci < activeClusters.length; ci++) {
      for (let cj = ci + 1; cj < activeClusters.length; cj++) {
        const ca = activeClusters[ci]!
        const cb = activeClusters[cj]!
        let sumDist = 0
        let count = 0
        for (let i = 0; i < n; i++) {
          if (labels[i] !== ca) continue
          for (let j = 0; j < n; j++) {
            if (labels[j] !== cb) continue
            sumDist += dist[i]![j]!
            count++
          }
        }
        const avgDist = sumDist / count
        if (avgDist < bestDist) {
          bestDist = avgDist
          bestA = ca
          bestB = cb
        }
      }
    }

    if (bestDist >= threshold) break

    // Merge bestB into bestA
    for (let i = 0; i < n; i++) {
      if (labels[i] === bestB) labels[i] = bestA
    }
  }

  // Re-label to 0, 1, 2, ...
  const unique = [...new Set(labels)]
  const remap = new Map<number, number>()
  unique.forEach((v, i) => remap.set(v, i))
  return labels.map((l) => remap.get(l)!)
}

/**
 * Run visual dedup on an array of page data URLs.
 *
 * Returns which pages to keep (highest sharpness per cluster) and the
 * cluster assignments.
 *
 * @param pages - Array of { dataUrl, sharpness } for each page.
 * @param threshold - Cosine distance threshold (default 0.15).
 * @param onProgress - Progress callback.
 */
export async function runVisualDedup(
  pages: Array<{ dataUrl: string; sharpness: number }>,
  threshold = VISUAL_DEDUP_THRESHOLD,
  onProgress?: (msg: string) => void,
): Promise<DedupResult> {
  if (!session) {
    await initVisualDedup(onProgress)
  }

  if (pages.length <= 1) {
    return { keepIndices: [0], clusterCount: 1, labels: [0] }
  }

  // Extract embeddings
  onProgress?.(`${pages.length} ページの特徴量を抽出中...`)
  const embeddings: Float32Array[] = []
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(`特徴量抽出: ${i + 1}/${pages.length}`)
    embeddings.push(await extractEmbedding(pages[i]!.dataUrl))
  }

  // Build cosine distance matrix
  onProgress?.('類似度を計算中...')
  const n = embeddings.length
  const dist: Float64Array[] = Array.from(
    { length: n },
    () => new Float64Array(n),
  )
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(embeddings[i]!, embeddings[j]!)
      dist[i]![j] = d
      dist[j]![i] = d
    }
  }

  // Cluster
  onProgress?.('クラスタリング中...')
  const labels = agglomerativeClustering(dist, threshold)
  const clusterCount = new Set(labels).size

  // Pick best representative per cluster (highest sharpness)
  const keepIndices: number[] = []
  for (let cid = 0; cid < clusterCount; cid++) {
    let bestIdx = -1
    let bestSharpness = -1
    for (let i = 0; i < n; i++) {
      if (labels[i] === cid && pages[i]!.sharpness > bestSharpness) {
        bestSharpness = pages[i]!.sharpness
        bestIdx = i
      }
    }
    if (bestIdx >= 0) keepIndices.push(bestIdx)
  }
  keepIndices.sort((a, b) => a - b) // preserve original order

  onProgress?.(
    `${n} ページ → ${clusterCount} ユニークページ (${n - clusterCount} 件の重複を検出)`,
  )

  return { keepIndices, clusterCount, labels }
}

/**
 * Release the ONNX session.
 */
export function disposeVisualDedup(): void {
  session?.release()
  session = null
}
