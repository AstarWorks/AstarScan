package com.astarworks.mlkitscanner

import java.util.TreeSet

/**
 * The pages one capture screen has taken, in book order, and what the
 * printed numbers say about them. Pure logic (no Android types).
 *
 * Rules (the screen shows one banner per page):
 * - no number read → kept, "番号なし" (grey);
 * - a number already taken → not kept again ("撮影済み"): the user did not
 *   turn the page;
 * - a number on the missing list → kept in its place, "抜けを埋めました";
 * - the next number(s) → kept, "撮れた" (green);
 * - a jump → kept, and the pages in between go on the missing list
 *   ("… ページが抜けています", red) until they are taken.
 * "Next" depends on how the book is being taken: a spread holds two
 * numbers; single pages either go one by one (both sides of every leaf,
 * step 1) or one side only — every right page, the camera never on the
 * left one (step 2: 31, 33, 35 is not a gap). The step is learnt from the
 * first two single pages that follow each other (+1 or +2).
 *
 * The screen keeps a page the moment it is taken (`addPending`, "reading")
 * and reads its number afterwards, while the user turns on (`resolve`, in
 * the order the pages were taken). Not thread-safe: callers lock it.
 */
class CaptureSession(known: Collection<Int> = emptyList(), step: Int = 0) {
    class Page(
        val name: String,
        val width: Int,
        val height: Int,
        val nums: List<Int>,
        val spread: Boolean,
        /** "ok", "unread", or "reading" (taken, number not read yet). */
        val numberState: String,
    )

    sealed class Outcome {
        data class Taken(val nums: List<Int>) : Outcome()
        object Unread : Outcome()
        data class Gap(val nums: List<Int>, val missing: List<Int>) : Outcome()
        data class Filled(val nums: List<Int>) : Outcome()
        data class Duplicate(val nums: List<Int>) : Outcome()
    }

    val pages = ArrayList<Page>()
    val missing = TreeSet<Int>()
    private val taken = TreeSet<Int>(known)
    /** 0 unknown, 1 every page, 2 one side only (single pages). */
    var step: Int = step
        private set
    private var lastSingle: Int? = null

    /** Highest number taken so far (this screen or the list before it). */
    val last: Int? get() = if (taken.isEmpty()) null else taken.last()

    /** The number(s) the next page should carry, for a page / a spread. */
    fun expected(spread: Boolean): Int? {
        val l = last ?: return null
        return if (!spread && step == 2) l + 2 else l + 1
    }

    /**
     * How `nums` (read on a page, not yet added) relates to what was taken:
     * "expected" (the next page, or a missing one), "duplicate", "jump",
     * "lower" (below the last page but not missing: a misread or a page
     * taken before), "far" (more than MAX_JUMP pages ahead: likely a
     * misread), or "first" (nothing to compare with).
     */
    fun relation(nums: List<Int>, spread: Boolean): String {
        if (nums.isEmpty()) return "none"
        if (nums.any { it in taken }) return "duplicate"
        if (nums.all { it in missing }) return "expected"
        val l = last ?: return "first"
        val lo = nums.min()
        if (lo <= l) return "lower"
        val next = if (!spread && step == 2) l + 2 else l + 1
        if (lo == next) return "expected"
        // Step not learnt yet: +1 and +2 are both "next" for a single page.
        if (!spread && step == 0 && lo == l + 2) return "expected"
        if (lo - l > MAX_JUMP) return "far"
        return "jump"
    }

    /** A page just taken, its number still to be read: kept at the end, "reading". */
    fun addPending(name: String, width: Int, height: Int, spread: Boolean) {
        pages.add(Page(name, width, height, emptyList(), spread, "reading"))
    }

    /** Pages taken whose number is still being read. */
    val reading: Int get() = pages.count { it.numberState == "reading" }

    /**
     * The number(s) read on a page added with `addPending`: the same rules
     * as `add`, the page staying where it was taken (a missing page moves to
     * its place; a page already taken leaves the list). Null when the page
     * is not (or no longer) waiting for its number.
     */
    fun resolve(name: String, nums: List<Int>): Outcome? {
        val i = pages.indexOfFirst { it.name == name && it.numberState == "reading" }
        if (i < 0) return null
        val p = pages.removeAt(i)
        return add(p.name, p.width, p.height, nums, p.spread, i)
    }

    /** Pages still "reading" when the screen closes: kept without a number. */
    fun giveUpReading() {
        for (i in pages.indices) {
            val p = pages[i]
            if (p.numberState == "reading") pages[i] = Page(p.name, p.width, p.height, emptyList(), p.spread, "unread")
        }
    }

    fun add(name: String, width: Int, height: Int, nums: List<Int>, spread: Boolean, at: Int = pages.size): Outcome {
        val pos = at.coerceIn(0, pages.size)
        if (nums.isEmpty()) {
            pages.add(pos, Page(name, width, height, nums, spread, "unread"))
            lastSingle = null
            return Outcome.Unread
        }
        val sorted = nums.sorted()
        if (sorted.any { it in taken }) return Outcome.Duplicate(sorted)
        if (sorted.all { it in missing }) {
            val at2 = pages.indexOfFirst { p -> p.nums.isNotEmpty() && p.nums.min() > sorted.first() }
            val page = Page(name, width, height, sorted, spread, "ok")
            if (at2 < 0) pages.add(pos, page) else pages.add(at2, page)
            missing.removeAll(sorted.toSet())
            taken.addAll(sorted)
            return Outcome.Filled(sorted)
        }
        val l = last
        val lo = sorted.first()
        if (!spread && sorted.size == 1) {
            val prev = lastSingle
            if (step == 0 && prev != null && prev == l) {
                if (lo == prev + 1) step = 1 else if (lo == prev + 2) step = 2
            }
            lastSingle = lo
        } else {
            lastSingle = null
        }
        val gap = ArrayList<Int>()
        if (l != null && lo > l + 1) {
            val s = if (!spread && step == 2) 2 else 1
            var n = l + s
            while (n < lo) {
                if (n !in taken) gap.add(n)
                n += s
            }
        }
        pages.add(pos, Page(name, width, height, sorted, spread, "ok"))
        taken.addAll(sorted)
        if (gap.isEmpty()) return Outcome.Taken(sorted)
        missing.addAll(gap)
        return Outcome.Gap(sorted, gap)
    }

    companion object {
        /** A jump wider than this is taken as a misread, not as missing pages (checkPageSequence maxGap). */
        const val MAX_JUMP = 20

        /** "37", "37・39", "37〜41" (≥ 3 in a row). */
        fun label(nums: List<Int>): String {
            if (nums.isEmpty()) return ""
            val s = nums.sorted()
            if (s.size >= 3 && s.last() - s.first() == s.size - 1) return "${s.first()}〜${s.last()}"
            return s.joinToString("・")
        }
    }
}
