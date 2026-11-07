#!/usr/bin/env node
/**
 * Overlay coordinate check: plays a clip through Chromium's fake camera
 * into harness.html (same layout + renderOverlay() mapping as
 * apps/web/app/pages/index.vue) and saves the raw frame with the quad drawn
 * on it next to a screenshot of the on-screen overlay.
 *
 *   node scripts/eval/corner-check/harness.mjs <clip.y4m> <out-prefix>
 */
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Not a repo dependency: resolve a preinstalled Playwright via NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const [y4m, out] = process.argv.slice(2)
const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
  ],
})
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
await page.goto('file://' + path.join(__dirname, 'harness.html'))
await page.waitForFunction('window.ready === true')
await page.waitForTimeout(1500)
const r = await page.evaluate('window.snap()')
await page.screenshot({ path: `${out}-screen.png` })
fs.writeFileSync(`${out}-raw.png`, Buffer.from(r.raw.split(',')[1], 'base64'))
delete r.raw
console.log(JSON.stringify(r))
await browser.close()
