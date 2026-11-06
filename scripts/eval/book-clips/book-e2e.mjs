#!/usr/bin/env node
/**
 * Book-clip check of the web capture screen (apps/web pages/book.vue):
 * plays a book clip through Chromium's fake camera into the running app
 * and scores what the screen did against the clip's ground truth, with the
 * same items as the Android check (docs/android-book-eval.md):
 *
 *   silent   a target page that got neither a ✓ nor a red notice
 *   check    ✓: a capture during the page's hold whose page frame covers
 *            ≥ 90 % of the page (a spread capture is split into its two
 *            pages; each half is scored against its own page)
 *   red      no ✓, but a red "… ページが抜けています" naming the page
 *   misread  a captured page whose number was read wrong (and unread)
 *   falseRed a red notice naming a page that had been ✓ before it
 *   corners  mean corner distance (clip px) of each captured page frame
 *            to its page, and of the spread frame to the spread
 *   gutter   distance (clip px) of the split line's top / bottom ends to
 *            the true gutter (the left page's tr / br corners)
 *   fps      corner-model frames per second
 *   ✓ time   capture time − the hold's first frame (s)
 *   number   number shown − capture (s)
 *
 *   NODE_PATH=<node_modules with playwright> node book-e2e.mjs \
 *     <app-url> <clip-name> <out-dir> [--clips <dir>] [--viewport 390x844]
 *     [--record] [--query debug]
 *
 * The models are loaded before the camera opens (`__astarBook.preload`),
 * so the clip's first loop is scored warm. Which clip frame each processed
 * frame showed is found by matching the app's 32×24 grey view of it against
 * the clip (no guessing when the fake camera started).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const { chromium } = createRequire(import.meta.url)('playwright')
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const [url, clipName, outDir] = args
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const [vw, vh] = opt('--viewport', '390x844').split('x').map(Number)
const record = args.includes('--record')
const clipsDir = opt('--clips', path.join(__dirname, 'clips'))
const query = opt('--query', 'debug')
if (!url || !clipName || !outDir) {
  console.error('usage: book-e2e.mjs <app-url> <clip-name> <out-dir> [...]')
  process.exit(2)
}
const COVER_PAGE = 0.9

fs.mkdirSync(path.join(outDir, 'pages'), { recursive: true })
const gt = JSON.parse(
  fs.readFileSync(path.join(clipsDir, `${clipName}.gt.json`), 'utf8'),
)
const fps = gt.fps
const mp4 = path.join(clipsDir, `${clipName}.mp4`)
const mjpeg = path.join(outDir, `${clipName}.mjpeg`)

// --holds 0,1,3,2,3,4 plays the clip's holds in that order (a turn is kept
// between a hold and the next one in the book; other steps are a cut):
// skipping a page, going back to it, coming back to a page taken before.
// --skip-hold 3 plays every hold but that one (single-land-white p37, as
// the Android check skips it).
const holdsArg = opt('--holds', null)
const skipHold = opt('--skip-hold', null)
const origHolds = gt.segments.filter((x) => x.phase === 'hold')
let order = null
if (holdsArg) order = holdsArg.split(',').map(Number)
else if (skipHold !== null)
  order = origHolds.map((_, i) => i).filter((i) => i !== Number(skipHold))
if (order) {
  const keep = []
  order.forEach((k, j) => {
    const h = origHolds[k]
    for (let f = h.start_frame; f < h.end_frame; f += 1) keep.push(f)
    const next = order[j + 1]
    const turn = gt.segments.find(
      (x) => x.phase === 'turn' && x.start_frame === h.end_frame,
    )
    // The turn after this hold (the page being turned), unless we go back.
    if (next !== undefined && next > k && turn)
      for (let f = turn.start_frame; f < turn.end_frame; f += 1) keep.push(f)
  })
  const dir = path.join(outDir, 'src-frames')
  fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(path.join(dir, '00001.jpg')))
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      mp4,
      '-q:v',
      '3',
      path.join(dir, '%05d.jpg'),
    ])
  fs.writeFileSync(
    mjpeg,
    Buffer.concat(
      keep.map((f) =>
        fs.readFileSync(
          path.join(dir, `${String(f + 1).padStart(5, '0')}.jpg`),
        ),
      ),
    ),
  )
  const frames2 = keep.map((f) => gt.frames[f])
  const segs = []
  keep.forEach((f, i) => {
    const ph = gt.frames[f].phase === 'hold' ? 'hold' : 'turn'
    const last = segs[segs.length - 1]
    const brk = i > 0 && keep[i - 1] !== f - 1
    if (last && last.phase === ph && !brk) last.end_frame = i + 1
    else segs.push({ phase: ph, start_frame: i, end_frame: i + 1 })
  })
  gt.frames = frames2
  gt.segments = segs
  fs.writeFileSync(
    path.join(outDir, 'order.json'),
    JSON.stringify({ order, keep: keep.length }),
  )
} else if (!fs.existsSync(mjpeg))
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-i',
    mp4,
    '-q:v',
    '3',
    mjpeg,
  ])
const N = gt.frames.length
const clipS = N / fps
const SW = 32
const SH = 24
const raw = execFileSync(
  'ffmpeg',
  [
    '-loglevel',
    'error',
    '-f',
    'mjpeg',
    '-i',
    mjpeg,
    '-vf',
    `scale=${SW}:${SH}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-',
  ],
  { maxBuffer: 1 << 28 },
)
const clipSig = []
for (let i = 0; i < N; i += 1)
  clipSig.push(raw.subarray(i * SW * SH, (i + 1) * SW * SH))

// --- run --------------------------------------------------------------------
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
  ...(record
    ? {
        recordVideo: {
          dir: path.join(outDir, 'video'),
          size: { width: vw, height: vh },
        },
      }
    : {}),
})
const page = await context.newPage()
const logs = []
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error')
    logs.push(`${m.type()}: ${m.text()}`)
})
// Portrait clips: a phone held upright returns 1080×1920 for the app's
// 1920×1080 ideal; Chromium's fake camera would centre-crop to a square.
if (gt.H > gt.W)
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
await page.goto(`${url.replace(/\/$/, '')}/book${query ? `?${query}` : ''}`)
await page.waitForLoadState('networkidle').catch(() => {})
const pre = await page.evaluate(() => window.__astarBook.preload())
await page.getByRole('button', { name: '撮影を始める' }).click()
await page.waitForFunction(
  () => (document.querySelector('video')?.readyState ?? 0) >= 2,
  null,
  { timeout: 30000 },
)
const wStream = await page.evaluate(() => performance.now())

// Screenshots of the moments the PR shows: ✓ with a number, red, 撮影済み.
const shots = []
const shotKinds = new Set()
const endMs = clipS * 1000 + 1500
let seen = 0
for (;;) {
  const now = (await page.evaluate(() => performance.now())) - wStream
  if (now >= endMs) break
  const evs = await page.evaluate(
    (from) => window.__probe.slice(from).filter((e) => e.type !== 'frame'),
    seen,
  )
  seen = await page.evaluate(() => window.__probe.length)
  for (const e of evs) {
    let kind = null
    if (e.type === 'alert') kind = 'red'
    else if (e.type === 'number' && e.numbers.length) kind = 'number'
    else if (e.type === 'hold' && e.verdict === 'dup') kind = 'dup'
    else if (e.type === 'sweep') kind = 'sweep'
    if (kind && shots.filter((s) => s.kind === kind).length < 3) {
      const p = path.join(
        outDir,
        `shot-${String(shots.length).padStart(2, '0')}-${kind}.png`,
      )
      await page.screenshot({ path: p })
      shots.push({ kind, path: p, t: now })
      shotKinds.add(kind)
    }
  }
  await page.waitForTimeout(40)
}
await page.evaluate(() => window.__astarBook.finish())
// Let the last pages finish their numbers and flattening.
await page.waitForTimeout(2500)
await page.screenshot({ path: path.join(outDir, 'list.png'), fullPage: true })
const firstRow = page.locator('.list__row').first()
if (await firstRow.count()) {
  await firstRow.click()
  await page.waitForTimeout(400)
  await page.screenshot({
    path: path.join(outDir, 'list-preview.png'),
    fullPage: true,
  })
}
const probe = await page.evaluate(() => window.__probe)
const kept = await page.evaluate(() => window.__astarBook.pages())
for (const p of kept) {
  const data = await page.evaluate((id) => window.__astarBook.image(id), p.id)
  if (data)
    fs.writeFileSync(
      path.join(outDir, 'pages', `${p.id}.jpg`),
      Buffer.from(data.split(',')[1], 'base64'),
    )
}
const videoPath = record ? await page.video()?.path() : null
await context.close()
await browser.close()

// --- which clip frame was each processed frame ----------------------------
const frames = probe.filter((e) => e.type === 'frame' && e.sig?.length)
const sad = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i])
  return s
}
let offset = 0
for (let pass = 0; pass < 2; pass += 1) {
  const deltas = []
  for (const f of frames) {
    const exp = ((f.wall - wStream) / 1000) * fps + offset
    const R = pass === 0 ? Math.round(fps * 2) : Math.round(fps * 0.5)
    let best = Infinity
    let bestPos = Math.round(exp)
    for (let p = Math.round(exp) - R; p <= Math.round(exp) + R; p += 1) {
      if (p < 0) continue
      const d = sad(f.sig, clipSig[p % N])
      if (d < best) {
        best = d
        bestPos = p
      }
    }
    f.pos = bestPos
    deltas.push(bestPos - ((f.wall - wStream) / 1000) * fps)
  }
  deltas.sort((a, b) => a - b)
  offset = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0
}
const posAt = (wall) => Math.round(((wall - wStream) / 1000) * fps + offset)
const wallAt = (pos) => wStream + ((pos - offset) / fps) * 1000
/** Clip frame shown by the processed frame nearest before `wall`. */
const posOfWall = (wall) => {
  let best = null
  for (const f of frames)
    if (f.wall <= wall + 1 && (!best || f.wall > best.wall)) best = f
  return best ? best.pos : posAt(wall)
}

// --- geometry --------------------------------------------------------------
const K = ['tl', 'tr', 'br', 'bl']
const pt = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p)
const pts = (q) => K.map((k) => pt(q[k]))
function polyArea(p) {
  let a = 0
  for (let i = 0; i < p.length; i += 1) {
    const u = p[i]
    const v = p[(i + 1) % p.length]
    a += u.x * v.y - v.x * u.y
  }
  return Math.abs(a) / 2
}
function clip(subject, clipPoly) {
  // Sutherland–Hodgman (clipPoly convex, either orientation).
  const sign = Math.sign(
    clipPoly.reduce((s, u, i) => {
      const v = clipPoly[(i + 1) % clipPoly.length]
      return s + (u.x * v.y - v.x * u.y)
    }, 0),
  )
  let out = subject
  for (let i = 0; i < clipPoly.length; i += 1) {
    const a = clipPoly[i]
    const b = clipPoly[(i + 1) % clipPoly.length]
    const inside = (p) =>
      sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= 0
    const inter = (p, q) => {
      const a1 = b.y - a.y
      const b1 = a.x - b.x
      const c1 = a1 * a.x + b1 * a.y
      const a2 = q.y - p.y
      const b2 = p.x - q.x
      const c2 = a2 * p.x + b2 * p.y
      const det = a1 * b2 - a2 * b1
      return { x: (b2 * c1 - b1 * c2) / det, y: (a1 * c2 - a2 * c1) / det }
    }
    const inp = out
    out = []
    for (let j = 0; j < inp.length; j += 1) {
      const p = inp[j]
      const q = inp[(j + 1) % inp.length]
      if (inside(q)) {
        if (!inside(p)) out.push(inter(p, q))
        out.push(q)
      } else if (inside(p)) out.push(inter(p, q))
    }
    if (!out.length) break
  }
  return out
}
/** Share of `target` covered by `q`. */
const cover = (q, target) => {
  const t = pts(target)
  const a = polyArea(t)
  return a > 0 ? polyArea(clip(t, pts(q))) / a : 0
}
const cornerErr = (q, target) => {
  const a = pts(q)
  const b = pts(target)
  return (
    a.reduce((s, p, i) => s + Math.hypot(p.x - b[i].x, p.y - b[i].y), 0) / 4
  )
}
const dist = (a, b) => Math.hypot(pt(a).x - pt(b).x, pt(a).y - pt(b).y)

// The app sees the clip at the video size it got; GT is in clip px.
const firstFrame = frames[0]
const sx = firstFrame ? gt.W / firstFrame.vw : 1
const sy = firstFrame ? gt.H / firstFrame.vh : 1
const toClip = (q) =>
  Object.fromEntries(
    K.map((k) => [k, { x: pt(q[k]).x * sx, y: pt(q[k]).y * sy }]),
  )

// --- score ---------------------------------------------------------------
const holds = gt.segments.filter((s) => s.phase === 'hold')
const targets = []
for (const seg of holds) {
  const mid = gt.frames[Math.floor((seg.start_frame + seg.end_frame) / 2)]
  for (const p of mid.pages)
    if (p.target && !targets.some((t) => t.page === p.page))
      targets.push({ page: p.page, seg })
}
// A target page with no hold was skipped on purpose (single-land-white p37):
// it can only be red (shown missing) or silent.
const skippedPages = (gt.target_pages ?? []).filter(
  (n) => !targets.some((t) => t.page === n),
)
for (const n of skippedPages) targets.push({ page: n, seg: null })
const captures = probe.filter((e) => e.type === 'capture')
const numbers = new Map(
  probe.filter((e) => e.type === 'number').map((e) => [e.sheetId, e]),
)
const alerts = probe.filter((e) => e.type === 'alert')
const keptIds = new Set(kept.map((p) => p.sheetId))

const pageRows = []
const checkAt = new Map() // page -> wall of its ✓
const capRows = []
for (const c of captures) {
  const pos = posOfWall(c.t)
  const fr = gt.frames[((pos % N) + N) % N]
  const seg =
    holds.find((s) => pos >= s.start_frame && pos < s.end_frame) ?? null
  const num = numbers.get(c.sheetId)
  const row = {
    sheetId: c.sheetId,
    spread: c.spread,
    pos,
    phase: fr.phase,
    kept: keptIds.has(c.sheetId),
    numbers: num?.numbers ?? [],
    numberS: num ? num.sinceShot / 1000 : null,
    checkS: seg ? (c.t - wallAt(seg.start_frame)) / 1000 : null,
    pages: [],
  }
  for (const p of c.pages) {
    const q = toClip(p.quad)
    let best = null
    for (const g of fr.pages) {
      const cv = cover(q, g.corners)
      if (!best || cv > best.cover)
        best = {
          page: g.page,
          cover: cv,
          err: cornerErr(q, g.corners),
          target: g.target,
        }
    }
    row.pages.push({ id: p.id, side: p.side, ...best })
    if (
      best &&
      best.cover >= COVER_PAGE &&
      fr.phase === 'hold' &&
      !checkAt.has(best.page)
    )
      checkAt.set(best.page, c.t)
  }
  if (c.spread && fr.pages.length >= 2) {
    const L = fr.pages.find((g) => g.side === 'left')
    const R = fr.pages.find((g) => g.side === 'right')
    if (L && R) {
      const whole = {
        tl: L.corners.tl,
        tr: R.corners.tr,
        br: R.corners.br,
        bl: L.corners.bl,
      }
      row.spreadErr = cornerErr(toClip(c.quad), whole)
      const left = c.pages.find((p) => p.side === 'L')
      if (left) {
        const lq = toClip(left.quad)
        row.gutterErr = [dist(lq.tr, L.corners.tr), dist(lq.br, L.corners.br)]
      }
    }
  }
  capRows.push(row)
}
// Page numbers as read, per page (spread halves in order).
const readOf = new Map()
for (const r of capRows) {
  r.pages.forEach((p, i) => {
    if (!p || p.cover < COVER_PAGE) return
    const n =
      r.numbers.length === r.pages.length
        ? r.numbers[i]
        : r.pages.length === 1
          ? r.numbers[0]
          : undefined
    if (!readOf.has(p.page)) readOf.set(p.page, n ?? null)
  })
}
const redPages = new Map() // page -> first alert wall
for (const a of alerts)
  for (let n = a.from; n <= a.to; n += a.step ?? 1)
    if (!redPages.has(n)) redPages.set(n, a.t)
let falseRed = 0
const falseRedPages = []
for (const [n, t] of redPages) {
  const ck = checkAt.get(n)
  const isTarget = targets.some((x) => x.page === n && x.seg)
  if ((ck !== undefined && ck < t) || !isTarget) {
    // A page that is not one of this clip's targets may still be a real
    // skip (p37 is skipped on purpose in single-land-white) — a skipped
    // target has no hold, so it is not in `targets`.
    const skipped = skippedPages.includes(n)
    if (!skipped) {
      falseRed += 1
      falseRedPages.push(n)
    }
  }
}
for (const t of targets) {
  const ck = checkAt.has(t.page)
  const red = !ck && redPages.has(t.page)
  pageRows.push({
    page: t.page,
    state: ck ? 'check' : red ? 'red' : 'silent',
    read: readOf.get(t.page),
  })
}
const count = (s) => pageRows.filter((r) => r.state === s).length
const readRows = pageRows.filter((r) => r.state === 'check')
// Pages printed without a number (--no-folio 126,127): right when unread.
const noFolio = (opt('--no-folio', '') || '')
  .split(',')
  .filter(Boolean)
  .map(Number)
const truth = (r) => (noFolio.includes(r.page) ? null : r.page)
const right = readRows.filter((r) => (r.read ?? null) === truth(r)).length
const wrong = readRows.filter(
  (r) => r.read !== null && r.read !== undefined && r.read !== r.page,
).length
const median = (a) => {
  const v = a
    .filter((x) => typeof x === 'number' && Number.isFinite(x))
    .sort((x, y) => x - y)
  return v.length ? v[Math.floor(v.length / 2)] : null
}
const max = (a) => {
  const v = a.filter((x) => typeof x === 'number' && Number.isFinite(x))
  return v.length ? Math.max(...v) : null
}
const evalFrames = frames.filter((f) => f.pos >= 0 && f.pos < N)
const fpsMeasured =
  evalFrames.length > 1
    ? (evalFrames.length - 1) /
      ((evalFrames.at(-1).wall - evalFrames[0].wall) / 1000)
    : 0
const pageErrs = capRows.flatMap((r) =>
  r.pages.filter((p) => p && p.cover >= 0.5).map((p) => p.err),
)
const gutterErrs = capRows.flatMap((r) => r.gutterErr ?? [])
const flats = probe.filter((e) => e.type === 'flatten')
const summary = {
  clip: clipName,
  backend: pre.backend,
  threads: pre.threads,
  targets: targets.length,
  check: count('check'),
  red: count('red'),
  silent: count('silent'),
  silentPages: pageRows.filter((r) => r.state === 'silent').map((r) => r.page),
  captures: captures.length,
  capturesInTurn: capRows.filter((r) => r.phase !== 'hold').length,
  duplicates: (() => {
    const ps = capRows
      .filter((r) => r.kept)
      .flatMap((r) =>
        r.pages.filter((p) => p && p.cover >= COVER_PAGE).map((p) => p.page),
      )
    return ps.length - new Set(ps).size
  })(),
  numbersRight: right,
  numbersWrong: wrong,
  numbersUnread: readRows.length - right - wrong,
  wrongPages: readRows
    .filter((r) => r.read !== null && r.read !== undefined && r.read !== r.page)
    .map((r) => `${r.page}→${r.read}`),
  alerts: alerts.map((a) => `${a.from}-${a.to}`),
  falseRed,
  falseRedPages,
  cornerMedian: median(pageErrs),
  cornerMax: max(pageErrs),
  spreadCornerMedian: median(capRows.map((r) => r.spreadErr)),
  gutterMedian: median(gutterErrs),
  gutterMax: max(gutterErrs),
  fps: fpsMeasured,
  inferMsMedian: median(frames.map((f) => f.ms)),
  checkSMedian: median(capRows.map((r) => r.checkS)),
  checkSMax: max(capRows.map((r) => r.checkS)),
  numberSMedian: median(capRows.map((r) => r.numberS)),
  numberSMax: max(capRows.map((r) => r.numberS)),
  flattened: `${flats.filter((f) => f.ok).length}/${flats.length}`,
  numberReadMs: median(
    probe.filter((e) => e.type === 'numberLines').map((e) => e.ms),
  ),
  logs: [...new Set(logs)].slice(0, 10),
  video: videoPath,
}
fs.writeFileSync(
  path.join(outDir, 'probe.json'),
  JSON.stringify(
    probe.map((e) => (e.type === 'frame' ? { ...e, sig: undefined } : e)),
  ),
)
fs.writeFileSync(
  path.join(outDir, 'result.json'),
  JSON.stringify({ summary, pageRows, capRows, shots }, null, 2),
)
console.log(JSON.stringify(summary, null, 1))
