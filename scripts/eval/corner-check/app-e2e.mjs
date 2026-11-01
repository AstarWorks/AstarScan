#!/usr/bin/env node
/**
 * Real-app check: plays a synthetic clip (synth.py → y4m) through
 * Chromium's fake camera into the running web app (index.vue, unchanged
 * drawing and cropping), and records
 *   - screenshots of the scan screen while each page is held,
 *   - every live ✓ / red "まだ撮れていません" chip with its clip time,
 *   - the saved page images after 停止.
 *
 *   NODE_PATH=<node_modules with playwright> node app-e2e.mjs \
 *     <app-url> <clip.y4m> <gt.json> <out-dir> [--loops 2] [--viewport 390x844]
 *
 * Chips are attributed to GT pages by clip time (the fake camera starts
 * the file at frame 0 when the stream opens and loops it). The first loop
 * includes model warm-up; numbers are reported per loop.
 */
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

// Not a repo dependency: resolve a preinstalled Playwright via NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright')

const args = process.argv.slice(2)
const [url, y4m, gtPath, outDir] = args
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const loops = Number(opt('--loops', '2'))
const [vw, vh] = opt('--viewport', '390x844').split('x').map(Number)
const gt = JSON.parse(fs.readFileSync(gtPath, 'utf8'))
const fps = gt.fps ?? 10
const nFrames = gt.frames.length
const clipS = nFrames / fps
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
  ],
})
const page = await browser.newPage({ viewport: { width: vw, height: vh } })
const logs = []
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'warning' || m.type() === 'error' || /\[live\]|finalize/i.test(t))
    logs.push(`${m.type()}: ${t}`)
})
await page.addInitScript(() => {
  window.__chips = []
  const watch = () =>
    new MutationObserver((muts) => {
      for (const m of muts)
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue
          const els = n.matches?.('li.live-strip__chip')
            ? [n]
            : [...n.querySelectorAll('li.live-strip__chip')]
          for (const el of els)
            window.__chips.push({
              kind: el.className.includes('--captured') ? 'captured' : 'missed',
              t: performance.now(),
              thumb: el.querySelector('img')?.src ?? '',
            })
        }
    }).observe(document.documentElement, { childList: true, subtree: true })
  if (document.documentElement) watch()
  else document.addEventListener('DOMContentLoaded', watch)
})
await page.goto(url)
await page.waitForLoadState('networkidle').catch(() => {})
await page.getByRole('button', { name: 'カメラで撮影' }).click()
await page.waitForFunction(
  () => (document.querySelector('video')?.readyState ?? 0) >= 2,
  null,
  { timeout: 30000 },
)
const t0 = await page.evaluate(() => performance.now())
const videoSize = await page.evaluate(() => {
  const v = document.querySelector('video')
  return { w: v?.videoWidth, h: v?.videoHeight }
})

// Page k is held over frames [k*per, k*per + hold).
const holdFrames = gt.frames.filter((f) => f.page === 1 && f.holding).length
const per = gt.frames.findIndex((f, i) => i > 0 && f.page === 2)
const pages = Math.max(...gt.frames.map((f) => f.page ?? 0))
const shots = []
for (let loop = 0; loop < loops; loop += 1) {
  for (let k = 0; k < pages; k += 1) {
    // Shoot 1.2 s into each hold (the ✓ comes at ~0.7 s).
    const at = loop * clipS + (k * per + 12) / fps
    const now = (await page.evaluate(() => performance.now())) - t0
    if (at * 1000 > now) await page.waitForTimeout(at * 1000 - now)
    if (loop === loops - 1) {
      const p = path.join(outDir, `screen-p${k + 1}.png`)
      await page.screenshot({ path: p })
      shots.push(p)
    }
  }
}
const end = loops * clipS * 1000 + 300
const now = (await page.evaluate(() => performance.now())) - t0
if (end > now) await page.waitForTimeout(end - now)
const chips = (await page.evaluate(() => window.__chips)) ?? []
await page.getByRole('button', { name: '停止' }).click()
// Wait for the post-scan pass to finish (the 停止 button goes away).
await page
  .waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].some((b) =>
        /停止|処理中/.test(b.textContent ?? ''),
      ),
    null,
    { timeout: 120000 },
  )
  .catch(() => {})
await page.waitForTimeout(1500)
await page.evaluate(() => {
  const d = document.querySelector('details.strip-drawer')
  if (d) d.open = true
})
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'done.png'), fullPage: true })
const imgs = await page.evaluate(() =>
  [...document.querySelectorAll('.strip__thumb img')].map((i) => i.src),
)
const saved = []
imgs.forEach((src, i) => {
  const m = /^data:image\/(\w+);base64,(.*)$/.exec(src)
  if (!m) return
  const p = path.join(outDir, `page-${i + 1}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
  fs.writeFileSync(p, Buffer.from(m[2], 'base64'))
  saved.push(p)
})
const reportText = await page.evaluate(
  () => document.querySelector('.capture-report, [class*="report"]')?.innerText ?? '',
)

// Thumbnails of the red chips (what the judge thought was missed).
chips.forEach((c, i) => {
  const m = /^data:image\/(\w+);base64,(.*)$/.exec(c.thumb ?? '')
  if (c.kind === 'missed' && m)
    fs.writeFileSync(path.join(outDir, `missed-${i}.jpg`), Buffer.from(m[2], 'base64'))
})

// Attribute chips to pages per loop.
const perLoop = []
for (let loop = 0; loop < loops; loop += 1) {
  const rows = []
  for (let k = 0; k < pages; k += 1) {
    const from = loop * clipS + (k * per) / fps
    const to = from + per / fps
    const inPage = chips.filter((c) => {
      const t = (c.t - t0) / 1000
      return t >= from && t < to
    })
    rows.push({
      page: k + 1,
      captured: inPage.filter((c) => c.kind === 'captured').length,
      missed: inPage.filter((c) => c.kind === 'missed').length,
    })
  }
  perLoop.push({
    loop: loop + 1,
    pagesWithCheck: rows.filter((r) => r.captured > 0).length,
    redAlerts: rows.reduce((s, r) => s + r.missed, 0),
    silentlyLost: rows.filter((r) => r.captured === 0 && r.missed === 0)
      .length,
    rows,
  })
}
const result = {
  url,
  clip: y4m,
  videoSize,
  viewport: { w: vw, h: vh },
  holdFrames,
  chips: chips.map((c) => ({ kind: c.kind, t: +((c.t - t0) / 1000).toFixed(2) })),
  perLoop,
  savedPages: saved,
  screenshots: shots,
  reportText,
  logs: logs.slice(0, 2000),
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify({ videoSize, perLoop, saved: saved.length }, null, 2))
await browser.close()
