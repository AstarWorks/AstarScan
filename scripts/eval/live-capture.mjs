#!/usr/bin/env bun
/**
 * Replay the live capture judge (scan-core `LiveCaptureJudge`) over the
 * per-frame GT logs (test/fixtures/gt/<video>/frames.jsonl) — no video,
 * no OpenCV — and score the ✓ events against the GT pages.
 *
 *   bun scripts/eval/live-capture.mjs            # table with LIVE_CAPTURE_DEFAULTS
 *   bun scripts/eval/live-capture.mjs --check    # exit 1 below the target
 *   bun scripts/eval/live-capture.mjs --grid     # search the parameter space
 *   bun scripts/eval/live-capture.mjs --events   # print every event
 *   bun scripts/eval/live-capture.mjs --misses   # classify every red alert
 *   bun scripts/eval/live-capture.mjs --opts '{"holdS":0.6}'  # try overrides
 *
 * A ✓ is assigned to the GT page whose timeRangeS contains its chosen
 * frame (temporal-first, as in lib/gt-match.mjs); none = non-page ✓.
 * Metrics come from `computeGtMetrics` (lib/gt-match.mjs), the same
 * function regress.mjs reports.
 *
 * Target (task spec): ✓ on ≥ 21 of the 22 real pages, duplicate ✓ ≤ 3,
 * non-page ✓ = 0, and no red alert ("まだ撮れていません") unless the page
 * really got no ✓.
 *
 * Every red alert is classified (`--misses`) by the GT page under its
 * best frame and the ✓ events of that page:
 *   real          the page never got a ✓ (a true miss)
 *   before-✓      the page got its ✓ right after (placed / settling)
 *   after-✓       the page had its ✓ already (re-gripped / taken away)
 *   non-page      no GT page under the frame (desk, hand, mid-turn)
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { computeGtMetrics } from './lib/gt-match.mjs'
import {
  LiveCaptureJudge,
  LIVE_CAPTURE_DEFAULTS,
} from '../../packages/core/src/pipeline/live-capture.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../..')
const GT_DIR = path.join(REPO_ROOT, 'test/fixtures/gt')

/** Source frame size of both GT videos (quadArea / areaFrac = 921600). */
const FRAME_W = 720
const FRAME_H = 1280

export const TARGET = {
  minMatched: 21,
  maxDuplicates: 3,
  maxNonPage: 0,
  maxFalseAlerts: 0,
}

export async function loadGtLogs() {
  const out = []
  for (const entry of (await fs.readdir(GT_DIR, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue
    const dir = path.join(GT_DIR, entry.name)
    let text
    try {
      text = await fs.readFile(path.join(dir, 'frames.jsonl'), 'utf8')
    } catch {
      continue
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'),
    )
    const frames = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    out.push({ id: entry.name, manifest, frames })
  }
  return out
}

function pageAt(manifest, t) {
  const hits = manifest.pages.filter(
    (p) => t >= p.timeRangeS[0] - 1e-6 && t <= p.timeRangeS[1] + 1e-6,
  )
  return hits.length === 1 ? hits[0].id : null
}

/** Replay one log; returns events + GT metrics. */
export function replay(log, opts = {}) {
  const judge = new LiveCaptureJudge(opts)
  const events = []
  for (const f of log.frames) {
    const frame = {
      t: f.t_s,
      confidence: f.detected ? f.confidence : 0,
      quad: f.quad ?? null,
      frameW: FRAME_W,
      frameH: FRAME_H,
      areaFrac: f.areaFrac ?? 0,
      score: f.score ?? 0,
      hash: f.hashHex ? BigInt('0x' + f.hashHex) : null,
      data: f.idx,
    }
    events.push(...judge.push(frame))
  }
  const last = log.frames[log.frames.length - 1]
  events.push(...judge.finish(last ? last.t_s : 0))

  const captures = events.filter((e) => e.type === 'captured')
  const assignments = captures.map((e) => ({
    idx: e.best.data,
    t_s: e.best.t,
    pageId: pageAt(log.manifest, e.best.t),
    mergeSuspect: false,
  }))
  const metrics = computeGtMetrics(log.manifest, assignments)
  const misses = events.filter((e) => e.type === 'missed')
  const capturedPages = new Set(
    assignments.map((a) => a.pageId).filter(Boolean),
  )
  const missRows = misses.map((e) => {
    const pageId = pageAt(log.manifest, e.best.t)
    const real = pageId !== null && !capturedPages.has(pageId)
    const capT = assignments
      .filter((a) => a.pageId === pageId)
      .map((a) => a.t_s)
    const kind =
      pageId === null
        ? 'non-page'
        : real
          ? 'real'
          : capT.some((t) => t >= e.startT)
            ? 'before-✓'
            : 'after-✓'
    return { ...e, pageId, real, kind }
  })
  return { events, assignments, metrics, misses: missRows }
}

export function replayAll(logs, opts = {}) {
  const per = logs.map((log) => ({ id: log.id, ...replay(log, opts) }))
  const sum = (k) => per.reduce((s, r) => s + r.metrics[k], 0)
  return {
    per,
    total: {
      gtPages: sum('gtPages'),
      matchedPages: sum('matchedPages'),
      duplicates: sum('duplicates'),
      falsePositives: sum('falsePositives'),
      winners: sum('winners'),
      missAlerts: per.reduce((s, r) => s + r.misses.length, 0),
      missAlertsOnPage: per.reduce(
        (s, r) => s + r.misses.filter((m) => m.pageId).length,
        0,
      ),
      missAlertsReal: per.reduce(
        (s, r) => s + r.misses.filter((m) => m.real).length,
        0,
      ),
    },
  }
}

export function meetsTarget(total) {
  return (
    total.matchedPages >= TARGET.minMatched &&
    total.duplicates <= TARGET.maxDuplicates &&
    total.falsePositives <= TARGET.maxNonPage &&
    total.missAlerts - total.missAlertsReal <= TARGET.maxFalseAlerts
  )
}

function printTable(res) {
  console.log(
    '| 動画 | 正解ページ | ✓が出たページ | ✓ 総数 | 重複✓ | ページ以外の✓ | 抜け | 赤（まだ撮れていません） | 赤のうち✓が出なかったページ |',
  )
  console.log('|---|---|---|---|---|---|---|---|---|')
  for (const r of res.per) {
    const m = r.metrics
    console.log(
      `| ${r.id} | ${m.gtPages} | ${m.matchedPages} | ${m.winners} | ${m.duplicates} | ${m.falsePositives} | ${m.missedPages.join(', ') || '—'} | ${r.misses.length} | ${r.misses.filter((x) => x.real).length} |`,
    )
  }
  const t = res.total
  console.log(
    `| 合計 | ${t.gtPages} | ${t.matchedPages} | ${t.winners} | ${t.duplicates} | ${t.falsePositives} | ${t.gtPages - t.matchedPages} | ${t.missAlerts} | ${t.missAlertsReal} |`,
  )
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const logs = await loadGtLogs()
  if (!logs.length) {
    console.error('[live-capture] no frames.jsonl under test/fixtures/gt')
    process.exit(2)
  }

  if (args.includes('--grid')) {
    // The neighbourhood LIVE_CAPTURE_DEFAULTS was picked from (a wider
    // first pass found holdS ≤ 0.6, changeS 0.2 and a frozen post-capture
    // reference necessary for ≥ 21/22).
    const grid = {
      holdS: [0.5, 0.6, 0.7, 0.8],
      changeDist: [80, 90, 100, 110],
      changeS: [0.2, 0.3],
      gapS: [1.0, 1.5, 2.0],
      sameDist: [30, 50, 70],
      minConfidence: [0.25, 0.4, 0.5],
      maxMotion: [0.05, 0.06, 0.07, 0.08, 0.12, Infinity],
      leaveS: [0.5, 1.0, 1.5],
      missMinS: [0.3, 0.6],
    }
    const keys = Object.keys(grid)
    const rows = []
    const rec = (i, cur) => {
      if (i === keys.length) {
        const { total } = replayAll(logs, cur)
        rows.push({ opts: { ...cur }, total })
        return
      }
      for (const v of grid[keys[i]]) rec(i + 1, { ...cur, [keys[i]]: v })
    }
    rec(0, {})
    rows.sort(
      (a, b) =>
        b.total.matchedPages - a.total.matchedPages ||
        a.total.falsePositives - b.total.falsePositives ||
        a.total.duplicates - b.total.duplicates ||
        a.total.missAlerts -
          a.total.missAlertsReal -
          (b.total.missAlerts - b.total.missAlertsReal) ||
        a.total.missAlerts - b.total.missAlerts,
    )
    for (const r of rows.slice(0, 40))
      console.log(JSON.stringify(r.opts), JSON.stringify(r.total))
    process.exit(0)
  }

  const optsIdx = args.indexOf('--opts')
  const overrides = optsIdx >= 0 ? JSON.parse(args[optsIdx + 1]) : {}
  const res = replayAll(logs, overrides)
  console.log(
    'options',
    JSON.stringify({ ...LIVE_CAPTURE_DEFAULTS, ...overrides }),
  )
  printTable(res)
  if (args.includes('--events')) {
    for (const r of res.per) {
      console.log(`\n## ${r.id}`)
      for (const e of r.events) {
        if (e.type === 'hold') continue
        const a =
          e.type === 'captured' || e.type === 'missed'
            ? ` best=${e.best.t.toFixed(1)}s page=${pageAt(logs.find((l) => l.id === r.id).manifest, e.best.t) ?? '-'}`
            : ''
        console.log(
          `${e.t.toFixed(1)}s ${e.type}${e.pageNo ? ' #' + e.pageNo : ''}${a}`,
        )
      }
    }
  }
  if (args.includes('--misses')) {
    console.log('\n| 動画 | 赤の時刻 | 映っていた範囲 | ページ | 分類 |')
    console.log('|---|---|---|---|---|')
    for (const r of res.per) {
      for (const m of r.misses) {
        console.log(
          `| ${r.id} | ${m.t.toFixed(1)}s | ${m.startT.toFixed(1)}–${m.endT.toFixed(1)}s | ${m.pageId ?? '—'} | ${m.kind} |`,
        )
      }
    }
  }
  if (args.includes('--check') && !meetsTarget(res.total)) {
    console.error('[live-capture] below target', JSON.stringify(TARGET))
    process.exit(1)
  }
}
