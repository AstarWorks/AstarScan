/**
 * Score page-number OCR lines (page-number-ocr.py output) with the app's
 * own picker (scan-core pickPageNumbers): per resolution × decode, how
 * many page images got the right number(s), a wrong number, or none.
 *
 * usage: bun scripts/android/page-number-score.ts <lines.jsonl> [--min-conf X]
 */
import { readFileSync } from 'node:fs'
import { pickPageNumbers } from '../../packages/core/src/pipeline/page-numbers'

interface Line {
  text: string
  conf: number
  cx: number
  cy: number
}
interface Rec {
  clip: string
  hold: number
  res: string
  decode: string
  truth: number[]
  lines: Line[]
}

const args = process.argv.slice(2)
const file = args[0]
if (!file) throw new Error('usage: page-number-score.ts <lines.jsonl>')
const mi = args.indexOf('--min-conf')
const minConf = mi >= 0 ? Number(args[mi + 1]) : 0

const recs = readFileSync(file, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Rec)

// The app's rule (page-number-reader.ts pickNativePageNumbers): the band
// pass, and the folio pass only when the band pass gives no number.
const byImage = new Map<string, Map<string, Rec>>()
for (const r of recs) {
  const k = `${r.clip}\t${r.hold}\t${r.res}`
  const m = byImage.get(k) ?? new Map<string, Rec>()
  m.set(r.decode, r)
  byImage.set(k, m)
}
for (const m of byImage.values()) {
  const band = m.get('mlkit-band')
  const folio = m.get('mlkit-folio')
  if (!band || !folio) continue
  const bandNums = pickPageNumbers(band.lines.filter((l) => l.conf >= minConf))
  recs.push({
    ...band,
    decode: 'mlkit-band→folio',
    lines: bandNums.length > 0 ? band.lines : folio.lines,
  })
}

type Tally = { right: number; wrong: number; none: number; n: number }
const tally = new Map<string, Tally>()
const detail: string[] = []
for (const r of recs) {
  const nums = pickPageNumbers(r.lines.filter((l) => l.conf >= minConf))
  const want = r.truth
  // A spread is right when both numbers match; one number that is one of
  // the two is also right (the app checks the sequence with it).
  const ok =
    nums.length > 0 &&
    nums.every((n) => want.includes(n)) &&
    (nums.length === want.length || nums.length === 1)
  const key = `${r.clip}\t${r.res}\t${r.decode}`
  const t = tally.get(key) ?? { right: 0, wrong: 0, none: 0, n: 0 }
  t.n++
  if (nums.length === 0) t.none++
  else if (ok) t.right++
  else t.wrong++
  tally.set(key, t)
  detail.push(
    `${r.clip} h${r.hold} ${r.res} ${r.decode}: truth ${want.join('/')} → ${nums.join('/') || '-'}   [${r.lines
      .filter((l) => /\d|一|二|三/.test(l.text))
      .map((l) => `${l.text}@${l.conf.toFixed(2)}`)
      .join(' | ')}]`,
  )
}

if (args.includes('--detail')) console.log(detail.join('\n') + '\n')
console.log('| clip | resolution | decode | right | wrong | none | images |')
console.log('| --- | --- | --- | --- | --- | --- | --- |')
const sum = new Map<string, Tally>()
for (const [k, t] of [...tally].sort()) {
  const [clip, res, dec] = k.split('\t')
  console.log(
    `| ${clip} | ${res} | ${dec} | ${t.right} | ${t.wrong} | ${t.none} | ${t.n} |`,
  )
  const sk = `${res}\t${dec}`
  const s = sum.get(sk) ?? { right: 0, wrong: 0, none: 0, n: 0 }
  s.right += t.right
  s.wrong += t.wrong
  s.none += t.none
  s.n += t.n
  sum.set(sk, s)
}
for (const [k, s] of [...sum].sort()) {
  const [res, dec] = k.split('\t')
  console.log(
    `| **all** | ${res} | ${dec} | ${s.right} | ${s.wrong} | ${s.none} | ${s.n} |`,
  )
}
