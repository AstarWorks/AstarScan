#!/usr/bin/env node
/**
 * Markdown table of book-e2e.mjs results.
 *   node table.mjs <run-dir>   (one sub-directory per clip, each with result.json)
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const dir = process.argv[2]
const rows = []
for (const name of fs.readdirSync(dir).sort()) {
  const f = path.join(dir, name, 'result.json')
  if (fs.existsSync(f)) rows.push(JSON.parse(fs.readFileSync(f, 'utf8')).summary)
}
const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0)
console.log(
  '| clip | target pages | ✓ | red | silent | corner err median px (hold frames / ✓) | saved (whole paper) | saved ≠ ✓ page | sampled fps |',
)
console.log('|---|---|---|---|---|---|---|---|---|')
for (const r of rows)
  console.log(
    `| ${r.clip} | ${r.targetPages} | ${r.check} | ${r.red} | ${r.silent} | ${r.errHoldMedian ?? '–'} / ${r.errCheckMedian ?? '–'} | ${r.saved} (${r.savedFull}) | ${r.savedOtherPageThanCheck} | ${r.fpsSampled} |`,
  )
console.log(
  `| **total** | ${sum('targetPages')} | ${sum('check')} | ${sum('red')} | ${sum('silent')} | | ${sum('saved')} (${sum('savedFull')}) | ${sum('savedOtherPageThanCheck')} | |`,
)
