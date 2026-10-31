<script setup lang="ts">
/**
 * Review-screen repair controls.
 *
 * The clustering pipeline reaches identity recall 1.0 on both eval videos,
 * but its residual errors are duplicates and junk (see docs/eval-results.md)
 * — the classes a human fixes instantly and an algorithm cannot. Until this
 * panel existed there was no way to act on them: the result screen was
 * read-only, so a single wrong page meant rescanning the whole stack.
 *
 * This component is presentational. It owns no clusters and mutates
 * nothing; every action is an emit and the page (index.vue) applies it via
 * the pure helpers in `@astarworks/scan-core/pipeline` (cluster-repair.ts).
 *
 * Clusters are addressed by `clusterKey` (the winner frame's index). That
 * key CHANGES whenever a repair re-elects a winner, so the parent re-reads
 * keys from the returned cluster array after every operation.
 */

import { computed } from 'vue'

interface RepairPage {
  id: string
  dataUrl: string
  /** Present only for pages from the current scan — restored session
   *  pages have no cluster behind them and cannot be repaired. */
  clusterKey?: number
  memberCount?: number
}

/** One candidate frame of a cluster, for the filmstrip. */
interface MemberView {
  idx: number
  t_s: number
  dataUrl: string
  isWinner: boolean
}

const props = defineProps<{
  pages: readonly RepairPage[]
  /** clusterKeys currently ticked for merging. */
  selected: readonly number[]
  /** The cluster whose candidate frames are open, if any. */
  detailKey: number | null
  members: readonly MemberView[]
  membersLoading: boolean
  /** True when the frame ring buffer dropped this scan's early frames, so
   *  some pages have no candidates left to split or re-pick from. */
  bufferTruncated: boolean
}>()

const emit = defineEmits<{
  toggle: [clusterKey: number]
  merge: []
  remove: [clusterKey: number]
  openMembers: [clusterKey: number]
  closeMembers: []
  setWinner: [clusterKey: number, memberIdx: number]
  split: [clusterKey: number, atIdx: number]
  editQuad: [clusterKey: number]
}>()

const repairable = computed(() => props.pages.filter((p) => p.clusterKey !== undefined))
const canMerge = computed(() => props.selected.length >= 2)

function isSelected(key: number | undefined): boolean {
  return key !== undefined && props.selected.includes(key)
}

/** A split needs a frame on each side, so the first candidate can't be the cut point. */
function canSplitAt(i: number): boolean {
  return i > 0
}
</script>

<template>
  <section class="repair">
    <header class="repair__bar">
      <p class="repair__count">
        {{ repairable.length }} ページ
        <span v-if="selected.length" class="repair__sel">/ {{ selected.length }} 選択中</span>
      </p>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="!canMerge"
        @click="emit('merge')"
      >
        1枚にまとめる
      </button>
    </header>

    <p v-if="bufferTruncated" class="repair__warn">
      スキャンが長かったため、序盤のページは候補フレームが残っていません。
      そのページは分割・写りの選び直しができません。
    </p>

    <ul class="repair__grid">
      <li
        v-for="p in repairable"
        :key="p.id"
        class="repair__cell"
        :class="{ 'repair__cell--on': isSelected(p.clusterKey) }"
      >
        <button
          class="repair__pick"
          type="button"
          :aria-pressed="isSelected(p.clusterKey)"
          @click="emit('toggle', p.clusterKey!)"
        >
          <img :src="p.dataUrl" alt="" class="repair__thumb">
          <span class="repair__mark" aria-hidden="true">{{ isSelected(p.clusterKey) ? '✓' : '' }}</span>
        </button>
        <div class="repair__acts">
          <button
            class="btn btn--ghost"
            type="button"
            :disabled="(p.memberCount ?? 0) < 2"
            @click="emit('openMembers', p.clusterKey!)"
          >
            候補 {{ p.memberCount ?? 0 }}
          </button>
          <button class="btn btn--ghost" type="button" @click="emit('editQuad', p.clusterKey!)">
            四隅
          </button>
          <button class="btn btn--ghost" type="button" @click="emit('remove', p.clusterKey!)">
            削除
          </button>
        </div>
      </li>
    </ul>

    <div v-if="detailKey !== null" class="repair__strip">
      <header class="repair__bar">
        <p class="repair__count">候補フレーム</p>
        <button class="btn btn--ghost" type="button" @click="emit('closeMembers')">閉じる</button>
      </header>

      <p v-if="membersLoading" class="repair__note">読み込み中…</p>
      <ul v-else class="repair__frames">
        <li v-for="(m, i) in members" :key="m.idx" class="repair__frame">
          <img :src="m.dataUrl" alt="" class="repair__fthumb" :class="{ 'is-winner': m.isWinner }">
          <p class="repair__meta">{{ m.t_s.toFixed(1) }}s</p>
          <button
            class="btn btn--ghost"
            type="button"
            :disabled="m.isWinner"
            @click="emit('setWinner', detailKey!, m.idx)"
          >
            {{ m.isWinner ? '採用中' : 'これを採用' }}
          </button>
          <button
            class="btn btn--ghost"
            type="button"
            :disabled="!canSplitAt(i)"
            @click="emit('split', detailKey!, m.idx)"
          >
            ここで分ける
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.repair {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.repair__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.repair__count {
  margin: 0;
  font-size: 0.9rem;
  opacity: 0.85;
}
.repair__sel {
  opacity: 0.7;
}
.repair__warn {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 0.5rem;
  background: rgb(255 200 0 / 12%);
  font-size: 0.85rem;
  line-height: 1.5;
}
.repair__note {
  margin: 0;
  font-size: 0.85rem;
  opacity: 0.7;
}
.repair__grid,
.repair__frames {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.repair__grid {
  grid-template-columns: repeat(auto-fill, minmax(7.5rem, 1fr));
}
.repair__frames {
  grid-auto-flow: column;
  grid-auto-columns: 8rem;
  overflow-x: auto;
  padding-bottom: 0.25rem;
}
.repair__cell {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.repair__pick {
  position: relative;
  display: block;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 0.5rem;
  background: none;
  cursor: pointer;
}
.repair__cell--on .repair__pick {
  border-color: currentcolor;
}
.repair__thumb,
.repair__fthumb {
  display: block;
  width: 100%;
  border-radius: 0.375rem;
  object-fit: contain;
}
.repair__fthumb.is-winner {
  outline: 2px solid currentcolor;
  outline-offset: 1px;
}
.repair__mark {
  position: absolute;
  top: 0.25rem;
  right: 0.25rem;
  min-width: 1.25rem;
  font-size: 0.9rem;
  line-height: 1.25rem;
  text-align: center;
}
.repair__acts,
.repair__frame {
  display: flex;
  gap: 0.25rem;
}
.repair__frame {
  flex-direction: column;
  align-items: stretch;
}
.repair__meta {
  margin: 0;
  font-size: 0.75rem;
  text-align: center;
  opacity: 0.7;
}
.repair__strip {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgb(128 128 128 / 30%);
}
/* Tap targets stay ≥44 px on touch even though the thumbs are small.
   Three actions do not fit across a 7.5rem cell, so they wrap to a second
   row rather than shrinking below a thumb-width. */
.repair__acts {
  flex-wrap: wrap;
}
.repair__acts .btn {
  flex: 1 1 45%;
}
.repair__frame .btn {
  flex: 1;
}
.repair__acts .btn,
.repair__frame .btn {
  min-height: 2.75rem;
  font-size: 0.8rem;
}
</style>
