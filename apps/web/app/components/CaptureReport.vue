<script setup lang="ts">
/**
 * End-of-scan table: what was captured during the scan, what was missed,
 * duplicate candidates, and what the post-scan pass picked up afterwards.
 * Only missed rows (and recovered rows that were missed live) offer a
 * retake. Duplicates are never dropped automatically — the user removes.
 */
export type ReportKind = 'captured' | 'duplicate' | 'recovered' | 'missed'

export interface ReportViewRow {
  id: string
  kind: ReportKind
  /** Position in the output document; null for rows not in it (missed). */
  no: number | null
  thumb: string | null
  source: 'photo' | 'video' | null
  duplicateOfNo: number | null
  canRetake: boolean
  /** Output page behind the row (for removal). */
  pageId: string | null
}

defineProps<{
  rows: ReportViewRow[]
  retakeBusy: boolean
}>()

const emit = defineEmits<{
  retake: [rowId: string]
  remove: [pageId: string]
}>()

const KIND_LABEL: Record<ReportKind, string> = {
  captured: '撮れた',
  duplicate: '重複候補',
  recovered: '後から拾った',
  missed: '抜け',
}
const SOURCE_LABEL = { photo: '静止画', video: '動画' } as const
</script>

<template>
  <section class="report" aria-label="撮影結果">
    <table class="report__table">
      <thead>
        <tr>
          <th>#</th>
          <th></th>
          <th>状態</th>
          <th>画像</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.id"
          :class="`report__row report__row--${r.kind}`"
        >
          <td class="report__no">{{ r.no ?? '—' }}</td>
          <td class="report__thumb">
            <img v-if="r.thumb" :src="r.thumb" alt="" />
            <span v-else class="report__thumb-empty" />
          </td>
          <td>
            <span :class="`report__badge report__badge--${r.kind}`">{{
              KIND_LABEL[r.kind]
            }}</span>
            <span v-if="r.duplicateOfNo !== null" class="report__dup"
              >= {{ r.duplicateOfNo }}</span
            >
          </td>
          <td class="report__source">
            {{ r.source ? SOURCE_LABEL[r.source] : '' }}
          </td>
          <td class="report__actions">
            <button
              v-if="r.canRetake"
              type="button"
              class="report__btn report__btn--retake"
              :disabled="retakeBusy"
              @click="emit('retake', r.id)"
            >
              撮り直す
            </button>
            <button
              v-if="r.kind === 'duplicate' && r.pageId"
              type="button"
              class="report__btn"
              @click="emit('remove', r.pageId)"
            >
              削除
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.report {
  padding: 8px 16px;
  overflow-x: auto;
}
.report__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.report__table th,
.report__table td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.3);
  text-align: left;
  vertical-align: middle;
}
.report__no {
  font-variant-numeric: tabular-nums;
  width: 2.5em;
}
.report__thumb img,
.report__thumb-empty {
  display: block;
  width: 40px;
  height: 52px;
  object-fit: cover;
  border-radius: 4px;
  background: rgba(148, 163, 184, 0.25);
}
.report__badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 600;
  font-size: 12px;
}
.report__badge--captured {
  background: #dcfce7;
  color: #166534;
}
.report__badge--duplicate {
  background: #fef9c3;
  color: #854d0e;
}
.report__badge--recovered {
  background: #e0e7ff;
  color: #3730a3;
}
.report__badge--missed {
  background: #fee2e2;
  color: #991b1b;
}
.report__row--missed td {
  background: rgba(254, 226, 226, 0.35);
}
.report__dup {
  margin-left: 6px;
  color: #854d0e;
  font-size: 12px;
}
.report__source {
  color: #64748b;
  font-size: 12px;
}
.report__actions {
  text-align: right;
  white-space: nowrap;
}
.report__btn {
  min-height: 36px;
  padding: 4px 12px;
  border-radius: 8px;
  border: 1px solid #cbd5e1;
  background: #fff;
  color: #0f172a;
  font-size: 13px;
  cursor: pointer;
}
.report__btn--retake {
  border-color: #dc2626;
  color: #dc2626;
  font-weight: 600;
}
.report__btn:disabled {
  opacity: 0.5;
}
</style>
