/**
 * SigLIP-2 image embedding + cosine dedup for cards. EXPERIMENTAL.
 *
 * Status (2026-05-17): NOT wired into the default pipeline. Empirical
 * cosine values on our business-card corpus cluster in 0.85-0.96 with
 * no clear gap between same-card duplicates and merely-similar-looking
 * different cards (all cards share the white-rectangle + text-grid
 * visual structure, which dominates the SigLIP embedding signal).
 * Threshold ≥ 0.97 misses real duplicates; ≤ 0.93 over-merges.
 *
 * Kept as an opt-in module for future revisiting (e.g. paired with
 * fuzzy OCR-text confirm, or for non-card document types where the
 * inter-class visual variation is larger).
 *
 * Default visual dedup remains `visual-dedup.mjs` (pHash, Hamming ≤ 50).
 *
 * Model: `onnx-community/siglip2-base-patch16-224-ONNX` (q4 vision-only
 * subgraph, ~63 MB). Latency on CPU: ~50-100 ms per image embedding.
 */

import process from 'node:process'
import { pipeline, RawImage } from '@huggingface/transformers'
import { fuzzy } from 'fast-fuzzy'
// fast-fuzzy's `fuzzy(term, candidate)` returns a 0..1 score with
// 1 = identical, 0 = nothing in common — equivalent to the "ratio"
// metric used by RapidFuzz / Levenshtein-style libraries.

const MODEL_ID = 'onnx-community/siglip2-base-patch16-224-ONNX'

let _pipe = null

export async function ensureSiglipReady() {
  if (_pipe) return
  // image-feature-extraction with the vision-only subgraph. Pass
  // model_file_name to skip the joint encoder (which would require
  // text input_ids we don't have).
  // dtype 'q4' picks up the q4 quantized file naming convention.
  // model_file_name overrides the base file name to use the vision-only
  // ONNX (the joint model would require text input_ids).
  _pipe = await pipeline('image-feature-extraction', MODEL_ID, {
    dtype: 'q4',
    device: 'cpu',
    model_file_name: 'vision_model',
  })
}

/**
 * Compute a 768-D image embedding from a JPEG/PNG buffer (or data URL).
 * Returns Float32Array of length 768.
 */
export async function embedImageBuffer(jpegBuffer) {
  await ensureSiglipReady()
  const blob = new Blob([jpegBuffer], { type: 'image/jpeg' })
  const image = await RawImage.fromBlob(blob)
  const result = await _pipe(image, { pooling: 'mean', normalize: true })

  // result.data is the flat Float32 buffer. If the tensor was already
  // 1×D (mean-pooled), length should be 768 for SigLIP-2 base. If the
  // shape is 1×seq×D (no pooling actually applied), mean-pool here.
  const data = new Float32Array(result.data)
  let vec
  if (result.dims && result.dims.length === 3 && result.dims[1] > 1) {
    const [, seq, hid] = result.dims
    vec = new Float32Array(hid)
    for (let s = 0; s < seq; s++) {
      for (let h = 0; h < hid; h++) vec[h] += data[s * hid + h]
    }
    for (let h = 0; h < hid; h++) vec[h] /= seq
  } else {
    vec = data
  }
  // L2 normalize regardless (the pipeline's `normalize: true` doesn't
  // always take effect for image-feature-extraction).
  let norm = 0
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(vec.length)
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm
  return out
}

export function cosine(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Dedup a list of candidate items by SigLIP-2 cosine similarity.
 * Items that share an email/phone are pre-merged (canonical-key)
 * upstream; this function targets the residual visual duplicates.
 *
 * @param {Array<{id, warpedBuf:Buffer, score:number, hasContact:boolean, rawText?:string}>} items
 * @param {object} opts
 * @param {number} opts.cosineThreshold default 0.92
 * @param {number} opts.textRatioThreshold default 0.85
 * @returns {Promise<{ winnerIds: string[], droppedMap: Map<string,string> }>}
 */
export async function siglipDedup(items, opts = {}) {
  const cosineThr = opts.cosineThreshold ?? 0.92
  const textThr = opts.textRatioThreshold ?? 0.85

  // Items with contact stay (already canonically deduped). Only no-contact items go through.
  const passthrough = items.filter((it) => it.hasContact)
  const candidates = items.filter((it) => !it.hasContact)
  if (candidates.length <= 1) {
    return {
      winnerIds: items.map((it) => it.id),
      droppedMap: new Map(),
    }
  }

  await ensureSiglipReady()
  // Embed all candidates (and contact-items for cross-check optionality
  // — but here we only embed no-contact items since contact items are
  // protected from merging anyway).
  const embedded = []
  for (const it of candidates) {
    const vec = await embedImageBuffer(it.warpedBuf)
    embedded.push({ ...it, vec })
  }
  // Sort by score descending → high-quality wins ties
  embedded.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  const kept = []
  const droppedMap = new Map()
  for (const cand of embedded) {
    let matched = null
    for (const k of kept) {
      const sim = cosine(k.vec, cand.vec)
      if (sim >= cosineThr) {
        // optional text confirm
        if (cand.rawText && k.rawText) {
          const r = fuzzy(cand.rawText, k.rawText)
          if (r < textThr) continue
        }
        matched = k
        break
      }
    }
    if (matched) {
      droppedMap.set(cand.id, matched.id)
    } else {
      kept.push(cand)
    }
  }

  return {
    winnerIds: [...passthrough.map((p) => p.id), ...kept.map((k) => k.id)],
    droppedMap,
  }
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = process.argv[2] ?? '/IdeaProjects/AstarScan/eval-out/meishi/20260516_005528-fps5-v11/items'
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).sort()
  console.log(`[siglip-dedup smoke] ${files.length} candidates from ${dir}`)
  console.log('[siglip-dedup smoke] loading SigLIP-2 (~150 MB on first call)…')
  await ensureSiglipReady()
  console.log('[siglip-dedup smoke] embedding…')
  const vecs = []
  for (const f of files) {
    const vec = await embedImageBuffer(fs.readFileSync(path.join(dir, f)))
    vecs.push({ name: f, vec })
  }
  console.log('[siglip-dedup smoke] pairs with cosine ≥ 0.85:')
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      const s = cosine(vecs[i].vec, vecs[j].vec)
      if (s >= 0.85) console.log(`  ${vecs[i].name} ↔ ${vecs[j].name}: ${s.toFixed(3)}`)
    }
  }
}
