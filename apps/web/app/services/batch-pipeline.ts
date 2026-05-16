/**
 * Browser-side batch pipeline: video file → unique business cards.
 *
 * Counterpart of `scripts/eval/meishi.mjs` (the Node CLI). Walks a video
 * file at the requested FPS, detects + warps + OCRs each frame, then
 * applies the same identity-tracking + canonical-key dedup as the CLI.
 *
 * Pipeline stages (mirrors the CLI):
 *   1. seek-and-capture the video at fps Hz
 *   2. detectDocument → DocAligner FastViT (or OpenCV Otsu fallback)
 *   3. classifyQuad → mode-specific warp target
 *   4. warpPerspective → canonical card / a4 / receipt size
 *   5. computeLaplacian quality score (re-uses existing scorer)
 *   6. DocTracker → identity per consecutive-frame group
 *   7. per identity winner: ocr-service.runOcr → paragraphs
 *   8. extractHeuristic + extractRuleFields → fields
 *   9. low-signal filter + temporal back/front pair + canonical dedup
 *   10. return BatchItem[]
 *
 * The result is suitable for rendering in `/batch` page (grid of cards
 * + downloadable JSON / zip / PDF).
 */

import type { Quad } from '@astarworks/scan-core'

import { detectDocument } from './doc-detector'
import { warpPerspective } from './perspective-warper'
import { DocTracker, type Track, type TrackInput } from './bytetrack-doc'
import { classifyQuad, type DocumentMode } from './quad-classify'
import {
  extractHeuristic,
  type HeuristicFields,
  type OcrParagraph,
} from './extractor-heuristic'
import {
  clusterByCanonicalKey,
  type DedupCluster,
} from './canonical-dedup'
import { initOcr, runOcr, type OcrResult } from './ocr-service'
import { isLikelyDocument, refineCardEdges } from './post-warp-refine'
import { visualDedup } from './visual-dedup'
import {
  ensureLlmReady,
  extractWithLlm,
  type LlmProgress,
} from './llm-extractor-gemma'

export interface BatchProgress {
  readonly stage:
    | 'frame-extract'
    | 'detect'
    | 'ocr'
    | 'llm-load'
    | 'llm-extract'
    | 'extract'
    | 'dedup'
    | 'done'
  readonly current: number
  readonly total: number
  readonly note?: string
}

export type BatchProgressCallback = (p: BatchProgress) => void

export type ExtractorKind = 'classical' | 'gemma-webgpu'

export interface BatchOptions {
  readonly fps?: number
  readonly minLaplacian?: number
  readonly minConfidence?: number
  readonly mode?: 'auto' | DocumentMode
  readonly extractor?: ExtractorKind
  readonly onProgress?: BatchProgressCallback
  readonly signal?: AbortSignal
}

export interface BatchItem {
  readonly id: string
  readonly mode: DocumentMode
  readonly imageDataUrl: string
  readonly thumbnailDataUrl: string
  readonly width: number
  readonly height: number
  readonly source_ts_ms: number
  readonly source_frame_idx: number
  readonly laplacian: number
  readonly detector_confidence: number
  readonly score: number
  readonly fields: HeuristicFields
  readonly canonical_key: string | null
  readonly dedup_dropped: readonly string[]
  readonly back_raw_text?: string | null
}

interface AcceptedFrame {
  frame_idx: number
  ts_ms: number
  mode: DocumentMode
  quad: Quad
  detector_confidence: number
  aspect: number
  area_fraction: number
  laplacian: number
  score: number
  warpedDataUrl: string
  warpedWidth: number
  warpedHeight: number
}

interface WinnerItem {
  id: string
  mode: DocumentMode
  imageDataUrl: string
  width: number
  height: number
  source_ts_ms: number
  source_frame_idx: number
  laplacian: number
  detector_confidence: number
  score: number
  fields: HeuristicFields
  back_raw_text?: string | null
}

const LOW_SIGNAL_MIN_TEXT = 30
const BACK_MAX_RAW_CHARS = 60
const PAIR_MAX_GAP_MS = 3000

/**
 * Main entry point. Returns a promise that resolves with the deduped
 * BatchItem list when processing finishes (or rejects on abort).
 */
export async function processVideoBatch(
  file: File,
  options: BatchOptions = {},
): Promise<BatchItem[]> {
  const fps = options.fps ?? 5
  const minLap = options.minLaplacian ?? 20
  const minConf = options.minConfidence ?? 0.1
  const requestedMode = options.mode ?? 'auto'
  const extractor = options.extractor ?? 'classical'
  const onProgress = options.onProgress
  const signal = options.signal

  const throwIfAborted = () => {
    if (signal?.aborted) throw new Error('Batch processing aborted')
  }

  if (extractor === 'classical') {
    await initOcr() // pre-load OCR while frame extraction runs
  } else {
    // Pre-load the LLM model upfront so the first per-card call is fast
    onProgress?.({ stage: 'llm-load', current: 0, total: 1, note: 'Gemma 4 E2B 起動中…' })
    await ensureLlmReady((p: LlmProgress) => {
      onProgress?.({
        stage: 'llm-load',
        current: Math.round((p.progress ?? 0) * 100),
        total: 100,
        note: p.file ?? p.note ?? '',
      })
    })
  }

  // ---- Stage 1: open the video, count its frames ----
  const videoUrl = URL.createObjectURL(file)
  let video: HTMLVideoElement | null = null
  try {
    video = await loadVideo(videoUrl)
    const duration = video.duration
    const totalFrames = Math.floor(duration * fps) + 1

    onProgress?.({ stage: 'frame-extract', current: 0, total: totalFrames })

    const workCanvas = document.createElement('canvas')
    workCanvas.width = video.videoWidth
    workCanvas.height = video.videoHeight
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true })
    if (!workCtx) throw new Error('Failed to create 2D context for frame extraction')

    // ---- Stage 2: per-frame detect + warp + quality ----
    const accepted: AcceptedFrame[] = []
    for (let i = 0; i < totalFrames; i++) {
      throwIfAborted()
      const ts_s = i / fps
      await seekVideo(video, Math.min(ts_s, duration))
      workCtx.drawImage(video, 0, 0)

      const det = await detectDocument(workCanvas)
      if (!det || det.confidence < minConf) continue

      const cls = classifyQuad(det.quad, workCanvas.width, workCanvas.height)
      if (cls.mode === 'other' || (requestedMode !== 'auto' && cls.mode !== requestedMode)) continue
      if (!cls.target) continue

      const warpedRaw = warpPerspective(
        workCanvas,
        det.quad,
        cls.target.width,
        cls.target.height,
      )
      // FP filter: reject gray-frame / wood-texture detections
      const fp = isLikelyDocument(warpedRaw)
      if (!fp.ok) continue
      // Edge refinement: trim leftover background strip from outer ~6 %
      const { canvas: warped } = refineCardEdges(warpedRaw)

      const lap = computeLaplacian(warped)
      if (lap < minLap) continue

      const dataUrl = warped.toDataURL('image/jpeg', 0.88)
      accepted.push({
        frame_idx: i,
        ts_ms: Math.round(ts_s * 1000),
        mode: cls.mode,
        quad: det.quad,
        detector_confidence: det.confidence,
        aspect: cls.aspect,
        area_fraction: cls.area_fraction,
        laplacian: lap,
        score: lap * (det.confidence + 0.1) * (cls.area_fraction + 0.1),
        warpedDataUrl: dataUrl,
        warpedWidth: cls.target.width,
        warpedHeight: cls.target.height,
      })

      onProgress?.({
        stage: 'frame-extract',
        current: i + 1,
        total: totalFrames,
        note: `accepted ${accepted.length}`,
      })
    }

    // ---- Stage 3: identity tracking ----
    const tracker = new DocTracker<AcceptedFrame>()
    for (const a of accepted) {
      const input: TrackInput<AcceptedFrame> = {
        frame_idx: a.frame_idx,
        ts_ms: a.ts_ms,
        quad: a.quad,
        mode: a.mode,
        score: a.score,
        payload: a,
      }
      tracker.step(input)
    }
    const tracks: Track<AcceptedFrame>[] = tracker.finalize()

    // ---- Stage 4: per-track winner field extraction ----
    const extractStage = extractor === 'gemma-webgpu' ? 'llm-extract' : 'ocr'
    onProgress?.({ stage: extractStage, current: 0, total: tracks.length })
    const winners: WinnerItem[] = []
    for (let i = 0; i < tracks.length; i++) {
      throwIfAborted()
      const t = tracks[i]!
      const a = t.bestInput.payload

      let fields: ReturnType<typeof extractHeuristic>
      if (extractor === 'gemma-webgpu') {
        try {
          const r = await extractWithLlm(a.warpedDataUrl)
          fields = r.fields
        } catch (err) {
          console.warn('[batch-pipeline] LLM failed for track', t.id, err)
          fields = extractHeuristic([])
        }
      } else {
        let ocrResult: OcrResult | null = null
        try {
          ocrResult = await runOcr(a.warpedDataUrl)
        } catch (err) {
          console.warn('[batch-pipeline] OCR failed for track', t.id, err)
        }
        const paragraphs = ocrResult ? ocrLinesToParagraphs(ocrResult) : []
        fields = extractHeuristic(paragraphs)
      }

      winners.push({
        id: `winner-${String(i).padStart(3, '0')}`,
        mode: a.mode,
        imageDataUrl: a.warpedDataUrl,
        width: a.warpedWidth,
        height: a.warpedHeight,
        source_ts_ms: a.ts_ms,
        source_frame_idx: a.frame_idx,
        laplacian: a.laplacian,
        detector_confidence: a.detector_confidence,
        score: a.score,
        fields,
      })
      onProgress?.({ stage: extractStage, current: i + 1, total: tracks.length })
    }

    // ---- Stage 5: filter + pair + dedup ----
    onProgress?.({ stage: 'dedup', current: 0, total: winners.length })
    const filtered = winners.filter((it) => {
      const f = it.fields
      const hasContact = !!(f.email || f.tel || f.mobile || f.fax)
      const hasIdent = !!(f.name || f.company)
      const txt = (f.raw_text ?? '').replace(/\s+/g, '')
      return hasContact || hasIdent || txt.length >= LOW_SIGNAL_MIN_TEXT
    })

    const sortedByFrame = [...filtered].sort((a, b) => a.source_frame_idx - b.source_frame_idx)
    const mergedBackIds = new Set<string>()
    for (let i = 0; i < sortedByFrame.length - 1; i++) {
      const a = sortedByFrame[i]!
      const b = sortedByFrame[i + 1]!
      if (mergedBackIds.has(a.id) || mergedBackIds.has(b.id)) continue
      const aContact = !!(a.fields.email || a.fields.tel || a.fields.mobile)
      const bContact = !!(b.fields.email || b.fields.tel || b.fields.mobile)
      if (aContact === bContact) continue
      const gap = Math.abs(b.source_ts_ms - a.source_ts_ms)
      if (gap > PAIR_MAX_GAP_MS) continue
      const front = aContact ? a : b
      const back = aContact ? b : a
      const backText = (back.fields.raw_text ?? '').replace(/\s+/g, '')
      if (backText.length > BACK_MAX_RAW_CHARS) continue
      front.back_raw_text = back.fields.raw_text
      mergedBackIds.add(back.id)
    }
    const afterPair = filtered.filter((it) => !mergedBackIds.has(it.id))

    const clusters: DedupCluster[] = clusterByCanonicalKey(
      afterPair.map((it) => ({ id: it.id, fields: it.fields, score: it.score })),
    )
    const winnerToCluster = new Map<string, DedupCluster>()
    for (const c of clusters) {
      for (const id of c.member_ids) winnerToCluster.set(id, c)
    }

    // Visual dedup for items without canonical contact key (catches event
    // cards filmed twice from different angles).
    const visualInputs = afterPair
      .filter((it) => winnerToCluster.get(it.id)?.winner_id === it.id)
      .map((it) => {
        const img = new Image()
        img.src = it.imageDataUrl
        const canvas = document.createElement('canvas')
        canvas.width = it.width
        canvas.height = it.height
        const ctx = canvas.getContext('2d')
        if (ctx) ctx.drawImage(img, 0, 0)
        return {
          id: it.id,
          canvas,
          score: it.score,
          hasContact: !!(it.fields.email || it.fields.tel || it.fields.mobile),
        }
      })
    const vis = visualDedup(visualInputs, 50)
    const visKeep = new Set(vis.winnerIds)

    const final: BatchItem[] = []
    for (const it of afterPair) {
      const c = winnerToCluster.get(it.id)
      if (!c || c.winner_id !== it.id) continue
      if (!visKeep.has(it.id)) continue
      final.push({
        id: it.id,
        mode: it.mode,
        imageDataUrl: it.imageDataUrl,
        thumbnailDataUrl: it.imageDataUrl,
        width: it.width,
        height: it.height,
        source_ts_ms: it.source_ts_ms,
        source_frame_idx: it.source_frame_idx,
        laplacian: it.laplacian,
        detector_confidence: it.detector_confidence,
        score: it.score,
        fields: it.fields,
        canonical_key: c.key,
        dedup_dropped: c.dropped_ids,
        back_raw_text: it.back_raw_text ?? null,
      })
    }
    final.sort((a, b) => a.source_frame_idx - b.source_frame_idx)
    onProgress?.({ stage: 'done', current: final.length, total: final.length })
    return final
  } finally {
    if (video) video.src = ''
    URL.revokeObjectURL(videoUrl)
  }
}

// ---- helpers ----

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    video.onloadedmetadata = () => resolve(video)
    video.onerror = () => reject(new Error('Failed to load video'))
    video.src = url
  })
}

function seekVideo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      resolve()
    }
    const onError = () => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      reject(new Error('Video seek failed'))
    }
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    video.currentTime = t
  })
}

/**
 * Approximate Laplacian variance for blur detection. Uses a simple
 * grayscale 3×3 Laplacian convolution rather than going through OpenCV.js
 * (we want to keep this dependency-light; the value only feeds the
 * relative quality score, not a downstream consumer).
 */
function computeLaplacian(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 0
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  // Convert RGBA to luma into Float32 array
  const luma = new Float32Array(width * height)
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    luma[j] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
  }
  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const v =
        -4 * luma[i]! + luma[i - 1]! + luma[i + 1]! + luma[i - width]! + luma[i + width]!
      sum += v
      sumSq += v * v
      n++
    }
  }
  if (n === 0) return 0
  const mean = sum / n
  return sumSq / n - mean * mean
}

/**
 * Convert NDLOCR-style line output to the paragraph schema our heuristic
 * extractor expects. Lines are grouped vertically into paragraphs only when
 * adjacent lines are very close (gap < line height), otherwise each line
 * becomes its own paragraph.
 */
function ocrLinesToParagraphs(result: OcrResult): OcrParagraph[] {
  // Sort lines top-to-bottom then left-to-right
  const lines = [...result.lines].sort((a, b) => {
    const ay = (a.bbox[1] ?? 0)
    const by = (b.bbox[1] ?? 0)
    if (Math.abs(ay - by) > 10) return ay - by
    return (a.bbox[0] ?? 0) - (b.bbox[0] ?? 0)
  })

  const out: OcrParagraph[] = []
  let order = 0
  for (const ln of lines) {
    const [x, y, w, h] = ln.bbox
    out.push({
      contents: ln.text,
      box: [x, y, x + w, y + h] as const,
      direction: 'horizontal',
      order: order++,
    })
  }
  return out
}
