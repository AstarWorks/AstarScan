#!/usr/bin/env node
/**
 * Book-clip check of the real app: plays a book clip (book-clips/clips,
 * converted to MJPEG) through Chromium's fake camera into the running web
 * app (apps/web index.vue, unchanged scan path) and scores it against the
 * clip's ground truth.
 *
 *   NODE_PATH=<node_modules with playwright> node book-e2e.mjs \
 *     <app-url> <clip-name> <out-dir> [--loops 2] [--eval-loop 2]
 *     [--viewport 390x844] [--record] [--clips <dir>]
 *
 * The app reports every sampled frame (quad + a 32×18 grey signature),
 * every ✓ / miss and the saved pages' origins to `window.__astarProbe`
 * (a no-op hook in index.vue). The signature is matched against the clip's
 * own frames to find which clip frame the fake camera delivered, so the
 * scores do not depend on guessing when the stream started.
 *
 * What the app captures: ONE quad per frame (doc-detector → corner snap);
 * it has no notion of a two-page spread. A ✓ quad is therefore scored
 * against every target page of its hold AND against the whole spread
 * (left page tl/bl + right page tr/br), and counts for every target page
 * it covers (≥ COVER_PAGE of the page's area).
 *
 * Per GT target page (per hold segment of the evaluated loop):
 *   check   a ✓ whose frame is in the segment covers the page
 *   red     no such ✓, and a red "まだ撮れていません" miss overlaps it
 *   silent  neither — the page went by without any sign
 * Corner error: mean distance of the 4 corners to the best-matching
 * target (page or spread), median over hold frames with a detection, and
 * over the ✓ frames. Saved pages: a saved image shows the whole paper of
 * its target when the crop (quad + the app's 3 % margin) covers
 * ≥ COVER_FULL of it.
 */
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Not a repo dependency: resolve a preinstalled Playwright via NODE_PATH.
const { chromium } = createRequire(import.meta.url)('playwright')
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const [url, clipName, outDir] = args
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d)
const loops = Number(opt('--loops', '2'))
const evalLoop = Number(opt('--eval-loop', String(loops)))
const [vw, vh] = opt('--viewport', '390x844').split('x').map(Number)
const record = args.includes('--record')
const clipsDir = opt('--clips', path.join(__dirname, 'clips'))
if (!url || !clipName || !outDir) {
  console.error('usage: book-e2e.mjs <app-url> <clip-name> <out-dir> [...]')
  process.exit(2)
}
const COVER_PAGE = 0.9
const COVER_FULL = 0.98
const CROP_MARGIN = 0.03 // rotateAndCropQuad(…, 0.03) in index.vue

fs.mkdirSync(outDir, { recursive: true })
const gt = JSON.parse(
  fs.readFileSync(path.join(clipsDir, `${clipName}.gt.json`), 'utf8'),
)
const fps = gt.fps
const N = gt.frames.length
const clipS = N / fps

// --- clip → MJPEG for the fake camera, and per-frame signatures ---------
const mp4 = path.join(clipsDir, `${clipName}.mp4`)
const mjpeg = path.join(outDir, `${clipName}.mjpeg`)
if (!fs.existsSync(mjpeg))
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-q:v', '3', mjpeg])
const SW = 32
const SH = 18
const raw = execFileSync(
  'ffmpeg',
  ['-loglevel', 'error', '-i', mp4, '-vf', `scale=${SW}:${SH}:flags=area,format=gray`, '-f', 'rawvideo', '-'],
  { maxBuffer: 1 << 28 },
)
const clipSig = []
for (let i = 0; i < N; i += 1)
  clipSig.push(raw.subarray(i * SW * SH, (i + 1) * SW * SH))

// --- run the app ----------------------------------------------------------
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
    ? { recordVideo: { dir: path.join(outDir, 'video'), size: { width: vw, height: vh } } }
    : {}),
})
const page = await context.newPage()
const logs = []
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'warning' || m.type() === 'error')
    logs.push(`${m.type()}: ${m.text()}`)
})
// The app asks for 1920×1080 (ideal). A phone held upright still returns
// 1080×1920 frames (the constraint is matched against the landscape sensor
// mode and the frames are rotated), but Chromium's fake camera matches it
// against the file and centre-crops a portrait clip to 1080×1080. Swap the
// ideal width / height for portrait clips so the app sees what a phone
// would deliver.
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
  window.__astarProbe = (e) => window.__probe.push(e)
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
              wall: performance.now(),
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
const wStream = await page.evaluate(() => performance.now())

// Screenshot each ✓ / red chip of the evaluated loop as it appears.
const shots = []
const endMs = loops * clipS * 1000 + 500
let seen = 0
for (;;) {
  const now = (await page.evaluate(() => performance.now())) - wStream
  if (now >= endMs) break
  const n = await page.evaluate(() => window.__chips.length)
  if (n > seen) {
    if (now >= (evalLoop - 1) * clipS * 1000 && now < evalLoop * clipS * 1000) {
      const kind = await page.evaluate((i) => window.__chips[i].kind, n - 1)
      const p = path.join(outDir, `chip-${String(n).padStart(2, '0')}-${kind}.png`)
      await page.screenshot({ path: p })
      shots.push({ path: p, kind, wall: now + wStream })
    }
    seen = n
  }
  await page.waitForTimeout(60)
}
await page.getByRole('button', { name: '停止' }).click()
await page
  .waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].some((b) =>
        /停止|処理中/.test(b.textContent ?? ''),
      ),
    null,
    { timeout: 180000 },
  )
  .catch(() => {})
await page.waitForFunction(() => window.__probe.some((e) => e.type === 'pages'), null, {
  timeout: 180000,
})
await page.waitForTimeout(800)
await page.evaluate(() => {
  const d = document.querySelector('details.strip-drawer')
  if (d) d.open = true
})
await page.waitForTimeout(300)
await page.screenshot({ path: path.join(outDir, 'done.png'), fullPage: true })
const probe = await page.evaluate(() => window.__probe)
const savedSrc = await page.evaluate(() =>
  [...document.querySelectorAll('.strip__thumb img')].map((i) => i.src),
)
const videoPath = record ? await page.video()?.path() : null
await context.close()
await browser.close()

// --- sync: which clip frame did each sampled frame show -------------------
const frames = probe.filter((e) => e.type === 'frame')
const sad = (a, b) => {
  let s = 0
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i])
  return s
}
// Absolute clip position (frames since stream start, not wrapped).
let offset = 0
for (let pass = 0; pass < 2; pass += 1) {
  const deltas = []
  for (const f of frames) {
    if (!f.sig?.length) continue
    const exp = ((f.wall - wStream) / 1000) * fps + offset
    let best = Infinity
    let bestPos = Math.round(exp)
    const R = pass === 0 ? Math.round(fps * 1.5) : Math.round(fps * 0.5)
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
// Stills: their event fires after the still was detected (queued behind
// the frame loop), so search back up to 4 s from it.
for (const e of probe) {
  if (e.type !== 'photo' || !e.sig?.length) continue
  const exp = Math.round(((e.wall - wStream) / 1000) * fps + offset)
  let best = Infinity
  for (let p = exp - 4 * fps; p <= exp + Math.round(fps * 0.3); p += 1) {
    if (p < 0) continue
    const d = sad(e.sig, clipSig[p % N])
    if (d < best) {
      best = d
      e.pos = p
    }
  }
}
const byIdx = new Map(frames.map((f) => [f.idx, f]))
const scanT0 = (() => {
  // wall time of scan t = 0 (frames carry both).
  const f = frames.find((x) => typeof x.t === 'number')
  return f ? f.wall - f.t * 1000 : wStream
})()
/** Frame-log entry closest to scan time t. */
const frameAtT = (t) => {
  let best = null
  for (const f of frames)
    if (!best || Math.abs(f.t - t) < Math.abs(best.t - t)) best = f
  return best
}
const loopOf = (pos) => Math.floor(pos / N) + 1

// --- geometry --------------------------------------------------------------
const K = ['tl', 'tr', 'br', 'bl']
const pt = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : p)
const quadPts = (q) => K.map((k) => pt(q[k]))
function polyArea(p) {
  let a = 0
  for (let i = 0; i < p.length; i += 1) {
    const u = p[i]
    const v = p[(i + 1) % p.length]
    a += u.x * v.y - v.x * u.y
  }
  return Math.abs(a) / 2
}
function hull(points) {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lo = []
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop()
    lo.push(q)
  }
  const up = []
  for (const q of p.reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop()
    up.push(q)
  }
  return lo.slice(0, -1).concat(up.slice(0, -1))
}
function clip(subject, clipPoly) {
  let signed = 0
  for (let i = 0; i < clipPoly.length; i += 1) {
    const u = clipPoly[i]
    const v = clipPoly[(i + 1) % clipPoly.length]
    signed += u.x * v.y - v.x * u.y
  }
  const c = signed < 0 ? [...clipPoly].reverse() : clipPoly
  let out = subject
  for (let i = 0; i < c.length && out.length; i += 1) {
    const a = c[i]
    const b = c[(i + 1) % c.length]
    const side = (p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    const input = out
    out = []
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j]
      const q = input[(j + 1) % input.length]
      const sp = side(p)
      const sq = side(q)
      if (sp >= 0) out.push(p)
      if (sp >= 0 !== sq >= 0) {
        const t = sp / (sp - sq)
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      }
    }
  }
  return out
}
/** Share of polygon `target` inside the (convex hull of) quad `q`. */
const cover = (q, target) => {
  const a = polyArea(target)
  return a > 0 ? polyArea(clip(target, hull(q))) / a : 0
}
const expand = (pts, m) => {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  return pts.map((p) => ({ x: cx + (p.x - cx) * (1 + 2 * m), y: cy + (p.y - cy) * (1 + 2 * m) }))
}
const cornerErr = (q, t) =>
  q.reduce((s, p, i) => s + Math.hypot(p.x - t[i].x, p.y - t[i].y), 0) / 4
const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : null
}
/** Page outline (curved edges) as a polygon, clipped to the frame. */
const outline = (pg) => {
  const top = pg.edge_top?.map(pt) ?? [pt(pg.corners.tl), pt(pg.corners.tr)]
  const bot = pg.edge_bottom?.map(pt) ?? [pt(pg.corners.bl), pt(pg.corners.br)]
  return [...top, ...[...bot].reverse()]
}
const framePoly = [
  { x: 0, y: 0 },
  { x: gt.W, y: 0 },
  { x: gt.W, y: gt.H },
  { x: 0, y: gt.H },
]

/** Targets of GT frame `fi`: each target page, plus the spread. */
function targetsOf(fi) {
  const g = gt.frames[fi]
  const pages = g.pages.filter((p) => p.target)
  const out = pages.map((p) => ({
    kind: 'page',
    pages: [p.page],
    corners: quadPts(p.corners),
    poly: clip(outline(p), framePoly),
  }))
  const left = pages.find((p) => p.side === 'left')
  const right = pages.find((p) => p.side === 'right')
  if (left && right)
    out.push({
      kind: 'spread',
      pages: [left.page, right.page],
      corners: [pt(left.corners.tl), pt(right.corners.tr), pt(right.corners.br), pt(left.corners.bl)],
      poly: clip(hull([...outline(left), ...outline(right)]), framePoly),
    })
  return out
}

/** Best-matching target of a quad (min mean corner error). */
function match(q, fi) {
  const qp = quadPts(q)
  let best = null
  for (const t of targetsOf(fi)) {
    const e = cornerErr(qp, t.corners)
    if (!best || e < best.err) best = { ...t, err: e }
  }
  return best
}

// --- segments of the evaluated loop ---------------------------------------
const segs = gt.segments
  .map((s, i) => ({ ...s, i }))
  .filter((s) => s.phase === 'hold')
  .map((s) => {
    const mid = Math.floor((s.start_frame + s.end_frame) / 2)
    const pages = gt.frames[mid].pages.filter((p) => p.target).map((p) => p.page)
    return {
      ...s,
      pages,
      from: (evalLoop - 1) * N + s.start_frame,
      to: (evalLoop - 1) * N + s.end_frame,
    }
  })
const segOfPos = (pos) => segs.find((s) => pos >= s.from && pos < s.to) ?? null

// ✓ events
const posOfT = (t) => frameAtT(t)?.pos ?? null
const checks = probe
  .filter((e) => e.type === 'captured')
  .map((e) => {
    const f = byIdx.get(e.bestIdx) ?? frameAtT(e.bestT)
    const pos = f?.pos ?? null
    const fi = pos === null ? null : pos % N
    const seg = pos === null ? null : segOfPos(pos)
    const m = fi === null || !e.quad ? null : match(e.quad, fi)
    const covered =
      fi === null || !e.quad
        ? []
        : targetsOf(fi)
            .filter((t) => t.kind === 'page' && cover(quadPts(e.quad), t.poly) >= COVER_PAGE)
            .map((t) => t.pages[0])
    return {
      pageNo: e.pageNo,
      pos,
      loop: pos === null ? null : loopOf(pos),
      frame: fi,
      phase: fi === null ? null : gt.frames[fi].phase,
      seg: seg?.i ?? null,
      matched: m?.kind ?? null,
      matchedPages: m?.pages ?? [],
      err: m ? +m.err.toFixed(1) : null,
      covered,
    }
  })
const misses = probe
  .filter((e) => e.type === 'missed')
  .map((e) => ({ ...e, fromPos: posOfT(e.startT), toPos: posOfT(e.endT) }))

const rows = []
for (const s of segs)
  for (const pg of s.pages) {
    const ok = checks.some((c) => c.seg === s.i && c.covered.includes(pg))
    const red =
      !ok &&
      misses.some(
        (m) => m.fromPos !== null && m.toPos !== null && m.fromPos < s.to && m.toPos >= s.from,
      )
    rows.push({ seg: s.i, page: pg, result: ok ? 'check' : red ? 'red' : 'silent' })
  }

// Corner error over every detected hold frame of the evaluated loop.
const holdErr = []
const holdKinds = {}
let holdFrames = 0
let holdDetected = 0
for (const f of frames) {
  if (f.pos === undefined || loopOf(f.pos) !== evalLoop) continue
  const fi = f.pos % N
  if (gt.frames[fi].phase !== 'hold') continue
  holdFrames += 1
  if (!f.quad) continue
  holdDetected += 1
  const m = match(f.quad, fi)
  if (!m) continue
  holdErr.push(m.err)
  holdKinds[m.kind] = (holdKinds[m.kind] ?? 0) + 1
}

// Saved pages: which crop each came from.
const pagesEv = [...probe].reverse().find((e) => e.type === 'pages')?.pages ?? []
const photoEvs = probe.filter((e) => e.type === 'photo')
const shotEvs = probe.filter((e) => e.type === 'shot')
const photoOf = new Map()
{
  let k = 0
  for (const s of shotEvs)
    if (s.source === 'photo') photoOf.set(s.pageNo, photoEvs[k++] ?? null)
}
const saved = pagesEv.map((p, i) => {
  let quad = null
  let pos = null
  let source = null
  if (p.livePageNo !== null) {
    const c = probe.find((e) => e.type === 'captured' && e.pageNo === p.livePageNo)
    const ph = photoOf.get(p.livePageNo)
    if (ph) {
      const sx = gt.W / ph.w
      const sy = gt.H / ph.h
      quad = Object.fromEntries(K.map((k) => [k, { x: ph.quad[k].x * sx, y: ph.quad[k].y * sy }]))
      pos = ph.pos ?? null
      source = 'photo'
    } else if (c) {
      quad = c.quad
      pos = (byIdx.get(c.bestIdx) ?? frameAtT(c.bestT))?.pos ?? null
      source = 'video'
    }
  } else if (p.clusterKey !== null) {
    const f = byIdx.get(p.clusterKey)
    quad = f?.quad ?? null
    pos = f?.pos ?? null
    source = 'cluster'
  }
  const fi = pos === null ? null : pos % N
  const check =
    p.livePageNo !== null ? checks.find((c) => c.pageNo === p.livePageNo) : null
  let full = false
  let best = null
  if (quad && fi !== null) {
    const crop = expand(quadPts(quad), CROP_MARGIN)
    for (const t of targetsOf(fi)) {
      const cv = cover(crop, t.poly)
      // Prefer the largest target fully inside; else the best-covered.
      const score = cv >= COVER_FULL ? 2 + t.pages.length : cv
      if (!best || score > best.score) best = { kind: t.kind, pages: t.pages, cover: cv, score }
    }
    full = !!best && best.cover >= COVER_FULL
  }
  return {
    n: i + 1,
    id: p.id,
    source,
    loop: pos === null ? null : loopOf(pos),
    frame: fi,
    phase: fi === null ? null : gt.frames[fi].phase,
    target: best ? { kind: best.kind, pages: best.pages, cover: +best.cover.toFixed(3) } : null,
    full,
    // Live page whose saved image shows another page than its ✓ did.
    checkPages: check?.matchedPages ?? null,
    quad,
  }
})
for (const s of saved)
  s.sameAsCheck =
    s.checkPages === null || !s.target
      ? null
      : s.target.pages.some((pg) => s.checkPages.includes(pg))
const savedFiles = []
savedSrc.forEach((src, i) => {
  const m = /^data:image\/(\w+);base64,(.*)$/.exec(src)
  if (!m) return
  const p = path.join(outDir, `page-${String(i + 1).padStart(2, '0')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
  fs.writeFileSync(p, Buffer.from(m[2], 'base64'))
  savedFiles.push(p)
})

// --- pictures to look at: ✓ frame with GT (blue) vs app quad (green), and
// a sheet of the saved pages of the evaluated loop ------------------------
const { Canvas, loadImage } = createRequire(import.meta.url)('@napi-rs/canvas')
async function clipFrame(fi) {
  const png = execFileSync(
    'ffmpeg',
    ['-loglevel', 'error', '-i', mp4, '-vf', `select=eq(n\\,${fi})`, '-vframes', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
    { maxBuffer: 1 << 26 },
  )
  return loadImage(png)
}
const drawPoly = (ctx, pts, color, w) => {
  ctx.strokeStyle = color
  ctx.lineWidth = w
  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.closePath()
  ctx.stroke()
}
const overlays = []
for (const c of checks.filter((x) => x.loop === evalLoop && x.frame !== null)) {
  const ev = probe.find((e) => e.type === 'captured' && e.pageNo === c.pageNo)
  const img = await clipFrame(c.frame)
  const s = 720 / Math.max(img.width, img.height)
  const cv = new Canvas(Math.round(img.width * s), Math.round(img.height * s))
  const ctx = cv.getContext('2d')
  ctx.drawImage(img, 0, 0, cv.width, cv.height)
  ctx.scale(s, s)
  for (const pg of gt.frames[c.frame].pages.filter((p) => p.target))
    drawPoly(ctx, outline(pg), '#3b82f6', 4 / s)
  if (ev?.quad) drawPoly(ctx, quadPts(ev.quad), '#22c55e', 5 / s)
  const p = path.join(outDir, `check-${String(c.pageNo).padStart(2, '0')}-overlay.jpg`)
  fs.writeFileSync(p, cv.toBuffer('image/jpeg', 85))
  overlays.push(p)
}
{
  const items = saved
    .map((s, i) => ({ s, file: savedFiles[i] }))
    .filter((x) => x.file && x.s.loop === evalLoop)
  if (items.length) {
    const cell = 240
    const cols = Math.min(6, items.length)
    const rowsN = Math.ceil(items.length / cols)
    const sheet = new Canvas(cols * cell, rowsN * (cell + 28))
    const ctx = sheet.getContext('2d')
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    for (let i = 0; i < items.length; i += 1) {
      const { s, file } = items[i]
      const img = await loadImage(fs.readFileSync(file))
      const k = Math.min((cell - 8) / img.width, (cell - 8) / img.height)
      const x = (i % cols) * cell
      const y = Math.floor(i / cols) * (cell + 28)
      ctx.drawImage(img, x + (cell - img.width * k) / 2, y + 4, img.width * k, img.height * k)
      ctx.fillStyle = s.full ? '#166534' : '#b91c1c'
      ctx.font = '15px sans-serif'
      const what = s.target ? `${s.target.kind} p${s.target.pages.join('+')} ${Math.round(s.target.cover * 100)}%` : `(${s.phase ?? '?'})`
      ctx.fillText(`#${s.n} ${s.full ? 'whole' : 'cut'} ${what}`, x + 6, y + cell + 18)
    }
    fs.writeFileSync(path.join(outDir, 'saved-sheet.jpg'), sheet.toBuffer('image/jpeg', 85))
  }
}

const loopChecks = checks.filter((c) => c.loop === evalLoop)
const loopSaved = saved.filter((s) => s.loop === evalLoop)
const summary = {
  clip: clipName,
  mode: gt.mode,
  evalLoop,
  targetPages: rows.length,
  check: rows.filter((r) => r.result === 'check').length,
  red: rows.filter((r) => r.result === 'red').length,
  silent: rows.filter((r) => r.result === 'silent').length,
  checkEvents: loopChecks.length,
  checkMatched: loopChecks.reduce((o, c) => ({ ...o, [c.matched]: (o[c.matched] ?? 0) + 1 }), {}),
  checksInTurn: loopChecks.filter((c) => c.phase === 'turn').length,
  redEvents: misses.filter((m) => m.fromPos !== null && loopOf(m.fromPos) === evalLoop).length,
  errHoldMedian: holdErr.length ? +median(holdErr).toFixed(1) : null,
  errCheckMedian: loopChecks.length
    ? +median(loopChecks.map((c) => c.err).filter((x) => x !== null)).toFixed(1)
    : null,
  holdDetected: `${holdDetected}/${holdFrames}`,
  holdMatched: holdKinds,
  saved: loopSaved.length,
  savedFull: loopSaved.filter((s) => s.full).length,
  savedOtherPageThanCheck: loopSaved.filter((s) => s.sameAsCheck === false).length,
  savedPages: [...new Set(loopSaved.filter((s) => s.full).flatMap((s) => s.target.pages))]
    .sort((a, b) => a - b),
  savedAllLoops: saved.length,
  videoSize: frames[0] ? `${frames[0].w}x${frames[0].h}` : null,
  syncOffsetFrames: +offset.toFixed(1),
  sampledFrames: frames.length,
  detectMsMedian: median(frames.map((f) => f.detectMs ?? 0)),
  frameMsMedian: median(probe.filter((e) => e.type === 'frameDone').map((e) => e.ms)),
  fpsSampled: +(frames.length / ((frames.at(-1)?.wall - frames[0]?.wall) / 1000 || 1)).toFixed(2),
}
const result = {
  url,
  summary,
  rows,
  checks,
  misses: misses.map(({ startT, endT, fromPos, toPos }) => ({ startT, endT, fromPos, toPos })),
  saved,
  savedFiles,
  screenshots: shots,
  scanT0,
  logs: logs.slice(0, 500),
}
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2))
fs.writeFileSync(
  path.join(outDir, 'probe.json'),
  JSON.stringify(probe.map(({ sig: _sig, ...e }) => e)),
)
if (videoPath) {
  const mp4Out = path.join(outDir, `${clipName}-screen.mp4`)
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', videoPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-preset', 'veryfast', mp4Out,
  ])
  summary.recording = mp4Out
}
console.log(JSON.stringify(summary, null, 2))
