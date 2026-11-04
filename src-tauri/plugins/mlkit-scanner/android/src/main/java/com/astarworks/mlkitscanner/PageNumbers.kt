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
    /** One recognised line; centre normalised to the page. */
    data class Line(val text: String, val cx: Double, val cy: Double, val pass: String, val conf: Double = 0.0)

    enum class Kind(val score: Int) { ARABIC(3), KANJI(2), EDGE(1) }

    data class Token(val value: Int, val kind: Kind)

    /** Numbers read, and whether the best one was a whole-line number (not a running-head edge). */
    data class Pick(val nums: List<Int>, val strong: Boolean)

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

    fun pick(lines: List<Line>, marginFrac: Double = MARGIN_FRAC): Pick {
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
        val best = cands[0]
        val strong = best.score >= Kind.KANJI.score
        val other = cands.firstOrNull {
            it.score >= Kind.KANJI.score && it.top == best.top &&
                (it.cx < 0.5) != (best.cx < 0.5) && Math.abs(it.value - best.value) == 1
        }
        if (strong && other != null) {
            return Pick(listOf(minOf(best.value, other.value), maxOf(best.value, other.value)), true)
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
    fun pickNative(lines: List<Line>): Pick {
        val band = pick(lines.filter { it.pass == "band" })
        val folio = pick(lines.filter { it.pass == "folio" })
        if (band.nums.isEmpty()) return folio
        if (folio.nums.isEmpty() || folio.nums == band.nums) return band
        if (folio.strong && !band.strong) return folio
        if (folio.strong && lostDigits(band.nums, folio.nums)) return folio
        return band
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
