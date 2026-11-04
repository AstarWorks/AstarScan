package com.astarworks.mlkitscanner

import java.text.Normalizer

/**
 * Printed page numbers ("ノンブル") from the text lines ML Kit read in a
 * page's top and bottom margins. A line-for-line port of
 * `packages/core/src/pipeline/page-numbers.ts` (parsePageNumberToken,
 * pickPageNumbers) and of the app's band-then-folio rule
 * (`apps/web/app/services/page-number-reader.ts`), so the capture screen
 * reads the same number the page list used to.
 */
object PageNumbers {
    /**
     * One recognised line; centre normalised to the page. `dashed`: read
     * on a tile whose dash marks on both sides of the print were painted
     * out before ML Kit saw it (MarginReader, the bottom centre strip):
     * the print was "— N —" although the text no longer shows the dashes.
     */
    data class Line(val text: String, val cx: Double, val cy: Double, val pass: String, val conf: Double = 0.0, val dashed: Boolean = false)

    enum class Kind(val score: Int) { ARABIC(3), KANJI(2), EDGE(1) }

    data class Token(val value: Int, val kind: Kind)

    /**
     * Numbers read, whether the best one was a whole-line number (not a
     * running-head edge), and whether every number was printed as a folio
     * ("— 39 —" at the bottom or top centre of its page, see [framedFor]).
     */
    data class Pick(val nums: List<Int>, val strong: Boolean, val framed: Boolean = false)

    const val MARGIN_FRAC = 0.15
    private const val MAX_PAGE_NUMBER = 3000
    private const val DECO = "\\s\\-–—―‐ー~〜・.,:()（）\\[\\]［］<>〈〉《》「」|｜*"
    private val DECORATION = Regex("^[$DECO]+|[$DECO]+$")
    private val KANJI_DIGIT = mapOf(
        '〇' to 0, '零' to 0, '一' to 1, '二' to 2, '三' to 3, '四' to 4,
        '五' to 5, '六' to 6, '七' to 7, '八' to 8, '九' to 9,
    )
    private val KANJI_UNIT = mapOf('十' to 10, '百' to 100, '千' to 1000)

    fun kanjiToNumber(s: String): Int? {
        if (s.isEmpty()) return null
        if (!s.all { it in KANJI_DIGIT || it in KANJI_UNIT }) return null
        if (s.none { it in KANJI_UNIT }) return s.fold(0) { n, c -> n * 10 + KANJI_DIGIT.getValue(c) }
        var total = 0
        var digit: Int? = null
        for (c in s) {
            val unit = KANJI_UNIT[c]
            if (unit != null) {
                total += (digit ?: 1) * unit
                digit = null
            } else {
                if (digit != null) return null
                digit = KANJI_DIGIT.getValue(c)
            }
        }
        return total + (digit ?: 0)
    }

    private fun valid(n: Int) = n in 1..MAX_PAGE_NUMBER

    fun parseToken(text: String): Token? {
        val raw = Normalizer.normalize(text, Normalizer.Form.NFKC).trim()
        if (raw.isEmpty()) return null
        var core = raw.replace(DECORATION, "").replace(Regex("\\s+"), "")
        if (Regex("\\d").containsMatchIn(core)) {
            core = core.replace(Regex("^一+|一+$"), "").replace(DECORATION, "")
        } else if (Regex("^一+$").matches(core)) {
            return null
        }
        val m = Regex("^(?:p\\.?|P\\.?)?(\\d{1,4})$").find(core)
            ?: Regex("^第?(\\d{1,4})(?:頁|ページ)$").find(core)
        if (m != null) {
            val v = m.groupValues[1].toInt()
            return if (valid(v)) Token(v, Kind.ARABIC) else null
        }
        val k = Regex("^第?([〇零一二三四五六七八九十百千]{1,6})(?:頁|ページ)?$").find(core)
        if (k != null) {
            val v = kanjiToNumber(k.groupValues[1])
            return if (v != null && valid(v)) Token(v, Kind.KANJI) else null
        }
        val edge = Regex("^(\\d{1,4})\\s+\\S").find(raw) ?: Regex("\\S\\s+(\\d{1,4})$").find(raw)
        if (edge != null) {
            val v = edge.groupValues[1].toInt()
            return if (valid(v)) Token(v, Kind.EDGE) else null
        }
        return null
    }

    private class Cand(val value: Int, val score: Double, val cx: Double, val top: Boolean)

    fun pick(lines: List<Line>, marginFrac: Double = MARGIN_FRAC, spread: Boolean = false): Pick {
        val cands = ArrayList<Cand>()
        for (l in lines) {
            val top = l.cy <= marginFrac
            val bottom = l.cy >= 1 - marginFrac
            if (!top && !bottom) continue
            val tok = parseToken(l.text) ?: continue
            val edgeDist = if (top) l.cy else 1 - l.cy
            cands.add(Cand(tok.value, tok.kind.score + (marginFrac - edgeDist) / marginFrac, l.cx, top))
        }
        if (cands.isEmpty()) return Pick(emptyList(), false)
        cands.sortByDescending { it.score }
        // A number that is another candidate with digits lost ("4" next to
        // "47", run 24: the same folio read twice in one picture) gives way
        // to the longer one when that is as strong a kind.
        val best = cands[0].let { b ->
            cands.firstOrNull { o ->
                o.top == b.top && o.score >= Kind.KANJI.score && b.score - o.score < 1.0 && lostDigits(listOf(b.value), listOf(o.value))
            } ?: b
        }
        val strong = best.score >= Kind.KANJI.score
        val other = cands.firstOrNull {
            it.score >= Kind.KANJI.score && it.top == best.top &&
                (it.cx < 0.5) != (best.cx < 0.5) && Math.abs(it.value - best.value) == 1
        }
        if (strong && other != null) {
            return Pick(listOf(minOf(best.value, other.value), maxOf(best.value, other.value)), true)
        }
        // A spread whose other folio was not read: its two pages are
        // consecutive, so the side the read one sits on gives the other
        // (left half N → N, N+1; right half N → N−1, N). Phone-resolution
        // stills, spread-port-white 2・3: "— 3 —" read, "— 2 —" next to the
        // left thumb not. Only a clearly one-sided, whole-line number.
        if (spread && strong && Math.abs(best.cx - 0.5) >= 0.1) {
            val pair = if (best.cx < 0.5) listOf(best.value, best.value + 1) else listOf(best.value - 1, best.value)
            if (pair.all { valid(it) }) return Pick(pair, true)
        }
        return Pick(listOf(best.value), strong)
    }

    /**
     * The band pass first; the folio pass when the band pass gives no
     * number, or a weaker one, or a number that is the folio's with digits
     * lost. Run 23, single-land-white p31: the folio piece (cut tight,
     * enlarged) read "ー31-", the whole band "ー3-"; the band's 3 won, the two
     * reads of the page disagreed (31 / 3) and the page went unnumbered.
     */
    fun pickNative(lines: List<Line>, spread: Boolean = false): Pick {
        val p = pickBandFolio(lines, spread)
        return if (p.strong && framedFor(p.nums, lines, spread)) p.copy(framed = true) else p
    }

    private fun pickBandFolio(lines: List<Line>, spread: Boolean): Pick {
        val band = pick(lines.filter { it.pass == "band" }, spread = spread)
        val folio = pick(lines.filter { it.pass == "folio" }, spread = spread)
        if (band.nums.isEmpty()) return folio
        if (folio.nums.isEmpty() || folio.nums == band.nums) return band
        if (folio.strong && !band.strong) return folio
        if (folio.strong && lostDigits(band.nums, folio.nums)) return folio
        return band
    }

    /**
     * Dash-like marks a folio is printed between, as ML Kit returns them
     * ("— 39 —" read as "ー41-", "ー4-", "一39一", "－39－", "―39―", "‐39‐").
     * After NFKC "－" is "-"; "一" (kanji one) is a dash only next to digits.
     */
    private const val DASHES = "ー―—–\\-‐－一~〜"
    private val FRAMED_NUMBER = Regex("^(?:[$DASHES]\\s*)+(\\d{1,4})(?:\\s*[$DASHES])*$|^(\\d{1,4})(?:\\s*[$DASHES])+$")

    /** The number of a line printed between dash-like marks ("ー41-", "ー39"), else null. */
    fun framedNumber(text: String): Int? {
        val s = Normalizer.normalize(text, Normalizer.Form.NFKC).trim()
        val m = FRAMED_NUMBER.find(s) ?: return null
        val v = (m.groupValues[1].ifEmpty { m.groupValues[2] }).toIntOrNull() ?: return null
        return v.takeIf { valid(it) }
    }

    private val PLAIN_NUMBER = Regex("^\\d{1,4}$")

    /**
     * A line's folio number: printed between dash marks in its text, or a
     * bare number read where the dash marks were painted out (`dashed`).
     */
    private fun folioNumber(l: Line): Int? {
        framedNumber(l.text)?.let { return it }
        if (!l.dashed) return null
        val s = Normalizer.normalize(l.text, Normalizer.Form.NFKC).trim()
        if (!PLAIN_NUMBER.matches(s)) return null
        return s.toInt().takeIf { valid(it) }
    }

    /** Where a folio sits: the centre of its page (a spread: of either half), in the top or bottom margin. */
    private fun folioSpot(l: Line, spread: Boolean): Boolean {
        val inMargin = l.cy <= MARGIN_FRAC || l.cy >= 1 - MARGIN_FRAC
        val centred = if (spread) Math.abs(l.cx - 0.25) <= 0.12 || Math.abs(l.cx - 0.75) <= 0.12 else Math.abs(l.cx - 0.5) <= 0.15
        return inMargin && centred
    }

    /**
     * Every number of `nums` is printed as a folio: a line "— N —" (a
     * number between dash-like marks, one side may be lost) at the top or
     * bottom centre of its page. A dashed line that lost digits ("ー4-")
     * counts for the longer number ("47") read next to it, also centred
     * (run 24, single-land-white p47: "ー4-" and "47", conf 0.55, cy 0.95).
     * Run 24 read "ー41-" (conf 0.25, cx 0.456 cy 0.936) on p41 and the page
     * stayed 番号なし: the parser took 41, but a number read once on a page
     * with no second camera picture was only a guess (CaptureActivity.confirm).
     * A folio printed that way is not body text, so the screen keeps it.
     * No ML Kit confidence threshold: ML Kit's line confidence for these
     * tiny folios is 0.25–0.55 also when right.
     */
    fun framedFor(nums: List<Int>, lines: List<Line>, spread: Boolean): Boolean {
        if (nums.isEmpty()) return false
        val spots = lines.filter { folioSpot(it, spread) }
        return nums.all { n ->
            spots.any spot@{ l ->
                val v = folioNumber(l) ?: return@spot false
                v == n || (lostDigits(listOf(v), listOf(n)) && spots.any { o ->
                    parseToken(o.text)?.value == n && Math.abs(o.cx - l.cx) <= 0.08 && Math.abs(o.cy - l.cy) <= 0.04
                })
            }
        }
    }

    /** Every number of `short` is one of `long` with digits dropped ("3" for "31", "4" for "41"). */
    fun lostDigits(short: List<Int>, long: List<Int>): Boolean =
        short.size <= long.size && short.all { s ->
            long.any { l -> l.toString().length > s.toString().length && subsequence(s.toString(), l.toString()) }
        }

    private fun subsequence(a: String, b: String): Boolean {
        var i = 0
        for (c in b) if (i < a.length && a[i] == c) i++
        return i == a.length
    }
}
