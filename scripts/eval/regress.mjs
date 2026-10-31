#!/usr/bin/env bun
/**
 * Regression gate over the eval videos with page-identity ground truth.
 *
 * Runs `run.mjs` with the FROZEN production parameter set on every video
 * that has a GT manifest under test/fixtures/gt/, then compares the
 * identity metrics against the committed baselines in test/baselines/.
 *
 *   bun scripts/eval/regress.mjs                  # compare, exit 1 on regression
 *   bun scripts/eval/regress.mjs --update-baselines
 *   bun scripts/eval/regress.mjs --only 20260412_204840
 *
 * Failure rules (vs baseline):
 *   - perPageRecall dropped
 *   - duplicates increased
 *   - falsePositives increased
 *   - mergeErrors increased
 * Winner-frame churn (different idx, same page) is NOT a failure — ORB
 * RANSAC is randomized and scores tie closely.
 *
 * CI never updates baselines; run --update-baselines locally and review
 * the diff like any code change.
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const GT_DIR = path.join(REPO_ROOT, 'test/fixtures/gt')
const BASELINE_DIR = path.join(REPO_ROOT, 'test/baselines')

/** The frozen production parameter set. Changing these REQUIRES a
 *  conscious baseline regeneration (the diff shows up in review). */
export const PROD_PARAMS = [
  '--detector', 'yolo',
  '--algorithm', 'segment',
  '--min-conf', '0.25',
  '--verify', 'ocr',
]

const args = process.argv.slice(2)
const update = args.includes('--update-baselines')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null

const videos = []
for (const entry of await fs.readdir(GT_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  if (only && entry.name !== only) continue
  const manifest = JSON.parse(
    await fs.readFile(path.join(GT_DIR, entry.name, 'manifest.json'), 'utf8'),
  )
  const mp4 = path.join(REPO_ROOT, manifest.video)
  try {
    await fs.access(mp4)
    videos.push({ id: entry.name, mp4 })
  } catch {
    console.warn(`[regress] SKIP ${entry.name}: ${manifest.video} not present`)
  }
}
if (!videos.length) {
  console.error('[regress] no GT-covered videos found')
  process.exit(2)
}

function runEval(video) {
  const out = path.join(REPO_ROOT, 'eval-out', `regress-${video.id}`)
  return new Promise((resolve, reject) => {
    const p = spawn(
      'bun',
      [path.join(__dirname, 'run.mjs'), video.mp4, ...PROD_PARAMS, '--out', out],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    )
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`run.mjs exited ${code}`)),
    )
  })
}

let failed = false
for (const video of videos) {
  console.log(`\n[regress] ===== ${video.id} =====`)
  const out = await runEval(video)
  const summary = JSON.parse(await fs.readFile(path.join(out, 'summary.json'), 'utf8'))
  const m = summary.gtIdentity
  if (!m) {
    console.error(`[regress] ${video.id}: no gtIdentity in summary — GT matching failed`)
    failed = true
    continue
  }
  const current = {
    perPageRecall: m.perPageRecall,
    matchedPages: m.matchedPages,
    gtPages: m.gtPages,
    winners: m.winners,
    duplicates: m.duplicates,
    falsePositives: m.falsePositives,
    mergeErrors: m.mergeErrors,
    missedPages: m.missedPages,
  }
  const baselinePath = path.join(BASELINE_DIR, `${video.id}.json`)
  if (update) {
    await fs.mkdir(BASELINE_DIR, { recursive: true })
    await fs.writeFile(baselinePath, JSON.stringify(current, null, 2) + '\n')
    console.log(`[regress] baseline updated: ${baselinePath}`)
    console.log(JSON.stringify(current, null, 2))
    continue
  }
  let base
  try {
    base = JSON.parse(await fs.readFile(baselinePath, 'utf8'))
  } catch {
    console.error(`[regress] ${video.id}: no baseline — run with --update-baselines first`)
    failed = true
    continue
  }
  const problems = []
  if (current.perPageRecall < base.perPageRecall) {
    problems.push(`recall ${base.perPageRecall} → ${current.perPageRecall}`)
  }
  if (current.duplicates > base.duplicates) {
    problems.push(`duplicates ${base.duplicates} → ${current.duplicates}`)
  }
  if (current.falsePositives > base.falsePositives) {
    problems.push(`falsePositives ${base.falsePositives} → ${current.falsePositives}`)
  }
  if (current.mergeErrors > base.mergeErrors) {
    problems.push(`mergeErrors ${base.mergeErrors} → ${current.mergeErrors}`)
  }
  if (problems.length) {
    console.error(`[regress] ${video.id} REGRESSED: ${problems.join('; ')}`)
    failed = true
  } else {
    console.log(
      `[regress] ${video.id} OK — recall=${current.perPageRecall} dup=${current.duplicates} fp=${current.falsePositives} (baseline recall=${base.perPageRecall} dup=${base.duplicates})`,
    )
    if (
      current.perPageRecall > base.perPageRecall ||
      current.duplicates < base.duplicates
    ) {
      console.log(`[regress]   improvement detected — consider --update-baselines`)
    }
  }
}

process.exit(failed ? 1 : 0)
