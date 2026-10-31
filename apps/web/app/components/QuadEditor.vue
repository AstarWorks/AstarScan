<script setup lang="ts">
/**
 * Manual corner correction — drag the four detected corners.
 *
 * `CLAUDE.md` lists this as Phase 1 required and it was the last piece of
 * the repair set still missing: merge/split/delete fix *which frames* the
 * pipeline grouped, but nothing could fix *where it cut*. A thumb over a
 * corner, or a page with no contrast against the desk, produces a crop the
 * clustering is perfectly happy with and the user is not.
 *
 * This component is presentational, like ReviewRepair.vue: it holds a
 * working copy of the quad while the user drags and emits the result. The
 * page (index.vue) owns the re-warp and the cluster update.
 *
 * Coordinate spaces: the quad prop and the `save` payload are both in
 * SOURCE pixel space (`srcW` x `srcH`). Everything in between happens in
 * display space, because that is where a 44 px tap target is defined — a
 * fixed source-space grab radius would shrink to nothing as the preview
 * scales down. `scaleQuad` is the only bridge, and the working copy stays
 * in source space so a resize (or a phone rotation) mid-edit cannot drift
 * the corners.
 */

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  moveQuadCorner,
  nearestQuadCorner,
  quadCornerList,
  scaleQuad,
  type QuadCorner,
} from '@astarworks/scan-core/pipeline'
import type { Quad } from '@astarworks/scan-core'
import { classifyQuad } from '~/services/quad-classify'

const props = defineProps<{
  /** Object URL of the retained source frame. */
  src: string
  /** Pixel size of that frame — the space `quad` and `save` are in. */
  srcW: number
  srcH: number
  quad: Quad
}>()

const emit = defineEmits<{
  save: [quad: Quad]
  cancel: []
}>()

/** Half of the 44x44 px tap target CLAUDE.md requires, in display pixels. */
const GRAB_RADIUS = 22
/** Loupe magnification and size — "2x magnifier loupe on handle tap". */
const LOUPE_ZOOM = 2
const LOUPE_SIZE = 108

/** Working copy, in source space. Reset whenever the caller opens a
 *  different page rather than only on mount. */
const working = ref<Quad>(props.quad)
watch(() => props.quad, (q) => { working.value = q })

const stage = ref<HTMLElement | null>(null)
const stageW = ref(0)
const stageH = ref(0)

/** The stage must be an EXACT fill of the image: the pointer mapping
 *  assumes stage rect == image rect. So the height is capped by
 *  constraining the width against the aspect, never by letterboxing. */
const stageStyle = computed(() => ({
  aspectRatio: `${props.srcW} / ${props.srcH}`,
  maxWidth: `calc(60vh * ${props.srcW} / ${props.srcH})`,
}))

/** The quad as drawn. Derived, so a resize re-maps instead of drifting. */
const shown = computed(() =>
  scaleQuad(working.value, props.srcW, props.srcH, stageW.value, stageH.value),
)
const handles = computed(() => quadCornerList(shown.value))
const outline = computed(() =>
  handles.value.map((h) => `${h.point.x},${h.point.y}`).join(' '),
)

const dragging = ref<QuadCorner | null>(null)

// ---- validity ----------------------------------------------------------
// classifyQuad is the same gate the capture path runs, so a corrected quad
// is held to exactly the rule an auto-detected one was. Only the three
// geometric rejections in the `updatePageQuad` contract block a save;
// 'too-large' and an out-of-band aspect are legitimate outcomes of a
// deliberate correction and fall back to the default long side, same as
// during capture.
const BLOCKING: Record<string, string> = {
  'non-convex': '角がへこんでいます。四隅を外側に広げてください。',
  'self-intersecting': '枠がねじれています。角の並びを直してください。',
  'too-small': '範囲が小さすぎます。もっと広く囲ってください。',
}

const problem = computed(() => {
  const reason = classifyQuad(working.value, props.srcW, props.srcH).rejection_reason
  return reason ? (BLOCKING[reason] ?? null) : null
})

// ---- pointer drag ------------------------------------------------------

function toStage(e: PointerEvent): { x: number; y: number } {
  const r = stage.value?.getBoundingClientRect()
  if (!r) return { x: 0, y: 0 }
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function onPointerDown(e: PointerEvent): void {
  const p = toStage(e)
  const corner = nearestQuadCorner(shown.value, p, GRAB_RADIUS)
  if (!corner) return
  dragging.value = corner
  // Capture on the stage (not e.target, which is whichever SVG shape was
  // hit) so a fast drag that leaves the element keeps tracking and the
  // browser cannot steal the gesture partway through.
  stage.value?.setPointerCapture(e.pointerId)
  e.preventDefault()
  drawLoupe()
}

function onPointerMove(e: PointerEvent): void {
  const corner = dragging.value
  if (!corner) return
  const moved = moveQuadCorner(shown.value, corner, toStage(e), stageW.value, stageH.value)
  working.value = scaleQuad(moved, stageW.value, stageH.value, props.srcW, props.srcH)
  e.preventDefault()
  drawLoupe()
}

function onPointerUp(): void {
  dragging.value = null
}

// ---- loupe -------------------------------------------------------------

const loupe = ref<HTMLCanvasElement | null>(null)
const image = shallowRef<HTMLImageElement | null>(null)

/** Keep the loupe away from the finger: it sits in whichever top corner
 *  the dragged handle is not near. */
const loupeRight = computed(() => {
  const corner = dragging.value
  if (!corner) return false
  return shown.value[corner].x < stageW.value / 2
})

function drawLoupe(): void {
  const canvas = loupe.value
  const img = image.value
  const corner = dragging.value
  if (!canvas || !img || !corner || stageW.value === 0) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // Window in SOURCE pixels that fills the loupe at LOUPE_ZOOM times the
  // on-screen scale.
  const onScreen = stageW.value / props.srcW
  const win = LOUPE_SIZE / (LOUPE_ZOOM * onScreen)
  const c = working.value[corner]

  ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE)
  ctx.drawImage(img, c.x - win / 2, c.y - win / 2, win, win, 0, 0, LOUPE_SIZE, LOUPE_SIZE)

  const mid = LOUPE_SIZE / 2
  ctx.strokeStyle = '#00e5ff'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(mid, mid - 12)
  ctx.lineTo(mid, mid + 12)
  ctx.moveTo(mid - 12, mid)
  ctx.lineTo(mid + 12, mid)
  ctx.stroke()
}

// ---- lifecycle ---------------------------------------------------------

let observer: ResizeObserver | null = null

onMounted(() => {
  const el = stage.value
  if (el) {
    const measure = () => {
      stageW.value = el.clientWidth
      stageH.value = el.clientHeight
    }
    measure()
    observer = new ResizeObserver(measure)
    observer.observe(el)
  }
  // A separate decoded copy for the loupe: drawImage needs an image
  // element, and reading pixels back out of the rendered <img> is not
  // possible.
  const img = new Image()
  img.onload = () => { image.value = img }
  img.src = props.src
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

function onSave(): void {
  if (problem.value) return
  emit('save', working.value)
}
</script>

<template>
  <div class="qed">
    <div
      ref="stage"
      class="qed__stage"
      :style="stageStyle"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img :src="src" alt="" class="qed__img" draggable="false">

      <svg class="qed__overlay" :viewBox="`0 0 ${stageW} ${stageH}`" aria-hidden="true">
        <polygon :points="outline" class="qed__poly" :class="{ 'is-bad': problem !== null }" />
        <!-- The dot is deliberately smaller than the tap target: grabbing
             is resolved geometrically against GRAB_RADIUS (22 px, i.e. the
             44 px target), not by hit-testing these shapes, so a fingertip
             does not have to land on the visible dot. -->
        <circle
          v-for="h in handles"
          :key="h.corner"
          :cx="h.point.x"
          :cy="h.point.y"
          :r="dragging === h.corner ? 10 : 7"
          class="qed__dot"
        />
      </svg>

      <canvas
        v-show="dragging !== null"
        ref="loupe"
        class="qed__loupe"
        :class="{ 'qed__loupe--right': loupeRight }"
        :width="LOUPE_SIZE"
        :height="LOUPE_SIZE"
      />
    </div>

    <p v-if="problem" class="qed__problem">{{ problem }}</p>
    <p v-else class="qed__hint">四隅をドラッグして書類の範囲を合わせてください。</p>

    <!-- Buttons at the bottom: one-handed operation. -->
    <div class="qed__acts">
      <button class="btn btn--ghost" type="button" @click="emit('cancel')">キャンセル</button>
      <button class="btn btn--primary" type="button" :disabled="problem !== null" @click="onSave">
        この範囲で切り直す
      </button>
    </div>
  </div>
</template>

<style scoped>
.qed {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.qed__stage {
  position: relative;
  width: 100%;
  margin-inline: auto;
  overflow: hidden;
  border-radius: 0.5rem;
  background: rgb(0 0 0 / 60%);
  /* The gesture is ours — never let it turn into a scroll or a pinch. */
  touch-action: none;
  user-select: none;
}
.qed__img,
.qed__overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.qed__img {
  object-fit: fill;
  pointer-events: none;
}
.qed__poly {
  fill: rgb(0 229 255 / 12%);
  stroke: #00e5ff;
  stroke-width: 2;
}
.qed__poly.is-bad {
  fill: rgb(255 80 80 / 14%);
  stroke: #ff5050;
}
.qed__dot {
  fill: #00e5ff;
  stroke: rgb(0 0 0 / 55%);
  stroke-width: 2;
}
.qed__loupe {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  border: 2px solid rgb(255 255 255 / 80%);
  border-radius: 50%;
  background: #000;
  pointer-events: none;
}
.qed__loupe--right {
  right: 0.5rem;
  left: auto;
}
.qed__hint,
.qed__problem {
  margin: 0;
  font-size: 0.85rem;
  line-height: 1.5;
}
.qed__hint {
  opacity: 0.75;
}
.qed__problem {
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  background: rgb(255 80 80 / 14%);
}
.qed__acts {
  display: flex;
  gap: 0.5rem;
}
.qed__acts .btn {
  flex: 1;
  min-height: 2.75rem;
}
</style>
