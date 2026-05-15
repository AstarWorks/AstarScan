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

import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  FrameCollector,
  processFrame,
  EXTRACT_W,
  EXTRACT_H,
  clusterAccepted,
  hamming,
  tileDistance,
  mergeClustersByOrb,
} from './pipeline.mjs'
import { jpegToCanvas } from './canvas-utils.mjs'
import { renderSummaryHtml } from './render-html.mjs'

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
  console.log(`[run] params: interval=${args.interval} clusterThr=${args.clusterThr} minTen=${args.minTen} minConf=${args.minConf}`)
  console.log(`[run] out=${args.out}`)

  await fs.rm(args.out, { recursive: true, force: true })
  await fs.mkdir(args.out, { recursive: true })
  const winnersDir = path.join(args.out, 'winners')
  const acceptedDir = path.join(args.out, 'accepted')
  const rawDir = path.join(args.out, 'raw')
  await fs.mkdir(winnersDir, { recursive: true })
  await fs.mkdir(acceptedDir, { recursive: true })

  console.log('[run] extracting frames...')
  const t0 = Date.now()
  const frames = await extractFrames(args.mp4, args.interval, rawDir)
  console.log(`[run] extracted ${frames.length} frames in ${Date.now() - t0}ms`)

  const collector = new FrameCollector()
  const traces = []

  console.log('[run] processing frames...')
  const t1 = Date.now()
  const acceptedRecords = []
  for (const f of frames) {
    const canvas = await jpegToCanvas(f.path)
    const trace = processFrame({
      canvas,
      idx: f.idx,
      t_s: f.t_s,
      collector,
      minConfidence: args.minConf,
      minTenengrad: args.minTen,
    })
    if (trace.accepted) {
      const fname = `frame-${String(f.idx).padStart(5, '0')}.jpg`
      await fs.writeFile(path.join(acceptedDir, fname), trace.warpedBuf)
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
    // Strip Buffer/bigint[] from trace before logging (jsonl-unfriendly).
    delete trace.warpedBuf
    delete trace.quad
    delete trace.tileHash
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
  let clusters = clusterAccepted(acceptedRecords, args.clusterThr, algoOpts)

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
      async (idx) =>
        jpegToCanvas(
          path.join(acceptedDir, `frame-${String(idx).padStart(5, '0')}.jpg`),
        ),
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
  const summary = {
    mp4: args.mp4,
    params: {
      interval: args.interval,
      algorithm: args.algorithm,
      clusterThr: args.clusterThr,
      minTen: args.minTen,
      minConf: args.minConf,
      extractW: EXTRACT_W,
      extractH: EXTRACT_H,
    },
    sampled: frames.length,
    detected,
    accepted,
    winners: winners.length,
    gt: args.gt,
    recall: args.gt ? Math.min(1, winners.length / args.gt) : null,
    precision: args.gt ? Math.min(1, args.gt / Math.max(1, winners.length)) : null,
    absError: args.gt != null ? Math.abs(winners.length - args.gt) : null,
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
  console.log(`  sampled=${summary.sampled} detected=${summary.detected} accepted=${summary.accepted} winners=${summary.winners}`)
  if (args.gt != null) {
    console.log(`  GT=${args.gt} → abs_error=${summary.absError} (recall_proxy=${summary.recall.toFixed(2)}, precision_proxy=${summary.precision.toFixed(2)})`)
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
