<script setup lang="ts">
/**
 * End-of-scan table: what was captured during the scan, what was missed,
 * duplicate candidates, and what the post-scan pass picked up afterwards.
 * Only missed rows (and recovered rows that were missed live) offer a
 * retake. Duplicates are never dropped automatically — the user removes.
 */
export type ReportKind = 'captured' | 'duplicate' | 'recovered' | 'missed'

/** Printed page number check (Android app). `missing` / `suspect` /
 *  `missingOrUnread` rows are gaps in the number sequence (`missingOrUnread`:
 *  pages whose number could not be read lie inside the gap, so some of it
 *  may be those pages); `failed` means OCR could not run. */
export type PrintedNoState =
  | 'reading'
  | 'ok'
  | 'duplicate'
  | 'outOfOrder'
  | 'unread'
  | 'failed'
  | 'missing'
  | 'suspect'
  | 'missingOrUnread'

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
  /** Printed page number(s) read from the page, or the missing range. */
  printedNo?: string | null
  printedState?: PrintedNoState
}

defineProps<{
  rows: ReportViewRow[]
  retakeBusy: boolean
  /** Show the printed page number column. */
  showPrinted?: boolean
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

/** How each printed-number state looks: its label and its tone. The one
 *  place both are defined. Red (`alert`) is kept for what may be a missed
 *  page — gaps in the number sequence (欠番) and repeated numbers — so a
 *  red row means "check for a page you did not capture". A page whose
 *  number could not be read is still captured, so it is a quiet grey
 *  番号なし; `failed` (OCR could not run) shows the same, since for the user
 *  the outcome is identical: the page is there, its number is not. */
type PrintedTone = 'alert' | 'warn' | 'muted' | 'plain'
const PRINTED_STYLE: Record<
  PrintedNoState,
  { label: string; tone: PrintedTone }
> = {
  reading: { label: '読み取り中…', tone: 'muted' },
  ok: { label: '', tone: 'plain' },
  duplicate: { label: '重複', tone: 'alert' },
  outOfOrder: { label: '順番が前後', tone: 'warn' },
  unread: { label: '番号なし', tone: 'muted' },
  failed: { label: '番号なし', tone: 'muted' },
  missing: { label: '欠番', tone: 'alert' },
  suspect: { label: '欠番（読み違いかも）', tone: 'alert' },
  // A gap with unnumbered pages inside: some of it may be those pages.
  missingOrUnread: { label: '欠番？', tone: 'alert' },
}
function isAlert(r: ReportViewRow): boolean {
  return (
    r.printedState !== undefined &&
    PRINTED_STYLE[r.printedState].tone === 'alert'
  )
}
</script>

<template>
  <section class="report" aria-label="撮影結果">
    <table class="report__table">
      <thead>
        <tr>
          <th>#</th>
          <th></th>
          <th>状態</th>
          <th v-if="showPrinted">ページ番号</th>
          <th v-else>画像</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.id"
          :class="[
            `report__row report__row--${r.kind}`,
            { 'report__row--alert': isAlert(r) },
          ]"
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
          <td
            v-if="showPrinted"
            :class="[
              'report__printed',
              r.printedState
                ? `report__printed--${PRINTED_STYLE[r.printedState].tone}`
                : '',
            ]"
          >
            <span v-if="r.printedNo" class="report__printed-no">{{
              r.printedNo
            }}</span>
            <span v-if="r.printedState" class="report__printed-state">{{
              PRINTED_STYLE[r.printedState].label
            }}</span>
          </td>
          <td v-else class="report__source">
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
.report__row--alert td {
  background: rgba(254, 202, 202, 0.55);
}
.report__printed {
  font-size: 13px;
  white-space: nowrap;
}
.report__printed-no {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  margin-right: 6px;
}
.report__printed-state {
  font-size: 12px;
  color: #64748b;
}
.report__printed--alert {
  color: #b91c1c;
}
.report__printed--alert .report__printed-state {
  color: #b91c1c;
  font-weight: 700;
}
.report__printed--warn .report__printed-state {
  color: #b45309;
  font-weight: 600;
}
.report__printed--muted .report__printed-state {
  color: #94a3b8;
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
