#!/usr/bin/env bun
/**
 * meishi.mjs — Video → unique business cards / documents pipeline.
 *
 * Pipeline:
 *   1. ffmpeg → frames at --fps (default 5)
 *   2. per frame: DocAligner (LCNet100) detect → quad-classify
 *      → quality (Laplacian) → warpPerspective (mode-specific target)
 *   3. ByteTrack-style tracker: assign track_id to consecutive same-document frames
 *   4. per track, pick best frame by score; warp + save to items/<mode>-NN.jpg
 *   5. batch OCR with YomiToku → paragraphs[] per image
 *   6. extractor-heuristic + extractor-rule → fields per item
 *   7. canonical-key dedup → merge same physical card across tracks
 *   8. emit items.json + items/*.jpg + summary.html
 *
 * Usage:
 *   bun scripts/eval/meishi.mjs <mp4> [--fps 5] [--out eval-out/meishi/<basename>]
 *                                     [--detector lcnet100|fastvit_t8]
 *                                     [--mode auto|card|a4|receipt]
 *                                     [--min-laplacian 50] [--min-confidence 0.1]
 *                                     [--keep-frames]
 */

import process from 'node:process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { computeLaplacian } from './pipeline.mjs'
import { rotateAndCropQuad } from './lib/rotate-crop.mjs'
import { jpegToCanvas, canvasToJpegBuffer } from './canvas-utils.mjs'
import { DocAlignerNodeBackend } from './lib/docaligner-node.mjs'
import { classifyQuad } from './lib/quad-classify.mjs'
import { DocTracker } from './lib/bytetrack-doc.mjs'
import { runYomiTokuBatch } from './lib/ocr-yomitoku.mjs'
import { extractHeuristic } from './lib/extractor-heuristic.mjs'
import { clusterByCanonicalKey } from './lib/canonical-dedup.mjs'
import { isLikelyDocument, refineCardEdges } from './lib/post-warp-refine.mjs'
import { visualDedup } from './lib/visual-dedup.mjs'
import { scoreFrame } from './lib/frame-quality.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

// ---- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    mp4: null,
    fps: 5,
    out: null,
    detector: 'lcnet100',
    mode: 'auto',
    minLaplacian: 10,
    minConfidence: 0.1,
    keepFrames: false,
    frameQuality: false,    // Phase 2d-A2: opt-in. Default = single-best frame.
    permissive: false,      // Phase 2d-D: relax all gates, expect LLM dedup.
  }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--fps': args.fps = Number(next()); break
      case '--out': args.out = next(); break
      case '--detector': args.detector = next(); break
      case '--mode': args.mode = next(); break
      case '--min-laplacian': args.minLaplacian = Number(next()); break
      case '--min-confidence': args.minConfidence = Number(next()); break
      case '--keep-frames': args.keepFrames = true; break
      case '--frame-quality': args.frameQuality = true; break
      case '--permissive':
        args.permissive = true
        args.minLaplacian = Math.min(args.minLaplacian, 5)
        break
      default: rest.push(a)
    }
  }
  if (rest.length !== 1) {
    console.error('Usage: bun scripts/eval/meishi.mjs <mp4> [--fps 5] [--out DIR] ...')
    process.exit(2)
  }
  args.mp4 = path.resolve(rest[0])
  if (!args.out) {
    const base = path.basename(args.mp4, path.extname(args.mp4))
    args.out = path.join(REPO_ROOT, 'eval-out', 'meishi', base)
  } else {
    args.out = path.resolve(args.out)
  }
  return args
}

// ---- ffmpeg ----------------------------------------------------------------

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (b) => { err += b.toString() })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-500)}`))
    })
  })
}

async function extractFrames(mp4, fps, frameDir) {
  await fsp.mkdir(frameDir, { recursive: true })
  await runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', mp4, '-vf', `fps=${fps}`, '-q:v', '3',
    path.join(frameDir, 'frame-%05d.jpg'),
  ])
  const entries = (await fsp.readdir(frameDir))
    .filter((n) => n.startsWith('frame-') && n.endsWith('.jpg'))
    .sort()
  return entries.map((name, i) => ({
    name,
    path: path.join(frameDir, name),
    idx: i,
    ts_ms: Math.round((i / fps) * 1000),
  }))
}

// ---- main ------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(`[meishi] mp4=${args.mp4}`)
  console.log(`[meishi] out=${args.out}`)
  console.log(`[meishi] fps=${args.fps} detector=${args.detector} mode=${args.mode}`)

  await fsp.rm(args.out, { recursive: true, force: true })
  await fsp.mkdir(args.out, { recursive: true })
  const itemsDir = path.join(args.out, 'items')
  const framesDir = path.join(args.out, 'frames')
  const winnersDir = path.join(args.out, 'winners')
  const rejectedDir = path.join(args.out, 'frames-rejected')
  await fsp.mkdir(itemsDir, { recursive: true })
  await fsp.mkdir(framesDir, { recursive: true })
  await fsp.mkdir(winnersDir, { recursive: true })
  await fsp.mkdir(rejectedDir, { recursive: true })

  // ---- Stage 1: frame extraction ----
  console.log('[meishi] extracting frames…')
  const tExtract = Date.now()
  const frames = await extractFrames(args.mp4, args.fps, framesDir)
  console.log(`[meishi] ${frames.length} frames in ${Date.now() - tExtract} ms`)

  // ---- Stage 2: detect + classify + quality-score per frame ----
  const detector = new DocAlignerNodeBackend(args.detector)
  await detector.warmUp()
  console.log('[meishi] detector ready')

  const tDetect = Date.now()
  const accepted = []
  let frameDetCount = 0
  let frameDropOther = 0
  let frameDropBlur = 0
  let frameDropFp = 0
  for (const f of frames) {
    const canvas = await jpegToCanvas(f.path)
    const det = await detector.detect(canvas)
    if (!det || det.confidence < args.minConfidence) continue
    frameDetCount++
    const cls = classifyQuad(det.quad, canvas.width, canvas.height)
    if (cls.mode === 'other' || (args.mode !== 'auto' && cls.mode !== args.mode)) {
      frameDropOther++
      continue
    }
    // Rotate-then-bbox crop (no perspective warp). Preserves the card's
    // actual aspect EXACTLY and avoids the stretch artifacts that
    // warpPerspective introduced. long side = mode's TARGET_BASE_LONG so
    // downstream sizing stays consistent for visual layout.
    const longSide = Math.max(cls.target.width, cls.target.height)
    const warpedRaw = rotateAndCropQuad(canvas, det.quad, longSide, 0.05)

    // FP filter: reject obvious non-documents (gray frames, wood texture).
    const fp = isLikelyDocument(warpedRaw)
    if (!fp.ok) {
      frameDropFp++
      continue
    }

    // Edge refinement: trim residual background pixels from outer ~5 %.
    const { canvas: warped, inset } = refineCardEdges(warpedRaw)

    const lap = computeLaplacian(warped)
    if (lap < args.minLaplacian) {
      frameDropBlur++
      continue
    }
    accepted.push({
      frame_idx: f.idx,
      ts_ms: f.ts_ms,
      mode: cls.mode,
      quad: det.quad,
      detector_confidence: det.confidence,
      aspect: cls.aspect,
      area_fraction: cls.area_fraction,
      laplacian: lap,
      score: lap * (det.confidence + 0.1) * (cls.area_fraction + 0.1),
      target: cls.target,
      warpedBuf: canvasToJpegBuffer(warped, 88),
      refine_inset: inset,
      content_variance: fp.variance,
      content_edge_density: fp.edgeDensity,
    })
    if (frames.length > 50 && (f.idx + 1) % 50 === 0) {
      console.log(`  [${f.idx + 1}/${frames.length}] det=${frameDetCount} accepted=${accepted.length}`)
    }
  }
  console.log(`[meishi] detect: ${frames.length} frames → ` +
    `det=${frameDetCount} accepted=${accepted.length} ` +
    `(drop-other=${frameDropOther} drop-fp=${frameDropFp} drop-blur=${frameDropBlur}) ` +
    `in ${Date.now() - tDetect} ms`)

  // ---- Stage 3: ByteTrack-style identity tracker ----
  const tracker = new DocTracker()
  for (const r of accepted) tracker.step(r)
  const TOPK = args.frameQuality ? 3 : 1
  const tracks = tracker.finalize(TOPK)
  if (args.frameQuality) {
    const totalCandidates = tracks.reduce((s, t) => s + (t.topKItems?.length ?? 1), 0)
    console.log(`[meishi] tracker → ${tracks.length} tracks, ${totalCandidates} candidates (top-${TOPK}, --frame-quality)`)
  } else {
    console.log(`[meishi] tracker → ${tracks.length} tracks`)
  }

  // ---- Stage 4: persist winner images + batch OCR ----
  let winners
  let ocrMap
  if (args.frameQuality) {
    // Top-K candidates: OCR each, then re-pick by frame-quality scorer.
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const cands = t.topKItems ?? [t.bestItem]
      for (let k = 0; k < cands.length; k++) {
        const filename = `track-${String(i).padStart(3, '0')}-cand-${k}.jpg`
        await fsp.writeFile(path.join(winnersDir, filename), cands[k].warpedBuf)
      }
    }
    const tOcr = Date.now()
    console.log('[meishi] running YomiToku batch (top-K candidates)…')
    ocrMap = await runYomiTokuBatch(winnersDir)
    console.log(`[meishi] OCR ${ocrMap.size} candidates in ${Date.now() - tOcr} ms`)

    winners = []
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const cands = t.topKItems ?? [t.bestItem]
      let bestK = 0
      let bestQScore = -Infinity
      let bestOcr = null
      for (let k = 0; k < cands.length; k++) {
        const candStem = `track-${String(i).padStart(3, '0')}-cand-${k}`
        const ocr = ocrMap.get(candStem)
        if (!ocr) continue
        const candCanvas = await jpegToCanvas(cands[k].warpedBuf)
        const q = scoreFrame({
          canvas: candCanvas,
          paragraphs: ocr.paragraphs,
          areaFraction: cands[k].area_fraction,
        })
        if (q.score > bestQScore) {
          bestQScore = q.score
          bestK = k
          bestOcr = ocr
        }
      }
      const chosen = cands[bestK]
      const stem = `winner-${String(i).padStart(3, '0')}`
      const filename = `${stem}.jpg`
      await fsp.writeFile(path.join(winnersDir, filename), chosen.warpedBuf)
      winners.push({
        stem,
        filename,
        ...t,
        bestItem: chosen,
        cached_ocr: bestOcr,
        quality_score: bestQScore,
        picked_k: bestK,
      })
    }
    console.log(`[meishi] frame-quality picked winners (top-K re-scored)`)
  } else {
    // Default: single bestItem per track (score-based picker, fast).
    winners = []
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]
      const stem = `winner-${String(i).padStart(3, '0')}`
      const filename = `${stem}.jpg`
      await fsp.writeFile(path.join(winnersDir, filename), t.bestItem.warpedBuf)
      winners.push({ stem, filename, ...t })
    }
    console.log(`[meishi] wrote ${winners.length} winner images`)
    const tOcr = Date.now()
    console.log('[meishi] running YomiToku batch…')
    ocrMap = await runYomiTokuBatch(winnersDir)
    console.log(`[meishi] OCR ${ocrMap.size}/${winners.length} in ${Date.now() - tOcr} ms`)
  }

  // ---- Stage 6: heuristic field extraction per winner ----
  // Re-use the cached OCR from Stage 4c (avoids a second YomiToku pass).
  const items = []
  for (let i = 0; i < winners.length; i++) {
    const w = winners[i]
    const ocr = w.cached_ocr ?? ocrMap.get(w.stem)
    if (!ocr) {
      console.warn(`[meishi] no OCR for ${w.stem}`)
      items.push({
        id: w.stem,
        mode: w.mode,
        filename: w.filename,
        source_frame_idx: w.bestItem.frame_idx,
        source_ts_ms: w.bestItem.ts_ms,
        laplacian: w.bestItem.laplacian,
        detector_confidence: w.bestItem.detector_confidence,
        score: w.bestItem.score,
        fields: { confidence: 0, raw_text: null },
      })
      continue
    }
    const fields = extractHeuristic(ocr.paragraphs)
    items.push({
      id: w.stem,
      mode: w.mode,
      filename: w.filename,
      source_frame_idx: w.bestItem.frame_idx,
      source_ts_ms: w.bestItem.ts_ms,
      laplacian: w.bestItem.laplacian,
      detector_confidence: w.bestItem.detector_confidence,
      score: w.bestItem.score,
      ocr_paragraphs: ocr.paragraphs,
      ocr_figures: ocr.figures,
      fields,
    })
  }

  // ---- Stage 6b: drop low-signal items (gray frames only) ----
  // Keep ANY item that has either: (a) a contact field, (b) ≥30 chars of
  // OCR text, OR (c) a name OR company extracted (heuristic at least found
  // something meaningful). The previous 50-char-no-contact bar was killing
  // legitimate cards where YomiToku struggled with low-contrast text (e.g.
  // winner-021 中根徹也 returned 0 paragraphs entirely).
  const beforeFilter = items.length
  // Phase 2d-A1: 30→10 char floor. Permissive mode skips the filter entirely.
  const minRawTextLen = args.permissive ? 0 : 10
  const filtered = args.permissive
    ? items
    : items.filter((it) => {
        const f = it.fields
        const hasContact = !!(f.email || f.tel || f.mobile || f.fax)
        const hasIdent = !!(f.name || f.company)
        const txt = (f.raw_text ?? '').replace(/\s+/g, '')
        if (hasContact) return true
        if (hasIdent) return true
        if (txt.length >= minRawTextLen) return true
        return false
      })
  console.log(`[meishi] filter: ${beforeFilter} → ${filtered.length} (dropped ${beforeFilter - filtered.length} low-signal${args.permissive ? '; permissive=skip' : ''})`)

  // ---- Stage 6c: temporal back/front pairing ----
  // Pair two adjacent winners only when the "back" side has VERY little
  // text (likely just a slogan / QR / illustration), the "front" has
  // contact info, and they are within 3 seconds of each other. Previously
  // we paired anything-no-contact with anything-with-contact, which
  // collapsed legitimate weak-OCR cards (e.g. 中根徹也) onto neighboring
  // cards as fake "back sides".
  const sortedByFrame = [...filtered].sort((a, b) => a.source_frame_idx - b.source_frame_idx)
  const mergedBackIds = new Set()
  const BACK_MAX_RAW_CHARS = 60
  const PAIR_MAX_GAP_MS = 3000
  for (let i = 0; i < sortedByFrame.length - 1; i++) {
    const a = sortedByFrame[i]
    const b = sortedByFrame[i + 1]
    if (mergedBackIds.has(a.id) || mergedBackIds.has(b.id)) continue
    const aContact = !!(a.fields.email || a.fields.tel || a.fields.mobile)
    const bContact = !!(b.fields.email || b.fields.tel || b.fields.mobile)
    if (aContact === bContact) continue            // need exactly one with contact
    const gap = Math.abs(b.source_ts_ms - a.source_ts_ms)
    if (gap > PAIR_MAX_GAP_MS) continue
    const front = aContact ? a : b
    const back = aContact ? b : a
    const backText = (back.fields.raw_text ?? '').replace(/\s+/g, '')
    if (backText.length > BACK_MAX_RAW_CHARS) continue // too much text → real card
    front.back_raw_text = back.fields.raw_text
    front.back_item_id = back.id
    mergedBackIds.add(back.id)
  }
  const afterPairing = filtered.filter((it) => !mergedBackIds.has(it.id))
  console.log(`[meishi] back/front pair: merged ${mergedBackIds.size} back-side items`)

  // ---- Stage 7: canonical-key dedup across remaining items ----
  const clusters = clusterByCanonicalKey(afterPairing.map((it) => ({
    id: it.id, fields: it.fields, score: it.score,
  })))
  // Re-key items by cluster: winner keeps the original, others marked as merged.
  const idToCluster = new Map()
  for (const c of clusters) {
    for (const m of c.member_ids) idToCluster.set(m, c)
  }
  let finalItems = []
  for (const it of afterPairing) {
    const c = idToCluster.get(it.id)
    if (!c || c.winner_id !== it.id) continue
    const dropped = c.dropped_ids.length
      ? afterPairing.filter((x) => c.dropped_ids.includes(x.id))
      : []
    finalItems.push({
      ...it,
      canonical_key: c.key,
      dedup_dropped: c.dropped_ids,
      dedup_dropped_info: dropped.map((d) => ({
        id: d.id,
        source_frame_idx: d.source_frame_idx,
        fields: { name: d.fields.name, email: d.fields.email, mobile: d.fields.mobile, tel: d.fields.tel },
      })),
    })
  }

  // ---- Stage 7b: visual dedup for no-contact items (pHash) ----
  // Catches the case where the same physical event card / slogan back is
  // filmed twice from different angles. Both surface as separate winners
  // because they have no contact, so canonical-key dedup can't merge them.
  const idToWinnerBuf = new Map()
  for (const w of winners) {
    idToWinnerBuf.set(w.stem, w.bestItem.warpedBuf)
  }
  const visualResult = await visualDedup(
    finalItems.map((it) => ({
      id: it.id,
      warpedBuf: idToWinnerBuf.get(it.id),
      score: it.score,
      hasContact: !!(it.fields.email || it.fields.tel || it.fields.mobile),
    })),
    50,
  )
  const visualKeepSet = new Set(visualResult.winnerIds)
  const visualDroppedCount = finalItems.length - visualKeepSet.size
  // Attribute dropped ids to their visual-winner
  for (const it of finalItems) {
    if (visualKeepSet.has(it.id)) continue
    const winnerId = visualResult.droppedIds.get(it.id)
    const winner = finalItems.find((x) => x.id === winnerId)
    if (winner) {
      winner.dedup_dropped = [...winner.dedup_dropped, it.id]
    }
  }
  finalItems = finalItems.filter((it) => visualKeepSet.has(it.id))
  console.log(`[meishi] visual dedup: dropped ${visualDroppedCount} near-duplicate item(s)`)

  // Rename final winners to item-XX.<mode>.jpg in items/ for clarity.
  const sorted = finalItems.sort((a, b) => a.source_frame_idx - b.source_frame_idx)
  for (let i = 0; i < sorted.length; i++) {
    const it = sorted[i]
    const newName = `${it.mode}-${String(i + 1).padStart(2, '0')}.jpg`
    await fsp.copyFile(path.join(winnersDir, it.filename), path.join(itemsDir, newName))
    it.image = `items/${newName}`
  }

  // ---- Stage 8: write items.json + summary.html ----
  const summary = {
    args: {
      mp4: args.mp4,
      fps: args.fps,
      detector: args.detector,
      mode: args.mode,
      min_laplacian: args.minLaplacian,
      min_confidence: args.minConfidence,
    },
    counts: {
      frames_total: frames.length,
      frames_detected: frameDetCount,
      frames_accepted: accepted.length,
      tracks: tracks.length,
      ocr_succeeded: ocrMap.size,
      pre_filter_items: items.length,
      after_low_signal_filter: filtered.length,
      after_temporal_pairing: afterPairing.length,
      final_items: sorted.length,
    },
    items: sorted.map((it) => ({
      id: it.id,
      mode: it.mode,
      image: it.image,
      source_frame_idx: it.source_frame_idx,
      source_ts_ms: it.source_ts_ms,
      laplacian: Math.round(it.laplacian),
      detector_confidence: Number(it.detector_confidence.toFixed(3)),
      canonical_key: it.canonical_key,
      dedup_dropped: it.dedup_dropped,
      fields: it.fields,
    })),
  }
  await fsp.writeFile(
    path.join(args.out, 'items.json'),
    JSON.stringify(summary, null, 2),
  )
  await fsp.writeFile(
    path.join(args.out, 'summary.html'),
    renderMeishiHtml(summary),
  )

  if (!args.keepFrames) {
    await fsp.rm(framesDir, { recursive: true, force: true })
    await fsp.rm(winnersDir, { recursive: true, force: true })
    await fsp.rm(rejectedDir, { recursive: true, force: true })
  }

  console.log()
  console.log(`[meishi] ★ DONE — ${sorted.length} unique item(s) extracted`)
  console.log(`[meishi] open ${path.join(args.out, 'summary.html')} for review`)
  for (const it of sorted) {
    const f = it.fields
    const tag = `[${it.mode}]`
    const ident = `${f.name ?? '?'} / ${f.company ?? '?'}`
    const contact = [f.mobile, f.tel, f.email].filter(Boolean).join(' | ')
    console.log(`  ${tag} ${ident}  →  ${contact}`)
  }
}

// ---- summary.html renderer -------------------------------------------------

function renderMeishiHtml(s) {
  const cards = s.items.map((it) => {
    const f = it.fields
    const fieldsHtml = Object.entries({
      name: f.name, name_kana: f.name_kana,
      company: f.company, department: f.department, title: f.title,
      postal: f.postal, address: f.address,
      tel: f.tel, fax: f.fax, mobile: f.mobile,
      email: f.email, url: f.url,
    })
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<tr><th>${k}</th><td>${escape(String(v))}</td></tr>`)
      .join('\n')
    return `
<section class="item">
  <header>
    <h2>${it.id} <span class="mode mode-${it.mode}">${it.mode}</span></h2>
    <small>frame=${it.source_frame_idx} t=${(it.source_ts_ms / 1000).toFixed(1)}s
      lap=${it.laplacian} conf=${it.detector_confidence}
      ${it.dedup_dropped.length ? `merged=${it.dedup_dropped.length}` : ''}</small>
  </header>
  <div class="row">
    <img src="${it.image}" alt="${it.id}" loading="lazy"/>
    <table>${fieldsHtml}</table>
  </div>
  ${f.raw_text ? `<details><summary>raw OCR text</summary><pre>${escape(f.raw_text)}</pre></details>` : ''}
</section>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>meishi — ${escape(path.basename(s.args.mp4))}</title>
<style>
body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 24px; background: #f7f7f8; }
h1 { font-size: 1.4rem; }
.summary { background: white; padding: 16px; border-radius: 8px; margin-bottom: 16px; }
.summary table { border-collapse: collapse; }
.summary td, .summary th { padding: 4px 12px; }
.item { background: white; padding: 16px; border-radius: 8px; margin-bottom: 16px; }
.item header { display: flex; justify-content: space-between; align-items: baseline; }
.item header h2 { margin: 0; font-size: 1.05rem; }
.item .row { display: flex; gap: 16px; margin-top: 8px; }
.item img { max-width: 480px; max-height: 320px; border: 1px solid #ddd; object-fit: contain; background: #fafafa; }
.item table { border-collapse: collapse; font-size: 0.9rem; }
.item th { text-align: left; padding: 2px 12px 2px 0; color: #666; font-weight: 500; vertical-align: top; }
.item td { padding: 2px 0; }
.mode { font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; background: #eee; color: #444; }
.mode-card { background: #e8f4ff; color: #2563eb; }
.mode-a4 { background: #fff4e6; color: #b45309; }
.mode-receipt { background: #f0fdf4; color: #15803d; }
small { color: #888; }
details { margin-top: 8px; }
details pre { background: #fafafa; padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; }
</style>
</head>
<body>
<h1>meishi — ${escape(path.basename(s.args.mp4))}</h1>
<div class="summary">
  <table>
    <tr><th>frames total</th><td>${s.counts.frames_total}</td></tr>
    <tr><th>frames detected</th><td>${s.counts.frames_detected}</td></tr>
    <tr><th>frames accepted</th><td>${s.counts.frames_accepted}</td></tr>
    <tr><th>tracker identities</th><td>${s.counts.tracks}</td></tr>
    <tr><th>OCR succeeded</th><td>${s.counts.ocr_succeeded}</td></tr>
    <tr><th>pre-dedup items</th><td>${s.counts.pre_dedup_items}</td></tr>
    <tr><th>final unique items</th><td><strong>${s.counts.final_items}</strong></td></tr>
  </table>
</div>
${cards}
</body>
</html>`
}

function escape(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
