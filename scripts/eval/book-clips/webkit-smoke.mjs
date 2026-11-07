#!/usr/bin/env node
/**
 * The capture screen opened in Playwright's WebKit (the engine of iOS
 * Safari, on a desktop): what a real iPhone would meet first. Reports, as
 * JSON and a Markdown line:
 *
 *   - the page opens (HTTP status, the Nuxt app shell, no page error);
 *   - crossOriginIsolated (COOP / COEP: WASM threads for the models);
 *   - the models load (`__astarBook.preload`: backend, threads, the
 *     page-number reader's threads) and how long that took;
 *   - what getUserMedia says (WebKit has no fake camera: on a headless
 *     machine the error name is recorded, e.g. NotFoundError — a phone
 *     with a camera and the permission does not hit that one).
 *
 *   NODE_PATH=<node_modules with playwright> node webkit-smoke.mjs <app-url> <out.json>
 *
 * Exits 1 when the page does not open, errors, or the models do not load.
 */
import fs from 'node:fs'
import process from 'node:process'
import { createRequire } from 'node:module'

const { webkit } = createRequire(import.meta.url)('playwright')
const [url, out] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: webkit-smoke.mjs <app-url> <out.json>')
  process.exit(2)
}
const r = {
  engine: 'webkit',
  url,
  status: null,
  appShell: false,
  pageErrors: [],
  consoleErrors: [],
  crossOriginIsolated: null,
  preload: null,
  preloadMs: null,
  camera: null,
}
const browser = await webkit.launch()
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
})
// Playwright's WebKit knows no 'camera' permission: grantPermissions
// throws, and a grant left pending makes newPage fail too ("Unknown
// permission: camera", run 42363025036). So nothing is granted; what
// getUserMedia then says is recorded below.
r.camera = {
  permission: 'not granted (Playwright WebKit has no camera permission)',
}
const page = await context.newPage()
page.on('pageerror', (e) => r.pageErrors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') r.consoleErrors.push(m.text())
})
const resp = await page.goto(`${url.replace(/\/$/, '')}/book?debug`, {
  waitUntil: 'load',
  timeout: 60000,
})
r.status = resp?.status() ?? null
await page.waitForLoadState('networkidle').catch(() => {})
r.appShell = (await page.locator('#__nuxt').count()) > 0
r.crossOriginIsolated = await page.evaluate(
  () => globalThis.crossOriginIsolated,
)
const t0 = Date.now()
try {
  r.preload = await page.evaluate(() => window.__astarBook.preload())
} catch (e) {
  r.preload = { error: e.message.split('\n')[0] }
}
r.preloadMs = Date.now() - t0
r.camera = {
  ...(r.camera ?? {}),
  ...(await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      const t = s.getVideoTracks()[0]
      const st = t?.getSettings() ?? {}
      s.getTracks().forEach((x) => x.stop())
      return { ok: true, width: st.width, height: st.height }
    } catch (e) {
      return { ok: false, error: `${e.name}: ${e.message}` }
    }
  })),
}
await page.screenshot({ path: out.replace(/\.json$/, '.png') })
await browser.close()
fs.writeFileSync(out, JSON.stringify(r, null, 2))
const ok =
  r.status === 200 &&
  r.appShell &&
  r.pageErrors.length === 0 &&
  r.preload &&
  !r.preload.error
console.log(
  `WebKit: status ${r.status}, app shell ${r.appShell ? 'yes' : 'no'}, crossOriginIsolated ${r.crossOriginIsolated}, ` +
    `models ${r.preload?.error ? `FAILED (${r.preload.error})` : `${r.preload?.backend}/${r.preload?.threads} threads in ${r.preloadMs} ms`}, ` +
    `camera ${r.camera.ok ? `${r.camera.width}x${r.camera.height}` : (r.camera.error ?? r.camera.permission)}` +
    (r.pageErrors.length ? `, page errors: ${r.pageErrors.join(' | ')}` : ''),
)
process.exit(ok ? 0 : 1)
