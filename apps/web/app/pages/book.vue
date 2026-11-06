<script setup lang="ts">
/**
 * 本の撮影 — the capture screen and result list agreed with the client
 * (docs/ux/ideal-capture.html): the frame follows the paper (orange until
 * the whole book is in view and still, then a green line runs once round it
 * and the page is taken by itself), ✓ + beep + vibration at once, the page
 * numbers shortly after; a skipped page is red at once; one result row per
 * page (spreads split at the gutter), PDF / Markdown / 書類置場.
 *
 * Engine: services/book/book-capture.ts. `?debug` shows the model backend
 * (WebGPU / WASM + threads) and the frame rate; `?backend=wasm` skips WebGPU.
 */
import { jsPDF } from 'jspdf'
import type { Quad } from '@astarworks/scan-core'
import type { BookStripItem } from '@astarworks/scan-core/pipeline'

import {
  BookCapture,
  type BookPage,
  type BookState,
} from '~/services/book/book-capture'
import { pageRangeLabel } from '@astarworks/scan-core/pipeline'
import { initOcr, runOcr } from '~/services/ocr-service'

type Screen = 'start' | 'loading' | 'camera' | 'list'

const route = useRoute()
const debug = computed(() => route.query.debug !== undefined)
const preferWasm = route.query.backend === 'wasm'
const isolated = typeof crossOriginIsolated === 'boolean' && crossOriginIsolated

const screen = ref<Screen>('start')
const errorText = ref('')
const videoRef = ref<HTMLVideoElement | null>(null)
const tick = ref(0)
let engine: BookCapture | null = null
let stream: MediaStream | null = null

/** Snapshot of the engine's state (a fresh object per change, so Vue re-renders). */
const st = shallowRef<BookState | null>(null)
const vw = ref(1920)
const vh = ref(1080)

function bump(): void {
  st.value = engine ? { ...engine.state } : null
  tick.value++
}

// --- camera (iOS Safari survival kit: one stream, re-open after hide) ----

async function openStream(): Promise<MediaStream> {
  const ask = () =>
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    })
  try {
    return await ask()
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === 'NotReadableError' || name === 'AbortError') {
      await new Promise((r) => setTimeout(r, 500))
      return ask()
    }
    throw err
  }
}

function cameraErrorText(err: unknown): string {
  const name = (err as { name?: string }).name
  if (name === 'NotAllowedError')
    return 'カメラの使用が許可されていません。ブラウザの設定で許可してください。'
  if (name === 'NotFoundError') return 'カメラが見つかりません。'
  return `カメラを開けませんでした（${name ?? String(err)}）`
}

async function attach(): Promise<void> {
  const video = videoRef.value
  if (!video) return
  stream?.getTracks().forEach((t) => t.stop())
  stream = await openStream()
  const track = stream.getVideoTracks()[0]
  if (track)
    track.onended = () => {
      if (screen.value === 'camera') void reopen()
    }
  video.srcObject = stream
  await video.play()
  vw.value = video.videoWidth || 1920
  vh.value = video.videoHeight || 1080
  video.onresize = () => {
    vw.value = video.videoWidth || vw.value
    vh.value = video.videoHeight || vh.value
  }
}

async function reopen(): Promise<void> {
  try {
    await attach()
    if (engine && videoRef.value) engine.start(videoRef.value)
  } catch (err) {
    errorText.value = cameraErrorText(err)
  }
}

function releaseCamera(): void {
  engine?.stop()
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  if (videoRef.value) videoRef.value.srcObject = null
}

function onVisibility(): void {
  if (screen.value !== 'camera') return
  if (document.visibilityState === 'hidden') releaseCamera()
  else void reopen()
}

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', releaseCamera)
  // Eval hook: the book-clip check reads the pages through this.
  ;(globalThis as { __astarBook?: unknown }).__astarBook = {
    pages: () =>
      engine?.orderedPages().map((p) => ({
        id: p.id,
        sheetId: p.sheetId,
        side: p.side,
        number: p.read.state === 'read' ? p.read.number : null,
        flattened: p.flattened,
        flattenWhy: p.flattenWhy,
        quad: p.quad,
        w: p.canvas.width,
        h: p.canvas.height,
      })) ?? [],
    image: (id: string, which: 'page' | 'straight' = 'page') => {
      const p = engine?.pages.find((x) => x.id === id)
      return p
        ? (which === 'straight' ? p.straight : p.canvas).toDataURL(
            'image/jpeg',
            0.85,
          )
        : null
    },
    finish: () => finish(),
    /** Load the models before the camera opens (the check starts the clip warm). */
    preload: async () => {
      engine ??= new BookCapture(bump, preferWasm ? 'wasm' : 'webgpu')
      if (!engine.state.ready) await engine.load()
      await engine.whenNumbersReady()
      return { backend: engine.state.backend, threads: engine.state.threads }
    },
    probeState: () => engine?.state ?? null,
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', releaseCamera)
  releaseCamera()
  engine?.dispose()
})

async function begin(): Promise<void> {
  errorText.value = ''
  screen.value = 'loading'
  try {
    if (!engine) {
      engine = new BookCapture(bump, preferWasm ? 'wasm' : 'webgpu')
    }
    // Camera first (it needs this tap), the models while it opens.
    const models = engine.state.ready ? Promise.resolve() : engine.load()
    screen.value = 'camera'
    await nextTick()
    await attach()
    await models
    engine.start(videoRef.value!)
  } catch (err) {
    screen.value = 'start'
    errorText.value =
      err instanceof DOMException || (err as { name?: string }).name
        ? cameraErrorText(err)
        : `準備できませんでした: ${String(err)}`
    releaseCamera()
  }
}

function finish(): void {
  releaseCamera()
  screen.value = 'list'
  selected.value = null
  bump()
}

function backToCamera(): void {
  void begin()
}

// --- camera overlay -------------------------------------------------------

const quadPath = (q: Quad) =>
  `M${q.tl.x.toFixed(1)} ${q.tl.y.toFixed(1)} L${q.tr.x.toFixed(1)} ${q.tr.y.toFixed(1)} L${q.br.x.toFixed(1)} ${q.br.y.toFixed(1)} L${q.bl.x.toFixed(1)} ${q.bl.y.toFixed(1)} Z`

const unit = computed(() => Math.max(vw.value, vh.value) / 390)

/** The four corner brackets of the mock (20 px arms on a 390 px screen). */
function brackets(q: Quad): string {
  const pts = [q.tl, q.tr, q.br, q.bl]
  const arm = 20 * unit.value
  return pts
    .map((c, i) => {
      const n = pts[(i + 1) % 4]!
      const m = pts[(i + 3) % 4]!
      const u = (d: { x: number; y: number }) => {
        const dx = d.x - c.x
        const dy = d.y - c.y
        const l = Math.hypot(dx, dy) || 1
        return `${(c.x + (dx / l) * arm).toFixed(1)} ${(c.y + (dy / l) * arm).toFixed(1)}`
      }
      return `M${u(n)} L${c.x.toFixed(1)} ${c.y.toFixed(1)} L${u(m)}`
    })
    .join(' ')
}

const lastNoNumber = computed(() => {
  const s = st.value
  const last = engine?.sheets[engine.sheets.length - 1]
  return !!s && !!last && last.pages.every((p) => p.state === 'none')
})

const frameColor = computed(() => {
  const s = st.value
  if (!s) return '#f59e0b'
  if (s.tone === 'dup') return '#9ca3af'
  if (s.tone === 'done') return lastNoNumber.value ? '#9ca3af' : '#22c55e'
  if (s.tone === 'hold' || s.tone === 'sweep') return '#22c55e'
  return '#f59e0b'
})

const pillBg = computed(() => {
  const s = st.value
  if (!s) return '#b45309'
  return s.tone === 'hold' || s.tone === 'sweep' ? '#16a34a' : '#b45309'
})

const now = ref(performance.now())
let raf = 0
function animate(): void {
  now.value = performance.now()
  raf = requestAnimationFrame(animate)
}
onMounted(() => (raf = requestAnimationFrame(animate)))
onBeforeUnmount(() => cancelAnimationFrame(raf))

const flashOpacity = computed(() => {
  const s = st.value
  if (!s || !s.flashAt) return 0
  const dt = now.value - s.flashAt
  return dt >= 0 && dt < 180 ? (1 - dt / 180) * 0.85 : 0
})

const banner = computed(() => {
  const s = st.value
  const b = s?.banner
  if (!b) return null
  // Green / grey fade after 4 s; red stays until the next message.
  if (b.tone !== 'bad' && now.value - b.at > 4000) return null
  return b
})

// --- strip and counts --------------------------------------------------------

const thumbs = new Map<string, string>()
function thumbOf(p: BookPage): string {
  const key = `${p.id}:${p.flattened ? 1 : 0}`
  let t = thumbs.get(key)
  if (!t) {
    const c = document.createElement('canvas')
    const s = 96 / Math.max(p.canvas.width, p.canvas.height)
    c.width = Math.max(1, Math.round(p.canvas.width * s))
    c.height = Math.max(1, Math.round(p.canvas.height * s))
    c.getContext('2d')?.drawImage(p.canvas, 0, 0, c.width, c.height)
    t = c.toDataURL('image/jpeg', 0.7)
    thumbs.set(key, t)
  }
  return t
}

function sheetPages(id: string): BookPage[] {
  void tick.value
  const ps = engine?.pages.filter((p) => p.sheetId === id) ?? []
  return [...ps].sort(
    (a, b) => (a.side === 'R' ? 1 : 0) - (b.side === 'R' ? 1 : 0),
  )
}

function itemLabel(it: BookStripItem): string {
  if (it.kind === 'gap') return pageRangeLabel(it.from, it.to, it.step)
  if (it.state === 'pending') return '…'
  if (it.state === 'nonum') return '番号なし'
  const ns = it.numbers.filter((n): n is number => n !== null)
  return ns.length === 2 ? `${ns[0]}・${ns[1]}` : String(ns[0] ?? '')
}

const stripRef = ref<HTMLElement | null>(null)
watch(
  () => st.value?.coverage.items.length,
  async () => {
    await nextTick()
    const el = stripRef.value
    if (el) el.scrollLeft = el.scrollWidth
  },
)

const pageCount = computed(() => st.value?.coverage.pageCount ?? 0)
const gapCount = computed(
  () =>
    st.value?.coverage.gaps.reduce(
      (n, g) => n + (g.to - g.from) / g.step + 1,
      0,
    ) ?? 0,
)

// --- list ---------------------------------------------------------------------

type ListRow = { kind: 'page'; page: BookPage } | { kind: 'gap'; label: string }

const listRows = computed<ListRow[]>(() => {
  void tick.value
  if (!engine) return []
  const rows: ListRow[] = []
  const pages = engine.orderedPages()
  for (const it of engine.state.coverage.items) {
    if (it.kind === 'gap')
      rows.push({ kind: 'gap', label: pageRangeLabel(it.from, it.to, it.step) })
    else
      for (const p of pages)
        if (p.sheetId === it.sheetId) rows.push({ kind: 'page', page: p })
  }
  return rows
})

const selected = ref<BookPage | null>(null)
const showStraight = ref(false)
const selectedUrl = computed(() => {
  void tick.value
  const p = selected.value
  if (!p) return ''
  return (showStraight.value ? p.straight : p.canvas).toDataURL(
    'image/jpeg',
    0.85,
  )
})

function pageLabel(p: BookPage): string {
  return p.read.state === 'read' && p.read.number !== undefined
    ? `${p.read.number}`
    : '（番号なし）'
}

function removeSelected(): void {
  const p = selected.value
  if (!p || !engine) return
  engine.removePage(p.id)
  selected.value = null
}

const busy = ref('')
const savedPdf = ref(false)
const savedMd = ref(false)
const saveError = ref('')

function stamp(): string {
  const d = new Date()
  const z = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`
}

async function savePdf(): Promise<void> {
  if (!engine || busy.value) return
  busy.value = 'pdf'
  saveError.value = ''
  try {
    const pages = engine.orderedPages()
    let pdf: jsPDF | null = null
    for (const p of pages) {
      const w = p.canvas.width
      const h = p.canvas.height
      const fmt: [number, number] = [w * 0.24, h * 0.24] // ~ 300 dpi → mm-ish points
      if (!pdf)
        pdf = new jsPDF({
          unit: 'pt',
          format: fmt,
          orientation: w > h ? 'landscape' : 'portrait',
        })
      else pdf.addPage(fmt, w > h ? 'landscape' : 'portrait')
      pdf.addImage(
        p.canvas.toDataURL('image/jpeg', 0.85),
        'JPEG',
        0,
        0,
        fmt[0],
        fmt[1],
      )
    }
    pdf?.save(`astarscan-book-${stamp()}.pdf`)
    savedPdf.value = true
  } catch (err) {
    saveError.value = `PDF を作れませんでした: ${String(err)}`
  } finally {
    busy.value = ''
  }
}

const mdProgress = ref('')
async function saveMarkdown(): Promise<void> {
  if (!engine || busy.value) return
  busy.value = 'md'
  saveError.value = ''
  try {
    mdProgress.value = '文字認識の準備中…'
    await initOcr(
      (p) => (mdProgress.value = `${p.stage} ${Math.round(p.percent)}%`),
    )
    const pages = engine.orderedPages()
    const parts: string[] = []
    for (const [i, p] of pages.entries()) {
      mdProgress.value = `文字を読んでいます ${i + 1} / ${pages.length}`
      const r = await runOcr(p.canvas.toDataURL('image/jpeg', 0.9))
      const head =
        p.read.state === 'read' && p.read.number !== undefined
          ? `## p. ${p.read.number}`
          : `## （番号なし ${i + 1} 枚目）`
      parts.push(`${head}\n\n${r.text.trim()}\n`)
    }
    const blob = new Blob([`# 撮影した本\n\n${parts.join('\n')}`], {
      type: 'text/markdown',
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `astarscan-book-${stamp()}.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    savedMd.value = true
  } catch (err) {
    saveError.value = `Markdown を作れませんでした: ${String(err)}`
  } finally {
    busy.value = ''
    mdProgress.value = ''
  }
}

// 書類置場 (AstarManagement POST /api/v1/book-captures, as the Android app).
const ASTAR_TARGET_KEY = 'astarscan.astarTarget'
function loadTarget(): { server: string; token: string; folderId: string } {
  try {
    const v = JSON.parse(
      localStorage.getItem(ASTAR_TARGET_KEY) ?? '{}',
    ) as Record<string, unknown>
    return {
      server: typeof v.server === 'string' ? v.server : '',
      token: typeof v.token === 'string' ? v.token : '',
      folderId: typeof v.folderId === 'string' ? v.folderId : '',
    }
  } catch {
    return { server: '', token: '', folderId: '' }
  }
}
const target = ref(loadTarget())
const sendOpen = ref(false)
const sent = ref(false)
const canSend = computed(
  () =>
    target.value.server.trim().startsWith('https://') &&
    target.value.token.trim() !== '' &&
    /^[0-9a-f-]{36}$/i.test(target.value.folderId.trim()),
)

async function send(): Promise<void> {
  if (!engine || busy.value) return
  if (!canSend.value) {
    sendOpen.value = true
    return
  }
  busy.value = 'send'
  saveError.value = ''
  try {
    try {
      localStorage.setItem(ASTAR_TARGET_KEY, JSON.stringify(target.value))
    } catch {
      /* not kept */
    }
    const fd = new FormData()
    fd.append('folderId', target.value.folderId.trim())
    fd.append('name', `本の撮影 ${stamp()}`)
    for (const [i, p] of engine.orderedPages().entries()) {
      const blob = await new Promise<Blob | null>((r) =>
        p.canvas.toBlob(r, 'image/jpeg', 0.85),
      )
      if (blob)
        fd.append('pages', blob, `page-${String(i + 1).padStart(3, '0')}.jpg`)
    }
    const res = await fetch(
      `${target.value.server.replace(/\/+$/, '')}/api/v1/book-captures`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${target.value.token.trim()}` },
        body: fd,
      },
    )
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    sent.value = true
    sendOpen.value = false
  } catch (err) {
    saveError.value = `書類置場に送れませんでした: ${String(err)}`
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="book" :class="`book--${screen}`">
    <!-- start -->
    <section v-if="screen === 'start' || screen === 'loading'" class="start">
      <h1 class="start__title">本を撮る</h1>
      <p class="start__text">
        本にカメラを向けて止めるだけで撮れます。シャッターは押しません。<br />
        撮れたら音と振動で知らせ、ページ番号を読んで抜けを赤で知らせます。
      </p>
      <button class="start__go" :disabled="screen === 'loading'" @click="begin">
        {{ screen === 'loading' ? '準備しています…' : '撮影を始める' }}
      </button>
      <p v-if="errorText" class="start__error">{{ errorText }}</p>
      <NuxtLink class="start__link" to="/?classic=1"
        >書類の撮影（以前の画面）</NuxtLink
      >
    </section>

    <!-- camera -->
    <section v-show="screen === 'camera'" class="cam">
      <video ref="videoRef" class="cam__video" playsinline muted autoplay />
      <svg
        class="cam__overlay"
        :viewBox="`0 0 ${vw} ${vh}`"
        preserveAspectRatio="xMidYMid meet"
      >
        <template v-if="st && st.quad">
          <template v-if="st.tone === 'search'">
            <path
              :d="quadPath(st.quad)"
              fill="#f59e0b"
              fill-opacity="0.1"
              stroke="#f59e0b"
              :stroke-width="3 * unit"
              :stroke-dasharray="`${9 * unit} ${7 * unit}`"
            />
          </template>
          <template v-else-if="st.tone === 'hold' || st.tone === 'sweep'">
            <path
              :d="quadPath(st.quad)"
              fill="#22c55e"
              fill-opacity="0.05"
              stroke="#22c55e"
              stroke-opacity="0.35"
              :stroke-width="3 * unit"
            />
            <path
              :d="quadPath(st.quad)"
              fill="none"
              stroke="#22c55e"
              :stroke-width="5 * unit"
              pathLength="100"
              :stroke-dasharray="`${st.sweep * 100} 100`"
            />
          </template>
          <template v-else>
            <path
              :d="quadPath(st.quad)"
              :fill="frameColor"
              :fill-opacity="st.tone === 'dup' ? 0.14 : 0.07"
              :stroke="frameColor"
              :stroke-width="(st.tone === 'dup' ? 4 : 5) * unit"
            />
          </template>
          <path
            :d="brackets(st.quad)"
            fill="none"
            :stroke="frameColor"
            :stroke-width="5 * unit"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </template>
      </svg>
      <div class="cam__flash" :style="{ opacity: flashOpacity }" />

      <header class="cam__top">
        <button class="cam__close" aria-label="終わる" @click="finish">
          ×
        </button>
        <span v-if="gapCount > 0" class="cam__gaps">抜け {{ gapCount }}</span>
        <span class="cam__count">{{ pageCount }} 枚</span>
      </header>
      <div
        v-if="st && st.pill"
        class="cam__pill"
        :style="{ background: pillBg }"
      >
        {{ st.pill }}
      </div>
      <div
        v-if="st && !st.ready"
        class="cam__pill"
        style="background: rgba(17, 24, 39, 0.85)"
      >
        準備しています…
      </div>
      <div
        v-if="st && st.tone === 'dup' && !banner"
        class="cam__banner cam__banner--mute"
      >
        <div>撮影済みです</div>
        <div class="cam__banner-sub">めくってください</div>
      </div>
      <div
        v-if="banner"
        class="cam__banner"
        :class="`cam__banner--${banner.tone}`"
      >
        <div>{{ banner.lines[0] }}</div>
        <div
          v-for="(l, i) in banner.lines.slice(1)"
          :key="i"
          class="cam__banner-sub"
        >
          {{ l }}
        </div>
      </div>
      <p v-if="errorText" class="cam__error">{{ errorText }}</p>
      <div v-if="debug && st" class="cam__debug">
        {{ st.backend ?? '—'
        }}{{ st.backend === 'wasm' ? ` ×${st.threads}` : '' }} ·
        {{ st.fps.toFixed(1) }} fps · {{ Math.round(st.inferMs) }} ms · 番号
        wasm ×{{ st.numberThreads }} ·
        {{ isolated ? 'isolated' : 'not isolated' }}
      </div>

      <footer class="cam__bottom">
        <div ref="stripRef" class="strip">
          <template v-for="(it, i) in st?.coverage.items ?? []" :key="i">
            <div v-if="it.kind === 'gap'" class="strip__item strip__item--gap">
              <div class="strip__gap" />
              <span>{{ itemLabel(it) }}</span>
            </div>
            <div v-else class="strip__item" :class="`strip__item--${it.state}`">
              <div class="strip__thumbs">
                <img
                  v-for="p in sheetPages(it.sheetId)"
                  :key="p.id"
                  :src="thumbOf(p)"
                  alt=""
                />
              </div>
              <span>{{ itemLabel(it) }}</span>
            </div>
          </template>
        </div>
        <button class="cam__finish" @click="finish">終わる</button>
      </footer>
    </section>

    <!-- list -->
    <section v-if="screen === 'list'" class="list">
      <header class="list__head">
        <h1>撮影結果</h1>
        <span :class="gapCount > 0 ? 'list__sum list__sum--bad' : 'list__sum'">
          {{ engine?.pages.length ?? 0 }} ページ・抜け {{ gapCount }}
        </span>
      </header>
      <ul class="list__rows">
        <li
          v-for="(r, i) in listRows"
          :key="i"
          :class="[
            'list__row',
            r.kind === 'gap' ? 'list__row--gap' : '',
            r.kind === 'page' && selected?.id === r.page.id
              ? 'list__row--sel'
              : '',
          ]"
          @click="
            r.kind === 'page' && ((selected = r.page), (showStraight = false))
          "
        >
          <template v-if="r.kind === 'page'">
            <img :src="thumbOf(r.page)" alt="" class="list__thumb" />
            <span class="list__num">{{ pageLabel(r.page) }}</span>
            <span
              :class="r.page.read.state === 'read' ? 'list__ok' : 'list__mute'"
            >
              {{ r.page.read.state === 'read' ? '✓ 撮れた' : '撮れた' }}
            </span>
            <span class="list__fix">{{
              r.page.flattened ? '補正済み' : '補正なし'
            }}</span>
          </template>
          <template v-else>
            <span class="list__gap">{{ r.label }} ページが抜けています</span>
          </template>
        </li>
        <li v-if="listRows.length === 0" class="list__empty">
          まだ撮ったページがありません
        </li>
      </ul>

      <div v-if="selected" class="list__preview">
        <div class="list__preview-head">
          <b>{{ pageLabel(selected) }} ページ</b>
          <span class="list__toggle">
            <button :class="{ on: showStraight }" @click="showStraight = true">
              撮影したまま
            </button>
            <button
              :class="{ on: !showStraight }"
              @click="showStraight = false"
            >
              曲がりを直した結果
            </button>
          </span>
        </div>
        <img :src="selectedUrl" alt="" class="list__big" />
        <p v-if="!selected.flattened" class="list__note">
          曲がりは直せませんでした（{{
            selected.flattenWhy || '縁が見つからない'
          }}）
        </p>
        <button class="list__del" @click="removeSelected">
          このページを消す
        </button>
      </div>

      <div class="list__actions">
        <div class="list__two">
          <button
            :class="{ done: savedPdf }"
            :disabled="!!busy || !engine?.pages.length"
            @click="savePdf"
          >
            {{ savedPdf ? '✓ ' : '' }}PDF 保存
          </button>
          <button
            :class="{ done: savedMd }"
            :disabled="!!busy || !engine?.pages.length"
            @click="saveMarkdown"
          >
            {{ savedMd ? '✓ ' : '' }}Markdown 保存
          </button>
        </div>
        <p v-if="mdProgress" class="list__note">{{ mdProgress }}</p>
        <div v-if="sendOpen" class="list__send">
          <input
            v-model="target.server"
            placeholder="https://（書類置場のサーバー）"
          />
          <input
            v-model="target.token"
            placeholder="鍵（asm_sk_…）"
            type="password"
          />
          <input v-model="target.folderId" placeholder="フォルダ ID" />
        </div>
        <button
          class="list__send-btn"
          :class="{ done: sent }"
          :disabled="!!busy || !engine?.pages.length"
          @click="send"
        >
          {{
            sent
              ? '✓ 書類置場に送りました'
              : busy === 'send'
                ? '送っています…'
                : '書類置場に送る'
          }}
        </button>
        <p v-if="saveError" class="list__err">{{ saveError }}</p>
        <button class="list__back" @click="backToCamera">撮影に戻る</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.book {
  --ok: #22c55e;
  --bad: #ef4444;
  --mute: #9ca3af;
  min-height: 100dvh;
  font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic UI', sans-serif;
}
.book--camera {
  background: #000;
}
.start {
  max-width: 420px;
  margin: 0 auto;
  padding: 48px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.start__title {
  font-size: 24px;
  font-weight: 700;
}
.start__text {
  color: #4b5563;
  line-height: 1.7;
}
.start__go {
  height: 56px;
  border-radius: 28px;
  background: #111827;
  color: #fff;
  font-size: 18px;
  font-weight: 700;
}
.start__go:disabled {
  opacity: 0.6;
}
.start__error {
  color: #b91c1c;
}
.start__link {
  color: #6b7280;
  font-size: 13px;
  text-decoration: underline;
}
.cam {
  position: fixed;
  inset: 0;
  background: #000;
  overflow: hidden;
  touch-action: none;
}
.cam__video,
.cam__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.cam__flash {
  position: absolute;
  inset: 0;
  background: #fff;
  pointer-events: none;
}
.cam__top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 50px;
  padding-top: env(safe-area-inset-top);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  display: flex;
  align-items: center;
  gap: 16px;
  padding-inline: 16px;
}
.cam__close {
  font-size: 22px;
  width: 44px;
  height: 44px;
  color: #fff;
  margin-right: auto;
  text-align: left;
}
.cam__count {
  font-weight: 700;
  font-size: 14px;
}
.cam__gaps {
  font-weight: 700;
  font-size: 14px;
  color: #fca5a5;
}
.cam__pill {
  position: absolute;
  top: 62px;
  left: 50%;
  transform: translateX(-50%);
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  padding: 7px 14px;
  border-radius: 99px;
  white-space: nowrap;
}
.cam__banner {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 252px;
  border-radius: 14px;
  padding: 12px 10px;
  color: #fff;
  text-align: center;
  font-weight: 700;
  font-size: 20px;
  line-height: 1.35;
}
.cam__banner-sub {
  font-size: 16px;
}
.cam__banner--ok {
  background: #15803d;
}
.cam__banner--bad {
  background: #dc2626;
}
.cam__banner--mute {
  background: #4b5563;
}
.cam__error {
  position: absolute;
  top: 110px;
  left: 16px;
  right: 16px;
  color: #fff;
  background: #b91c1c;
  border-radius: 8px;
  padding: 8px;
}
.cam__debug {
  position: absolute;
  top: 100px;
  left: 8px;
  font:
    11px/1.3 ui-monospace,
    monospace;
  color: #fff;
  background: rgba(0, 0, 0, 0.6);
  padding: 4px 6px;
  border-radius: 4px;
}
.cam__bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: calc(138px + env(safe-area-inset-bottom));
  background: rgba(0, 0, 0, 0.72);
  padding-bottom: env(safe-area-inset-bottom);
}
.strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 12px 14px 0;
  height: 68px;
}
.strip__item {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  font-weight: 700;
  color: var(--ok);
}
.strip__item--nonum,
.strip__item--pending {
  color: var(--mute);
}
.strip__item--gap {
  color: var(--bad);
}
.strip__thumbs {
  display: flex;
  height: 34px;
  gap: 1px;
}
.strip__thumbs img {
  height: 34px;
  width: auto;
  border-radius: 2px;
}
.strip__gap {
  width: 46px;
  height: 34px;
  border-radius: 3px;
  border: 2px dashed var(--bad);
  background: rgba(239, 68, 68, 0.18);
}
.cam__finish {
  position: absolute;
  left: 50%;
  bottom: calc(20px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  width: 140px;
  height: 44px;
  border-radius: 22px;
  background: #fff;
  color: #111827;
  font-size: 16px;
  font-weight: 700;
}
.list {
  max-width: 560px;
  margin: 0 auto;
  background: #fff;
  min-height: 100dvh;
  padding-bottom: 24px;
}
.list__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 24px 16px 12px;
  border-bottom: 1px solid #e5e7eb;
}
.list__head h1 {
  font-size: 18px;
  font-weight: 700;
}
.list__sum {
  font-size: 14px;
  font-weight: 700;
  color: #15803d;
}
.list__sum--bad {
  color: #dc2626;
}
.list__rows {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list__row {
  display: grid;
  grid-template-columns: 28px 1fr auto auto;
  gap: 10px;
  align-items: center;
  padding: 6px 16px;
  border-bottom: 1px solid #e5e7eb;
  font-size: 13px;
  cursor: pointer;
}
.list__row--sel {
  background: #f3f4f6;
}
.list__row--gap {
  background: #fef2f2;
  grid-template-columns: 1fr;
}
.list__thumb {
  width: 28px;
  height: 36px;
  object-fit: cover;
  border: 1px solid #d1d5db;
}
.list__num {
  font-weight: 600;
}
.list__ok {
  color: #15803d;
  font-weight: 700;
}
.list__mute {
  color: #6b7280;
  font-weight: 700;
}
.list__fix {
  color: #6b7280;
  font-size: 11px;
}
.list__gap {
  color: #dc2626;
  font-weight: 700;
}
.list__empty {
  padding: 24px 16px;
  color: #6b7280;
}
.list__preview {
  padding: 12px 16px;
}
.list__preview-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.list__toggle button {
  font-size: 12px;
  padding: 4px 8px;
  border: 1px solid #d1d5db;
  background: #fff;
}
.list__toggle button.on {
  background: #111827;
  color: #fff;
}
.list__big {
  width: 100%;
  border: 1px solid #e5e7eb;
}
.list__note {
  font-size: 12px;
  color: #6b7280;
  margin: 6px 0;
}
.list__del {
  font-size: 12px;
  color: #b91c1c;
  margin-top: 6px;
}
.list__actions {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.list__two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.list__two button {
  height: 44px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  background: #fff;
  font-weight: 700;
  font-size: 14px;
}
.list__two button.done {
  background: #dcfce7;
  border-color: #16a34a;
  color: #15803d;
}
.list__send {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.list__send input {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 8px;
  font-size: 14px;
}
.list__send-btn {
  height: 48px;
  border-radius: 8px;
  background: #111827;
  color: #fff;
  font-weight: 700;
  font-size: 15px;
}
.list__send-btn.done {
  background: #15803d;
}
.list__err {
  color: #b91c1c;
  font-size: 13px;
}
.list__back {
  height: 44px;
  border-radius: 22px;
  border: 1px solid #d1d5db;
  font-weight: 700;
}
</style>
