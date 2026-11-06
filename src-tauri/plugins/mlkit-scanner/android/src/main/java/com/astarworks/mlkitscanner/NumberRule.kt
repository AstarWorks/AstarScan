package com.astarworks.mlkitscanner

/**
 * Which number(s) a page taken on the capture screen keeps, from the pick
 * read on its picture and what the session has taken so far. One place for
 * both callers, so they cannot drift apart:
 * - CaptureActivity, on every page it takes (✓ N / red / grey on the
 *   banner and in the list, through CaptureSession.resolve);
 * - StillsCheck (emulator check only), which runs the same rule and the
 *   same CaptureSession over the phone-resolution stills in hold order.
 *
 * The rule, so that a misread number never reaches the list (run 18: p47
 * read as "4" from the body text):
 * - the next number (or a missing one), read as a whole line → kept;
 * - anything else (a jump, the first page, a weak read) → read again on
 *   the other camera picture of the same moment (`second`); kept only when
 *   both reads agree, otherwise the page is "番号なし";
 * - a number lower than the last page (and not missing), or more than
 *   MAX_JUMP ahead → "番号なし";
 * - printed as a folio ("— 41 —" at the bottom / top centre,
 *   PageNumbers.framedFor) and read strongly → kept read once, unless the
 *   other picture reads another number;
 * - exception: ONE page skipped, read strongly once (the other read found
 *   nothing) → kept when CaptureSession.singleReadJumpOk;
 * - nothing read → nothing kept, and the other picture is not read: in run
 *   26 it found a number on none of the 25 pages whose first read was
 *   empty, and cost ~6 s a page (one ML Kit call).
 * Returns (kept, guess): a number read strongly once that is not kept
 * (first page, a jump, the other read lost its digits or found nothing)
 * is the guess, which CaptureSession keeps once a neighbour confirms it.
 */
object NumberRule {
    /**
     * `second` reads the other camera picture (one ML Kit call; null when
     * there is none). It is called at most once, outside the session lock.
     */
    fun decide(
        session: CaptureSession,
        pick: PageNumbers.Pick,
        spread: Boolean,
        name: String,
        second: (() -> PageNumbers.Pick)?,
        log: (String) -> Unit,
    ): Pair<List<Int>, List<Int>> {
        val none = emptyList<Int>()
        val nums = pick.nums
        if (nums.isEmpty()) {
            log("number [] for $name: nothing read; other picture not read")
            return Pair(none, none)
        }
        val rel = synchronized(session) { session.relation(nums, spread) }
        if (rel == "duplicate") return Pair(nums, none)
        if (rel == "expected" && pick.strong) return Pair(nums, none)
        if (rel == "lower" || rel == "far") {
            log("number $nums for $name is $rel; not kept")
            return Pair(none, none)
        }
        // A number read once (first page, a jump) is the page's guess: the
        // session keeps it when a neighbour confirms it.
        fun once(n: List<Int>, r: String, strong: Boolean) = if (strong && (r == "first" || r == "jump")) n else none
        val again = second?.invoke()
        // Printed as a folio: the page number, not body text — kept read
        // once, unless the other camera picture reads another number.
        // Run 24: "ー41-" on p41 and "ー4-" + "47" on p47 stayed guesses
        // (no second picture on the emulator) and both pages 番号なし.
        val folio = pick.framed && pick.strong && (rel == "first" || rel == "jump")
        if (folio && (again == null || again.nums.isEmpty() || again.nums.sorted() == nums.sorted() || PageNumbers.lostDigits(again.nums, nums))) {
            log("number $nums for $name: printed as a folio ($rel); kept")
            return Pair(nums, none)
        }
        if (again == null) {
            log("number $nums for $name: no second frame; ${if (rel == "first" && pick.strong) "kept" else "not kept"}")
            return if ((rel == "first" || rel == "expected") && pick.strong) Pair(nums, none) else Pair(none, once(nums, rel, pick.strong))
        }
        if (again.nums.isEmpty() && rel == "jump" && pick.strong &&
            synchronized(session) { session.singleReadJumpOk(nums, spread, name) }
        ) {
            log("number $nums for $name: one page skipped, read once; kept")
            return Pair(nums, none)
        }
        if (again.nums.sorted() == nums.sorted()) {
            log("number $nums for $name confirmed by a second read ($rel)")
            return Pair(nums, none)
        }
        // One read lost digits of the other ("3" for "31"): the longer one, read once.
        if (again.nums.isNotEmpty() && PageNumbers.lostDigits(again.nums, nums) && pick.strong) {
            log("number $nums for $name: second read ${again.nums} lost digits; guess")
            return Pair(none, once(nums, rel, true))
        }
        if (again.nums.isNotEmpty() && PageNumbers.lostDigits(nums, again.nums) && again.strong) {
            val r2 = synchronized(session) { session.relation(again.nums, spread) }
            log("number $nums for $name: lost digits of the second read ${again.nums} ($r2); guess")
            if (r2 == "expected") return Pair(again.nums, none)
            return Pair(none, once(again.nums, r2, true))
        }
        // Reads disagree: a spread may lose one number on one read.
        if (spread && again.nums.isNotEmpty() && again.nums.all { it in nums }) {
            val kept = again.nums.takeIf { synchronized(session) { session.relation(it, spread) } == "expected" }
            return if (kept != null) Pair(kept, none) else Pair(none, none)
        }
        if (again.nums.isEmpty() && rel == "first" && pick.strong) {
            // Nothing read on the other picture is no other number: the
            // first page is kept as when there is no second picture (run 25,
            // single-port-wood p3 stayed a guess, so 5–11 had nothing to
            // follow and stayed 番号なし).
            log("number $nums for $name: second read [] (first); kept")
            return Pair(nums, none)
        }
        if (again.nums.isEmpty()) {
            log("number $nums for $name not confirmed (second read []); guess")
            return Pair(none, once(nums, rel, pick.strong))
        }
        log("number $nums for $name not confirmed (second read ${again.nums}); not kept")
        return Pair(none, none)
    }

    /** What a page shows in the list: "✓ N", grey (番号なし), or still being read. */
    fun listMark(p: CaptureSession.Page): String = when (p.numberState) {
        "ok" -> "✓${CaptureSession.label(p.nums)}"
        "reading" -> "reading"
        else -> "grey"
    }

    /** What the banner says for one result: ✓ N, grey, red (N missing), filled, duplicate. */
    fun bannerMark(o: CaptureSession.Outcome): String = when (o) {
        is CaptureSession.Outcome.Taken -> "✓${CaptureSession.label(o.nums)}"
        is CaptureSession.Outcome.Unread -> "grey"
        is CaptureSession.Outcome.Filled -> "filled${CaptureSession.label(o.nums)}"
        is CaptureSession.Outcome.Gap -> "✓${CaptureSession.label(o.nums)} red${CaptureSession.label(o.missing)}"
        is CaptureSession.Outcome.Duplicate -> "duplicate${CaptureSession.label(o.nums)}"
    }
}
