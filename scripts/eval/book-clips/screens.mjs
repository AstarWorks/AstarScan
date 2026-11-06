#!/usr/bin/env node
/**
 * Screens of the agreed experience (docs/ux/ideal-capture.html) on the real
 * capture screen, for a PR: the frame's green sweep, "✓ N ページ 撮れた",
 * the red gap, the list with a spread split into two rows, the saved PDF
 * (one page per row, checked with pdfinfo / pdftoppm) and the saved
 * Markdown (one heading per page, NDLOCR — slow, --md).
 *
 *   NODE_PATH=<node_modules with playwright> node screens.mjs \
 *     <app-url> <clip.mjpeg> <seconds> <out-dir> [--viewport 390x844] [--md]
 *
 * <clip.mjpeg> is the file book-e2e.mjs made in its out-dir (the clip, or
 * the holds in the order asked for). The screenshots are taken on the
 * events the app reports through __astarProbe (as book-e2e.mjs does).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const { chromium } = createRequire(import.meta.url)('playwright')
const args = process.argv.slice(2)
const [url, mjpeg, seconds, outDir] = args
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const [vw, vh] = opt('--viewport', '390x844').split('x').map(Number)
const wantMd = args.includes('--md')
if (!url || !mjpeg || !seconds || !outDir) {
  console.error('usage: screens.mjs <app-url> <clip.mjpeg> <seconds> <out-dir>')
  process.exit(2)
}
fs.mkdirSync(outDir, { recursive: true })

// The clip's size: a portrait clip is handed to the app upright (as
// book-e2e.mjs does for a phone held upright).
const probeSize = execFileSync('ffprobe', [
  '-v',
  'error',
  '-f',
  'mjpeg',
  '-select_streams',
  'v:0',
  '-show_entries',
  'stream=width,height',
  '-of',
  'csv=p=0',
  mjpeg,
])
  .toString()
  .trim()
  .split(',')
  .map(Number)
const portrait = probeSize[1] > probeSize[0]

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${mjpeg}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const context = await browser.newContext({
  viewport: { width: vw, height: vh },
  deviceScaleFactor: 2,
  acceptDownloads: true,
})
const page = await context.newPage()
if (portrait)
  await page.addInitScript(() => {
    const md = navigator.mediaDevices
    const orig = md.getUserMedia.bind(md)
    md.getUserMedia = (c) => {
      const v = c?.video
      if (v && typeof v === 'object' && v.width && v.height)
        c = { ...c, video: { ...v, width: v.height, height: v.width } }
      return orig(c)
    }
  })
await page.addInitScript(() => {
  window.__probe = []
  window.__astarProbe = (e) =>
    window.__probe.push({ ...e, wall: performance.now() })
})
await page.goto(`${url.replace(/\/$/, '')}/book`)
await page.waitForLoadState('networkidle').catch(() => {})
await page.evaluate(() => window.__astarBook.preload())
await page.screenshot({ path: path.join(outDir, '00-start.png') })
await page.getByRole('button', { name: '撮影を始める' }).click()
await page.waitForFunction(
  () => (document.querySelector('video')?.readyState ?? 0) >= 2,
  null,
  { timeout: 30000 },
)
const t0 = await page.evaluate(() => performance.now())
const endMs = Number(seconds) * 1000 + 1500
const taken = new Map()
let seen = 0
const shot = async (kind, max = 2) => {
  const n = taken.get(kind) ?? 0
  if (n >= max) return
  taken.set(kind, n + 1)
  await page.screenshot({
    path: path.join(outDir, `${kind}-${n + 1}.png`),
  })
}
for (;;) {
  const now = (await page.evaluate(() => performance.now())) - t0
  if (now >= endMs) break
  const evs = await page.evaluate(
    (from) => window.__probe.slice(from).filter((e) => e.type !== 'frame'),
    seen,
  )
  seen = await page.evaluate(() => window.__probe.length)
  for (const e of evs) {
    if (e.type === 'sweep') {
      await page.waitForTimeout(150)
      await shot('sweep')
    } else if (e.type === 'capture') await shot('captured', 3)
    else if (e.type === 'number' && e.numbers.length) {
      await page.waitForTimeout(100)
      await shot('number', 3)
    } else if (e.type === 'alert') {
      await page.waitForTimeout(100)
      await shot('red')
    } else if (e.type === 'dupByNumber' || (e.type === 'hold' && e.verdict === 'dup'))
      await shot('taken-before')
  }
  await page.waitForTimeout(30)
}
await page.evaluate(() => window.__astarBook.finish())
await page.waitForTimeout(2500)
await page.screenshot({ path: path.join(outDir, 'list.png'), fullPage: true })
const rows = page.locator('.list__row')
const n = await rows.count()
if (n > 0) {
  await rows.first().click()
  await page.waitForTimeout(400)
  await page.screenshot({
    path: path.join(outDir, 'list-preview.png'),
    fullPage: true,
  })
}
// PDF: one page per list row.
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 60000 }),
  page.getByRole('button', { name: 'PDF 保存' }).click(),
])
const pdfPath = path.join(outDir, 'saved.pdf')
await dl.saveAs(pdfPath)
const info = execFileSync('pdfinfo', [pdfPath]).toString()
fs.writeFileSync(path.join(outDir, 'pdfinfo.txt'), info)
console.log(info.split('\n').filter((l) => /^(Pages|Page size)/.test(l)).join('\n'))
execFileSync('pdftoppm', [
  '-r',
  '40',
  '-png',
  pdfPath,
  path.join(outDir, 'pdf-page'),
])
await page.screenshot({ path: path.join(outDir, 'list-after-pdf.png'), fullPage: true })
if (wantMd) {
  const [dm] = await Promise.all([
    page.waitForEvent('download', { timeout: 20 * 60 * 1000 }),
    page.getByRole('button', { name: 'Markdown 保存' }).click(),
  ])
  const mdPath = path.join(outDir, 'saved.md')
  await dm.saveAs(mdPath)
  const md = fs.readFileSync(mdPath, 'utf8')
  console.log(md.split('\n').filter((l) => l.startsWith('## ')).join('\n'))
  await page.screenshot({ path: path.join(outDir, 'list-after-md.png'), fullPage: true })
}
const probe = await page.evaluate(() => window.__probe)
fs.writeFileSync(
  path.join(outDir, 'probe.json'),
  JSON.stringify(probe.map((e) => (e.type === 'frame' ? { ...e, sig: undefined } : e))),
)
await context.close()
await browser.close()
console.log(`screens in ${outDir}: ${fs.readdirSync(outDir).join(', ')}`)
