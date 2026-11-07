#!/usr/bin/env node
/**
 * Runs book-e2e.mjs over the clips of books 1–7 (720x960 framed and the
 * original sizes, the skipped-page variants) one after another and
 * appends one JSON line per run to a results file — the raw results kept
 * in docs/book4-eval/*.jsonl.
 *
 *   NODE_PATH=<node_modules with playwright> node run-books.mjs \
 *     <app-url> <out-dir> <results.jsonl> [--books 1,2,3,4] [--only b4-o-]
 *     [--note "..."]
 *
 * Each run's directory (<out-dir>/<run>) keeps the probe / result / shots
 * of book-e2e.mjs, so a run that is cut short can be continued: runs whose
 * result.json already exists are skipped (delete it to redo one).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const [url, outDir, jsonl] = args
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
if (!url || !outDir || !jsonl) {
  console.error(
    'usage: run-books.mjs <app-url> <out-dir> <results.jsonl> [...]',
  )
  process.exit(2)
}
const books = opt('--books', '1,2,3,4').split(',').map(Number)
const only = opt('--only', null)
const note = opt('--note', '')

// f = 720x960 framed (what the Android emulator camera shows), o = the
// clip's own size (a phone's preview). The skipped page of each book is
// the same hold the Android check skips.
const RUNS = {
  1: [
    ['b1-f-single-land-white', 'framed', 'single-land-white'],
    [
      'b1-f-single-land-white-skip37',
      'framed',
      'single-land-white',
      '--skip-hold',
      '3',
    ],
    ['b1-f-single-port-wood', 'framed', 'single-port-wood'],
    ['b1-f-spread-land-white-thick', 'framed', 'spread-land-white-thick'],
    ['b1-f-spread-land-wood', 'framed', 'spread-land-wood'],
    ['b1-f-spread-port-white', 'framed', 'spread-port-white'],
  ],
  2: [
    ['b2-f-center', 'book2-framed', 'book2-spread-center-1440'],
    ['b2-f-dash-skip', 'book2-framed', 'book2-spread-dash', '--skip-hold', '3'],
    ['b2-f-single-top', 'book2-framed', 'book2-single-top'],
    ['b2-o-center', 'book2', 'book2-spread-center-1440'],
    ['b2-o-dash-skip', 'book2', 'book2-spread-dash', '--skip-hold', '3'],
    ['b2-o-single-top', 'book2', 'book2-single-top'],
  ],
  3: [
    [
      'b3-f-topnum-skip',
      'book3-framed',
      'book3-spread-topnum',
      '--skip-hold',
      '3',
    ],
    [
      'b3-f-topnum-back',
      'book3-framed',
      'book3-spread-topnum',
      '--holds',
      '0,1,2,4,3,5,6',
    ],
    ['b3-f-single-p', 'book3-framed', 'book3-single-p'],
    ['b3-f-paren-port', 'book3-framed', 'book3-spread-paren-port'],
    ['b3-o-topnum-skip', 'book3', 'book3-spread-topnum', '--skip-hold', '3'],
    [
      'b3-o-topnum-back',
      'book3',
      'book3-spread-topnum',
      '--holds',
      '0,1,2,4,3,5,6',
    ],
    ['b3-o-single-p', 'book3', 'book3-single-p'],
    ['b3-o-paren-port', 'book3', 'book3-spread-paren-port'],
  ],
  4: [
    [
      'b4-f-inner-skip',
      'book4-framed',
      'book4-spread-inner',
      '--skip-hold',
      '2',
    ],
    ['b4-f-single-dash', 'book4-framed', 'book4-single-dash'],
    ['b4-f-ja-43', 'book4-framed', 'book4-spread-ja-43'],
    [
      'b4-o-inner-skip',
      'book4',
      'book4-spread-inner',
      '--skip-hold',
      '2',
      '--own-size',
    ],
    ['b4-o-single-dash', 'book4', 'book4-single-dash', '--own-size'],
    ['b4-o-ja-43', 'book4', 'book4-spread-ja-43', '--own-size'],
  ],
  5: [
    [
      'b5-f-bracket-skip',
      'book5-framed',
      'book5-spread-bracket',
      '--skip-hold',
      '4',
    ],
    ['b5-f-single-mono', 'book5-framed', 'book5-single-mono'],
    ['b5-f-ja-kanji', 'book5-framed', 'book5-spread-ja-kanji'],
    [
      'b5-o-bracket-skip',
      'book5',
      'book5-spread-bracket',
      '--skip-hold',
      '4',
      '--own-size',
    ],
    ['b5-o-single-mono', 'book5', 'book5-single-mono', '--own-size'],
    ['b5-o-ja-kanji', 'book5', 'book5-spread-ja-kanji', '--own-size'],
  ],
  6: [
    ['b6-f-head-skip', 'book6-framed', 'book6-spread-head', '--skip-hold', '4'],
    ['b6-f-single-typewriter', 'book6-framed', 'book6-single-typewriter'],
    [
      'b6-f-ja-mincho',
      'book6-framed',
      'book6-spread-ja-mincho',
      '--no-folio',
      '92,93',
    ],
    [
      'b6-o-head-skip',
      'book6',
      'book6-spread-head',
      '--skip-hold',
      '4',
      '--own-size',
    ],
    [
      'b6-o-single-typewriter',
      'book6',
      'book6-single-typewriter',
      '--own-size',
    ],
    [
      'b6-o-ja-mincho',
      'book6',
      'book6-spread-ja-mincho',
      '--no-folio',
      '92,93',
      '--own-size',
    ],
  ],
  7: [
    [
      'b7-f-garamond-skip',
      'book7-framed',
      'book7-spread-garamond',
      '--skip-hold',
      '2',
    ],
    ['b7-f-single-lato', 'book7-framed', 'book7-single-lato'],
    ['b7-f-ja-noto', 'book7-framed', 'book7-spread-ja-noto'],
    [
      'b7-o-garamond-skip',
      'book7',
      'book7-spread-garamond',
      '--skip-hold',
      '2',
      '--own-size',
    ],
    ['b7-o-single-lato', 'book7', 'book7-single-lato', '--own-size'],
    ['b7-o-ja-noto', 'book7', 'book7-spread-ja-noto', '--own-size'],
  ],
}

fs.mkdirSync(outDir, { recursive: true })
for (const b of books) {
  for (const [run, clipsDir, clip, ...extra] of RUNS[b] ?? []) {
    if (only && !run.includes(only)) continue
    const dir = path.join(outDir, run)
    const resultFile = path.join(dir, 'result.json')
    if (fs.existsSync(resultFile)) {
      console.log(`skip ${run} (done)`)
      continue
    }
    const t0 = Date.now()
    console.log(`=== ${run} (${clipsDir}/${clip} ${extra.join(' ')})`)
    const r = spawnSync(
      process.execPath,
      [
        path.join(here, 'book-e2e.mjs'),
        url,
        clip,
        dir,
        '--clips',
        path.join(here, clipsDir),
        ...extra,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 },
    )
    const out = r.stdout?.toString() ?? ''
    const err = r.stderr?.toString() ?? ''
    fs.writeFileSync(path.join(dir, 'stdout.txt'), out + err)
    if (r.status !== 0 || !fs.existsSync(resultFile)) {
      console.log(`!!! ${run} failed (rc ${r.status})\n${err.slice(-2000)}`)
      continue
    }
    const { summary, pageRows } = JSON.parse(
      fs.readFileSync(resultFile, 'utf8'),
    )
    fs.appendFileSync(
      jsonl,
      `${JSON.stringify({ run, dir: path.basename(outDir), note, summary, pageRows })}\n`,
    )
    const s = summary
    console.log(
      `${run}: ✓${s.check} red${s.red} silent${s.silent}${
        s.silentPages.length ? ` ${JSON.stringify(s.silentPages)}` : ''
      } num ${s.numbersRight}/${s.numbersWrong}/${s.numbersUnread} falseRed${
        s.falseRed
      } fps${s.fps.toFixed(1)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`,
    )
  }
}
