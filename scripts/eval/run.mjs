#!/usr/bin/env bun
/**
 * Headless eval CLI for the AstarScan video-scan pipeline.
 *
 * Usage:
 *   bun scripts/eval/run.mjs <mp4> [--gt N] [--interval 0.1]
 *                            [--cluster-thr 55] [--min-ten 30]
 *                            [--min-conf 0.1] [--out eval-out/run-001]
 *                            [--keep-frames]
 *
 * Outputs (under --out dir):
 *   frames.jsonl    — one record per sampled frame (idx, t, lap, ten, ...)
 *   winners/        — page-XX.jpg, the winners selectBest picks
 *   summary.json    — params + aggregate metrics + provenance
 *   raw/            — extracted frames (deleted unless --keep-frames)
 */

import process from 'node:process'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  FrameCollector,
  processFrame,
  detectWithOpenCV,
  EXTRACT_W,
  EXTRACT_H,
  clusterAccepted,
  hamming,
  tileDistance,
  mergeClustersByOrb,
  QuadSmoother,
  rawLinkDistance,
} from './pipeline.mjs'
import {
  jpegToCanvas,
  drawQuadsOverlay,
  canvasToJpegBuffer,
  newCanvas,
} from './canvas-utils.mjs'
import { renderSummaryHtml, renderOverlayHtml } from './render-html.mjs'
import { resolveGtManifest, matchWinnersToGt } from './lib/gt-match.mjs'
import {
  clusterBySegments,
  SEGMENT_DEFAULTS,
} from '../../packages/core/src/pipeline/segment-cluster.ts'
import { verifySameText } from '../../packages/core/src/pipeline/text-similarity.ts'
import { computeOrbDescriptors, countOrbMatches } from './pipeline.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    mp4: null,
    gt: null,
    interval: 0.1,
    clusterThr: 55,
    minTen: 30,
    minConf: 0.1,
    out: null,
    keepFrames: false,
    sweep: null, // {param, start, end, step}
    algorithm: 'phash', // 'phash' | 'tile' | 'tile-orb'
    orbMerge: 80, // ORB match-count threshold for cluster merging
    tileMergeMax: Infinity, // dual-criterion: tile-pHash distance ≤ this for ORB merge to apply
    minGridCoverage: 0, // minimum 4×4 grid cells covered by inliers
    detector: 'opencv', // 'opencv' | 'yolo' (corner detection backend)
    model: null, // path to doc-corners.onnx (defaults under public/models when --detector yolo)
    gtMap: null, // page-identity GT manifest (dir or manifest.json path);
    // auto-discovered at test/fixtures/gt/<video-id>/manifest.json when omitted
    smoothQuad: null, // EMA alpha for per-track quad smoothing (e.g. 0.6); off when null
    seg: { ...SEGMENT_DEFAULTS }, // knobs for --algorithm segment
    verify: 'none', // content verifier for segment mode: 'ocr' | 'none'
    // OCR 3-gram Jaccard ≥ this → same page. Measured on labeled mp4-1
    // pairs: same-page 0.249–0.329, different-page 0.000–0.166 (even the
    // near-identical multilingual safety pages separate). 0.20 splits the
    // bands with margin on both sides.
    verifyJaccard: 0.2,
    rescueTen: 10, // candidate floor for the long-gap rescue pass (0 = off)
  }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--gt': args.gt = Number(next()); break
      case '--interval': args.interval = Number(next()); break
      case '--cluster-thr': args.clusterThr = Number(next()); break
      case '--min-ten': args.minTen = Number(next()); break
      case '--min-conf': args.minConf = Number(next()); break
      case '--out': args.out = next(); break
      case '--keep-frames': args.keepFrames = true; break
      case '--sweep': {
        const param = next()
        const range = next() // "start:end:step"
        const [s, e, st] = range.split(':').map(Number)
        args.sweep = { param, start: s, end: e, step: st || 1 }
        break
      }
      case '--algorithm': args.algorithm = next(); break
      case '--orb-merge': args.orbMerge = Number(next()); break
      case '--tile-merge-max': args.tileMergeMax = Number(next()); break
      case '--min-grid': args.minGridCoverage = Number(next()); break
      case '--detector': args.detector = next(); break
      case '--model': args.model = next(); break
      case '--gt-map': args.gtMap = next(); break
      case '--smooth-quad': args.smoothQuad = Number(next()); break
      case '--verify': args.verify = next(); break // 'ocr' | 'none'
      case '--rescue-ten': args.rescueTen = Number(next()); break
      case '--verify-jaccard': args.verifyJaccard = Number(next()); break
      case '--seg-gap': args.seg.maxGapFrames = Number(next()); break
      case '--seg-cut-gap': args.seg.cutGapFrames = Number(next()); break
      case '--seg-cut-orb': args.seg.cutOrbInliers = Number(next()); break
      case '--merge-adj-s': args.seg.adjacentGapS = Number(next()); break
      case '--merge-orb-adj': args.seg.orbAdjacent = Number(next()); break
      case '--merge-orb-dist': args.seg.orbDistant = Number(next()); break
      case '--merge-grid': args.seg.minGrid = Number(next()); break
      case '--merge-tile-lo': args.seg.tileLo = Number(next()); break
      default: rest.push(a)
    }
  }
  if (rest.length !== 1) {
    console.error('Usage: bun scripts/eval/run.mjs <mp4> [--gt N] ...')
    process.exit(2)
  }
  args.mp4 = path.resolve(rest[0])
  if (!args.out) {
    const base = path.basename(args.mp4, path.extname(args.mp4))
    args.out = path.join(REPO_ROOT, 'eval-out', base)
  } else {
    args.out = path.resolve(args.out)
  }
  if (args.detector === 'yolo') {
    args.model = args.model
      ? path.resolve(args.model)
      : path.join(REPO_ROOT, 'apps/web/public/models/doc-corners.onnx')
  }
  return args
}

// ---------------------------------------------------------------------------
// ffmpeg wrapper — extract frames at fixed interval to JPEG
// ---------------------------------------------------------------------------

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

async function extractFrames(mp4, interval, frameDir) {
  await fs.mkdir(frameDir, { recursive: true })
  // fps = 1/interval (e.g. interval 0.1 → fps=10)
  const fps = 1 / interval
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', mp4,
    '-vf', `fps=${fps}`,
    '-q:v', '3',
    path.join(frameDir, 'frame-%05d.jpg'),
  ])
  const entries = (await fs.readdir(frameDir))
    .filter((n) => n.startsWith('frame-') && n.endsWith('.jpg'))
    .sort()
  return entries.map((name, i) => ({
    name,
    path: path.join(frameDir, name),
    idx: i,
    t_s: i * interval,
  }))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log(`[run] mp4=${args.mp4}`)
  console.log(`[run] params: detector=${args.detector} interval=${args.interval} clusterThr=${args.clusterThr} minTen=${args.minTen} minConf=${args.minConf}`)
  console.log(`[run] out=${args.out}`)

  await fs.rm(args.out, { recursive: true, force: true })
  await fs.mkdir(args.out, { recursive: true })
  const winnersDir = path.join(args.out, 'winners')
  const acceptedDir = path.join(args.out, 'accepted')
  const overlayDir = path.join(args.out, 'overlay')
  const rawDir = path.join(args.out, 'raw')
  await fs.mkdir(winnersDir, { recursive: true })
  await fs.mkdir(acceptedDir, { recursive: true })
  await fs.mkdir(overlayDir, { recursive: true })

  console.log('[run] extracting frames...')
  const t0 = Date.now()
  const frames = await extractFrames(args.mp4, args.interval, rawDir)
  console.log(`[run] extracted ${frames.length} frames in ${Date.now() - t0}ms`)

  // Optional YOLOv8-pose detector (Node). Loaded lazily so OpenCV runs
  // don't pay the onnxruntime-node native-module cost.
  let yoloSession = null
  let detectWithYolo = null
  if (args.detector === 'yolo') {
    const mod = await import('./yolo-node.mjs')
    detectWithYolo = mod.detectWithYolo
    try {
      yoloSession = await mod.createYoloSession(args.model)
    } catch (err) {
      console.error(`[run] failed to load YOLO model: ${args.model}`)
      console.error(`[run]   ${err.message}`)
      console.error('[run] train it first (docs/training-doc-corners.md) or pass --model <path>.')
      process.exit(1)
    }
    console.log(`[run] detector=yolo model=${args.model}`)
  }

  const collector = new FrameCollector()
  const traces = []
  const candidateRecords = [] // sub-gate frames eligible for gap rescue

  console.log('[run] processing frames...')
  const t1 = Date.now()
  const acceptedRecords = []
  const smoother = args.smoothQuad != null ? new QuadSmoother(args.smoothQuad) : null
  let prevLink = null
  for (const f of frames) {
    const canvas = await jpegToCanvas(f.path)
    // YOLO mode: precompute the (async) detection; minConf=0 so the
    // collector's confidence gate in processFrame labels low-conf frames.
    // With --smooth-quad we precompute the OpenCV detection too, so the
    // smoother sees every detector's raw quad before the warp.
    let detection =
      args.detector === 'yolo' ? await detectWithYolo(canvas, yoloSession, 0) : undefined
    if (smoother) {
      if (detection === undefined) {
        const q = detectWithOpenCV(canvas)
        detection = q ? { quad: q, confidence: 1.0 } : null
      }
      if (detection?.quad) {
        detection = { ...detection, quad: smoother.apply(detection.quad, f.idx) }
      }
    }
    const trace = processFrame({
      canvas,
      idx: f.idx,
      t_s: f.t_s,
      collector,
      minConfidence: args.minConf,
      minTenengrad: args.minTen,
      detection,
    })
    // Raw-frame link distance vs the previous sampled frame: the page-turn
    // signal that crop jitter can't poison (see rawLinkDistance docs).
    trace.linkDist =
      prevLink && trace.quad && f.idx - prevLink.idx === 1
        ? rawLinkDistance(prevLink.canvas, prevLink.quad, canvas, trace.quad, newCanvas)
        : null
    prevLink = trace.quad ? { idx: f.idx, canvas, quad: trace.quad } : prevLink
    if (trace.accepted) {
      const fname = `frame-${String(f.idx).padStart(5, '0')}.jpg`
      await fs.writeFile(path.join(acceptedDir, fname), trace.warpedBuf)
      // Diagnostic overlay: raw frame + detected quad, so we can see
      // whether the corners track the real paper edge (Stage 0).
      const overlay = drawQuadsOverlay(canvas, [
        { quad: trace.quad, color: '#ff3b30' },
      ])
      await fs.writeFile(
        path.join(overlayDir, fname),
        canvasToJpegBuffer(overlay, 0.8),
      )
      acceptedRecords.push({
        idx: f.idx,
        t_s: f.t_s,
        // Restore the bigint hash (frame trace stores hex for jsonl-friendliness)
        hash: BigInt('0x' + trace.hashHex),
        tileHash: trace.tileHash, // bigint[16]
        score: trace.score,
        lap: trace.lap,
        ten: trace.ten,
        areaFrac: trace.areaFrac,
        confidence: trace.confidence,
      })
    }
    // Rescue candidates: detected + confident but below the blur gate.
    // Their crops are written alongside accepted ones so the segment
    // rescue pass / verifier / winner export can read them by idx.
    // Geometric floors (measured on labeled rescues): every TRUE rescue
    // had conf ≥ 0.52 and areaFrac ≥ 0.12, while the junk picks were a
    // desk-edge sliver (area 0.004) and a half-out-of-frame corner
    // (conf 0.26, area 0.07). Content gates (lap/OCR-length) are NOT
    // usable here — the Lean-Startup cover rescued at lap=2.
    if (
      args.algorithm === 'segment' &&
      args.rescueTen > 0 &&
      !trace.accepted &&
      trace.rejectReason === 'blur-gate' &&
      trace.ten >= args.rescueTen &&
      trace.confidence >= 0.4 &&
      trace.areaFrac >= 0.08 &&
      trace.warped
    ) {
      const fname = `frame-${String(f.idx).padStart(5, '0')}.jpg`
      await fs.writeFile(
        path.join(acceptedDir, fname),
        canvasToJpegBuffer(trace.warped, 0.75),
      )
      candidateRecords.push({
        idx: f.idx,
        t_s: f.t_s,
        hash: BigInt('0x' + trace.hashHex),
        tileHash: trace.tileHash,
        score: trace.score,
        lap: trace.lap,
        ten: trace.ten,
        areaFrac: trace.areaFrac,
        confidence: trace.confidence,
      })
    }
    // Strip Buffer/bigint[]/canvas from trace before logging
    // (jsonl-unfriendly). Keep `quad` (rounded) so corner geometry is
    // inspectable per frame.
    delete trace.warpedBuf
    delete trace.tileHash
    delete trace.warped
    if (trace.quad) {
      const q = trace.quad
      const r = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) })
      trace.quad = { tl: r(q.tl), tr: r(q.tr), br: r(q.br), bl: r(q.bl) }
    }
    traces.push(trace)
    if ((f.idx + 1) % 50 === 0) {
      const det = traces.filter((t) => t.detected).length
      console.log(`  [${f.idx + 1}/${frames.length}] det=${det} buf=${collector.size}`)
    }
  }
  const procMs = Date.now() - t1
  console.log(`[run] processed ${frames.length} frames in ${procMs}ms (avg ${(procMs / frames.length).toFixed(1)}ms/frame)`)

  // ---------------------------------------------------------------------
  // Stage 2 selection — both via the production FrameCollector (winners
  // only) AND a parallel cluster reproduction that captures member
  // membership for diagnostics. The two MUST agree on winner count;
  // any divergence is a harness bug.
  // ---------------------------------------------------------------------
  console.log(`[run] clustering algorithm=${args.algorithm} thr=${args.clusterThr}`)
  const useTile = args.algorithm === 'tile' || args.algorithm === 'tile-orb'
  const algoOpts = useTile
    ? { hashKey: 'tileHash', distanceFn: tileDistance }
    : { hashKey: 'hash', distanceFn: (a, b) => hamming(a, b) }
  const loadAcceptedCanvas = (idx) =>
    jpegToCanvas(path.join(acceptedDir, `frame-${String(idx).padStart(5, '0')}.jpg`))
  let clusters
  let segDebug = null
  if (args.algorithm === 'segment') {
    const t = Date.now()
    // ORB ops are injected — clusterBySegments itself is cv-free in core.
    const hooks = { orb: { computeOrbDescriptors, countOrbMatches } }
    if (args.verify === 'ocr') {
      const { runYomiToku } = await import('./lib/ocr-yomitoku.mjs')
      // Disk-backed OCR cache, keyed by video basename so re-runs with
      // different thresholds don't pay YomiToku's ~30 s model init per
      // image again. Lives next to the eval outputs, gitignored.
      const videoBase = path.basename(args.mp4, path.extname(args.mp4))
      // Detector is part of the key: a different detector yields different
      // crops for the same frame idx. (Warp params don't — same quad,
      // same crop.)
      const ocrCachePath = path.join(
        REPO_ROOT,
        'eval-out',
        `.ocr-cache-${videoBase}-${args.detector}.json`,
      )
      let ocrDisk = {}
      try {
        ocrDisk = JSON.parse(await fs.readFile(ocrCachePath, 'utf8'))
      } catch { /* first run */ }
      const ocrCache = new Map()
      const ocrText = async (idx) => {
        if (ocrDisk[idx] !== undefined) return ocrDisk[idx]
        if (!ocrCache.has(idx)) {
          const p = path.join(acceptedDir, `frame-${String(idx).padStart(5, '0')}.jpg`)
          ocrCache.set(
            idx,
            runYomiToku(p)
              .then((r) => r.raw_text.replace(/\s+/g, ''))
              .catch((err) => {
                console.warn(`[run] OCR failed for idx=${idx}: ${err.message}`)
                return null
              })
              .then(async (text) => {
                ocrDisk[idx] = text
                await fs.writeFile(ocrCachePath, JSON.stringify(ocrDisk))
                return text
              }),
          )
        }
        return ocrCache.get(idx)
      }
      hooks.verifySame = async (aIdx, bIdx, gapS = Infinity) => {
        const [ta, tb] = await Promise.all([ocrText(aIdx), ocrText(bIdx)])
        // Jaccard / containment judgment lives in scan-core
        // (pipeline/text-similarity.ts) — shared with the browser verifier.
        const v = verifySameText(ta, tb, gapS, { jaccardThreshold: args.verifyJaccard })
        if (v == null) return null
        console.log(
          `  [verify-ocr] ${aIdx}↔${bIdx}: jaccard=${v.jaccard.toFixed(3)} containment=${v.containment.toFixed(3)} gap=${gapS.toFixed(1)}s → ${v.same ? 'same' : 'diff'}`,
        )
        return v.same
      }
    }
    const result = await clusterBySegments(
      acceptedRecords,
      loadAcceptedCanvas,
      args.seg,
      hooks,
      candidateRecords,
    )
    clusters = result.clusters
    segDebug = result.debug
    console.log(
      `[run] segment clustering: ${segDebug.segments.length} segments ` +
        `(${segDebug.rescues.length} rescued), ${segDebug.cuts.length} cuts, ` +
        `${segDebug.merges.filter((m) => m.verdict).length} merges → ` +
        `${clusters.length} clusters in ${Date.now() - t}ms`,
    )
    for (const r of segDebug.rescues) {
      console.log(`  rescue idx=${r.idx} t=${r.t_s.toFixed(1)}s ten=${Math.round(r.ten)} score=${r.score.toFixed(3)}`)
    }
    for (const c of segDebug.cuts) {
      console.log(`  cut ${c.a}→${c.b}: phash=${c.phash} gap=${c.gap} orb=${c.orb}`)
    }
    for (const m of segDebug.merges.filter((m) => m.verdict)) {
      console.log(
        `  merge S${m.i + 1}(${m.aIdx}) ↔ S${m.j + 1}(${m.bIdx}): ${m.verdict} tile=${m.tile} orb=${m.orb ?? '-'} grid=${m.grid ?? '-'}`,
      )
    }
    await fs.writeFile(
      path.join(args.out, 'segments.json'),
      JSON.stringify(segDebug, null, 2),
    )
  } else {
    clusters = clusterAccepted(acceptedRecords, args.clusterThr, algoOpts)
  }

  // ORB post-hoc merge: pHash/tile-pHash leave book-cover-style same-page
  // pairs split because their hash distance exceeds the threshold (the
  // distributions overlap with different-page distances). ORB sees actual
  // visual content and reliably gives 80+ matches for same-page pairs vs
  // <30 for different ones.
  let orbMatchCounts = null
  if (args.algorithm === 'tile-orb') {
    console.log(`[run] ORB-merge with threshold ${args.orbMerge}`)
    const t = Date.now()
    const result = await mergeClustersByOrb(
      clusters,
      loadAcceptedCanvas,
      args.orbMerge,
      args.tileMergeMax,
      args.minGridCoverage,
    )
    clusters = result.merged
    orbMatchCounts = result.matchCounts
    console.log(`[run] ORB-merge produced ${clusters.length} clusters in ${Date.now() - t}ms`)
  }
  // Production FrameCollector uses 256-bit pHash always; only run it when
  // the chosen algorithm is the same so we can sanity-check parity.
  let winners
  if (args.algorithm === 'phash') {
    winners = collector.selectBest(args.clusterThr)
    if (winners.length !== clusters.length) {
      console.warn(
        `[run] WARN: harness clustering disagrees — collector=${winners.length} harness=${clusters.length}`,
      )
    }
  } else {
    winners = clusters.map((c) => c.winner)
  }
  if (orbMatchCounts) {
    const passOrb = (mc) => mc.m >= args.orbMerge
    const passTile = (mc) => mc.tileDist <= args.tileMergeMax
    const passGrid = (mc) => mc.gridCoverage >= args.minGridCoverage
    const matched = orbMatchCounts.filter(
      (mc) => passOrb(mc) && passTile(mc) && passGrid(mc),
    )
    const blocked = orbMatchCounts.filter(
      (mc) => passOrb(mc) && !(passTile(mc) && passGrid(mc)),
    )
    console.log(
      `[run] ORB merges: ${matched.length} accepted, ${blocked.length} blocked by tile/grid filter`,
    )
    for (const mc of matched.slice(0, 12)) {
      console.log(
        `  ✓ C${mc.i + 1} ↔ C${mc.j + 1}: orb=${mc.m} tile=${mc.tileDist} grid=${mc.gridCoverage}`,
      )
    }
    for (const mc of blocked.slice(0, 8)) {
      const reason = !passTile(mc) ? 'tile' : 'grid'
      console.log(
        `  ✗ C${mc.i + 1} ↔ C${mc.j + 1}: orb=${mc.m} tile=${mc.tileDist} grid=${mc.gridCoverage} (${reason})`,
      )
    }
  }
  console.log(`[run] ${winners.length} winners selected`)

  // ---------------------------------------------------------------------
  // Page-identity GT matching (temporal-first, ORB cross-check). Auto-
  // discovers test/fixtures/gt/<video-id>/manifest.json unless --gt-map.
  // ---------------------------------------------------------------------
  let gtMatch = null
  const gtManifestPath = await resolveGtManifest({
    gtMapArg: args.gtMap,
    repoRoot: REPO_ROOT,
    mp4Path: args.mp4,
  })
  if (gtManifestPath) {
    console.log(`[run] GT manifest: ${gtManifestPath}`)
    const winnerInputs = winners.map((w) => {
      const idx = w.idx ?? w.capturedAt
      return {
        idx,
        t_s: idx * args.interval,
        jpegPath: path.join(acceptedDir, `frame-${String(idx).padStart(5, '0')}.jpg`),
      }
    })
    gtMatch = await matchWinnersToGt({
      manifestPath: gtManifestPath,
      winners: winnerInputs,
    })
    const m = gtMatch.metrics
    console.log(
      `[run] GT identity: recall=${m.perPageRecall} (${m.matchedPages}/${m.gtPages})` +
        ` dupRate=${m.duplicateRate} (${m.duplicates}) fpRate=${m.falsePositiveRate}` +
        ` (${m.falsePositives}) mergeSuspects=${m.mergeErrors}`,
    )
    if (m.missedPages.length) console.log(`[run]   missed pages: ${m.missedPages.join(', ')}`)
    for (const f of m.flags) console.log(`[run]   flag idx=${f.idx}: ${f.flag}`)
    await fs.writeFile(
      path.join(args.out, 'gt-match.json'),
      JSON.stringify(gtMatch, null, 2),
    )
  } else {
    console.log('[run] no GT manifest found (identity metrics skipped)')
  }

  // ---------------------------------------------------------------------
  // Emit outputs
  // ---------------------------------------------------------------------
  const framesPath = path.join(args.out, 'frames.jsonl')
  const framesLines = traces.map((t) => JSON.stringify(t)).join('\n')
  await fs.writeFile(framesPath, framesLines + '\n')
  console.log(`[run] wrote ${framesPath}`)

  // Write winners. For the tile algorithm, our `winners` are
  // acceptedRecords (no warpedBlob), so we look them up in acceptedDir.
  for (let i = 0; i < winners.length; i += 1) {
    const w = winners[i]
    const outPath = path.join(
      winnersDir,
      `page-${String(i + 1).padStart(2, '0')}.jpg`,
    )
    if (w.warpedBlob) {
      await fs.writeFile(outPath, w.warpedBlob)
    } else {
      // Tile mode: copy from acceptedDir
      const src = path.join(
        acceptedDir,
        `frame-${String(w.idx).padStart(5, '0')}.jpg`,
      )
      await fs.copyFile(src, outPath)
    }
  }
  console.log(`[run] wrote ${winners.length} winner JPEGs to ${winnersDir}`)

  const detected = traces.filter((t) => t.detected).length
  const accepted = traces.filter((t) => t.accepted).length
  // Corner-tightness diagnostic: areaFrac = quad area / frame area. A
  // detector that grabs the whole bright region (page + desk) rather than
  // hugging the page yields high areaFrac. Lower median = tighter to the
  // document; over-coverage = accepted frames with areaFrac ≥ 0.85. This is
  // the headline OpenCV-vs-YOLO comparator for symptom ① (枠ズレ).
  // Consecutive-frame hash stability: distance between temporally adjacent
  // accepted frames (gap ≤ 3 samples ≈ same page, same hold). High medians
  // mean crop jitter is masquerading as content change — the over-split
  // root cause. Track it in every run so smoothing regressions are visible.
  const consecP = []
  const consecT = []
  for (let i = 1; i < acceptedRecords.length; i += 1) {
    const a = acceptedRecords[i - 1]
    const b = acceptedRecords[i]
    if (b.idx - a.idx > 3) continue
    consecP.push(Number(hamming(a.hash, b.hash)))
    consecT.push(Number(tileDistance(a.tileHash, b.tileHash)))
  }
  const pct = (arr, p) => {
    if (!arr.length) return null
    const s = [...arr].sort((x, y) => x - y)
    return s[Math.min(s.length - 1, Math.floor(s.length * p))]
  }
  const consecHash = {
    pairs: consecP.length,
    phash: { p25: pct(consecP, 0.25), median: pct(consecP, 0.5), p75: pct(consecP, 0.75) },
    tile: { p25: pct(consecT, 0.25), median: pct(consecT, 0.5), p75: pct(consecT, 0.75) },
  }

  const areaFracs = acceptedRecords.map((r) => r.areaFrac).sort((a, b) => a - b)
  const medianAreaFrac = areaFracs.length
    ? +areaFracs[Math.floor(areaFracs.length / 2)].toFixed(3)
    : 0
  const overCoverQuads = areaFracs.filter((v) => v >= 0.85).length
  const summary = {
    mp4: args.mp4,
    params: {
      detector: args.detector,
      interval: args.interval,
      algorithm: args.algorithm,
      clusterThr: args.clusterThr,
      minTen: args.minTen,
      minConf: args.minConf,
      smoothQuad: args.smoothQuad,
      seg: args.algorithm === 'segment' ? args.seg : undefined,
      extractW: EXTRACT_W,
      extractH: EXTRACT_H,
    },
    consecHash,
    sampled: frames.length,
    detected,
    accepted,
    medianAreaFrac,
    overCoverQuads,
    overCoverFrac: accepted ? +(overCoverQuads / accepted).toFixed(3) : 0,
    winners: winners.length,
    gt: args.gt,
    recall: args.gt ? Math.min(1, winners.length / args.gt) : null,
    precision: args.gt ? Math.min(1, args.gt / Math.max(1, winners.length)) : null,
    absError: args.gt != null ? Math.abs(winners.length - args.gt) : null,
    // Identity-matched metrics (null until a GT manifest exists for the
    // video). These supersede the count-based recall/precision proxies
    // above, which can be inflated by duplicates masking missed pages.
    gtIdentity: gtMatch ? gtMatch.metrics : null,
    extractMs: Date.now() - t0,
    processMs: procMs,
    provenance: {
      cv: '@techstark/opencv-js@4.12.0',
      canvas: '@napi-rs/canvas',
    },
  }
  const summaryPath = path.join(args.out, 'summary.json')
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2))
  console.log(`[run] wrote ${summaryPath}`)

  // ---------------------------------------------------------------------
  // clusters.jsonl + summary.html
  // ---------------------------------------------------------------------
  // Use the algorithm's own distance for the diagnostics — that's the
  // distance the clustering actually saw.
  const distFn = algoOpts.distanceFn
  const distKey = algoOpts.hashKey
  const clustersPath = path.join(args.out, 'clusters.jsonl')
  const clusterLines = clusters.map((c, ci) => {
    const intras = c.members
      .filter((m) => m.idx !== c.winner.idx)
      .map((m) => Number(distFn(m[distKey], c.winner[distKey])))
    return JSON.stringify({
      cluster: ci + 1,
      winner_idx: c.winner.idx,
      winner_score: c.winner.score,
      member_idxs: c.members.map((m) => m.idx),
      intra_dist: {
        min: intras.length ? Math.min(...intras) : null,
        max: intras.length ? Math.max(...intras) : null,
        mean: intras.length
          ? intras.reduce((s, x) => s + x, 0) / intras.length
          : null,
      },
      inter_winner_dist: clusters.map((c2, cj) =>
        cj === ci ? null : Number(distFn(c.winner[distKey], c2.winner[distKey])),
      ),
    })
  })
  await fs.writeFile(clustersPath, clusterLines.join('\n') + '\n')
  console.log(`[run] wrote ${clustersPath}`)

  const html = renderSummaryHtml({
    mp4: args.mp4,
    params: summary.params,
    summary,
    clusters,
    hammingFn: (a, b) => Number(distFn(a, b)),
    distKey,
    acceptedRelDir: 'accepted',
  })
  const htmlPath = path.join(args.out, 'summary.html')
  await fs.writeFile(htmlPath, html)
  console.log(`[run] wrote ${htmlPath}`)

  // Overlay diagnostic gallery: raw frame + detected quad → warped crop,
  // for inspecting corner-detection accuracy (Stage 0). Winner idxs come
  // from `.idx` (tile modes) or `.capturedAt` (phash collector winners).
  const winnerIds = new Set(winners.map((w) => w.idx ?? w.capturedAt))
  const overlayHtml = renderOverlayHtml({
    mp4: args.mp4,
    accepted: acceptedRecords.map((r) => ({ idx: r.idx, score: r.score })),
    overlayRelDir: 'overlay',
    warpRelDir: 'accepted',
    winnerIds,
  })
  const overlayHtmlPath = path.join(args.out, 'overlay.html')
  await fs.writeFile(overlayHtmlPath, overlayHtml)
  console.log(`[run] wrote ${overlayHtmlPath}`)

  // ---------------------------------------------------------------------
  // Sweep mode (re-cluster the same accepted records at each value;
  // detection / warp / hashing are NOT re-run — that's the whole point)
  // ---------------------------------------------------------------------
  if (args.sweep) {
    const sw = args.sweep
    if (sw.param !== 'cluster-thr') {
      console.warn(`[run] sweep only supports --sweep cluster-thr; got ${sw.param}`)
    } else {
      const rows = []
      rows.push('cluster_thr,n_clusters,gt,abs_error')
      for (let v = sw.start; v <= sw.end; v += sw.step) {
        const c = clusterAccepted(acceptedRecords, v, algoOpts)
        const err = args.gt != null ? Math.abs(c.length - args.gt) : ''
        rows.push(`${v},${c.length},${args.gt ?? ''},${err}`)
      }
      const sweepPath = path.join(args.out, 'sweep.csv')
      await fs.writeFile(sweepPath, rows.join('\n') + '\n')
      console.log(`[run] wrote ${sweepPath}`)
      console.log('[run] sweep:')
      for (const r of rows.slice(1)) console.log('  ' + r)
    }
  }

  console.log('[run] SUMMARY:')
  console.log(`  detector=${args.detector} sampled=${summary.sampled} detected=${summary.detected} accepted=${summary.accepted} winners=${summary.winners}`)
  console.log(`  quad tightness: median areaFrac=${summary.medianAreaFrac}  over-coverage(≥0.85)=${summary.overCoverQuads}/${summary.accepted} (${(summary.overCoverFrac * 100).toFixed(0)}%)`)
  console.log(`  consec-hash: phash median=${consecHash.phash.median} (p25=${consecHash.phash.p25} p75=${consecHash.phash.p75})  tile median=${consecHash.tile.median} over ${consecHash.pairs} pairs`)
  if (args.gt != null) {
    console.log(`  GT=${args.gt} → abs_error=${summary.absError} (recall_proxy=${summary.recall.toFixed(2)}, precision_proxy=${summary.precision.toFixed(2)})`)
  }
  if (gtMatch) {
    const m = gtMatch.metrics
    console.log(
      `  IDENTITY: recall=${m.perPageRecall} dup=${m.duplicateRate} fp=${m.falsePositiveRate} mergeSuspects=${m.mergeErrors} missed=[${m.missedPages.join(',')}]`,
    )
  }

  if (!args.keepFrames) {
    await fs.rm(rawDir, { recursive: true, force: true })
  }

  process.exit(0)
}

main().catch((e) => {
  console.error('[run] FAILED', e)
  process.exit(1)
})
