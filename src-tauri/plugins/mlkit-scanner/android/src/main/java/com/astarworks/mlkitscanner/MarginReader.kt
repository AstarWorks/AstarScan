package com.astarworks.mlkitscanner

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import com.google.android.gms.tasks.OnCompleteListener
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Text in the top and bottom margins of a page (where the printed page
 * number sits), read with ML Kit Text Recognition v2 (Japanese model, also
 * reads Latin; bundled in the APK, runs on the device). Used by the capture
 * screen on every page it takes, and by the `readMargins` command for pages
 * restored from an earlier session.
 *
 * Two passes, as before (emulator runs 8–18), ONE ML Kit call each:
 * - "band": the top and bottom margin bands, each enlarged to `minWidth`;
 * - "folio": short, isolated pieces of print in those bands (a page number
 *   such as "— 31 —" stands alone, far from other text), each cut out
 *   tightly and enlarged so its text is ~FOLIO_TEXT_PX tall. The caller uses
 *   these lines only when the band pass gives no number.
 * Blocking: call from a worker thread.
 */
object MarginReader {
    private const val FOLIO_TEXT_PX = 48
    /** Grey the darkest ink of a folio piece is mapped to (see [levels]). */
    private const val INK_LEVEL = 96f
    /**
     * Pieces of print per band in the first picture, most isolated first.
     * Run 25: up to 4 a band with the extra renderings made pictures of
     * 11–15 tiles (~1000x2100–3300 px), one call ~10.7 s next to the camera
     * and 9 calls over the 20 s timeout; run 23's 5–7 tiles took ~6.8 s.
     */
    private const val MAX_FOLIO_SEGMENTS = 3
    /** Pieces from the top band (running head), fewer: every tile makes the picture taller. */
    private const val MAX_FOLIO_SEGMENTS_TOP = 2
    /** Height of the top / bottom centre strips (share of the page height). */
    private const val CENTER_STRIP_FRAC = 0.07
    /** Height of a spread's bottom strip (share of its height). */
    private const val SPREAD_STRIP_FRAC = 0.10
    /** Width of a single page's bottom outer-corner tiles (share of its width). */
    private const val CORNER_FRAC = 0.22
    /** A page number's height as a share of the page height (~9–10 px on a 1040 px page). */
    private const val FOLIO_TEXT_FRAC = 0.009
    /** A spread's spots (shares of its width, bottom strip): outer left corner, middle of the left page, middle of the right page, outer right corner. */
    private val SPREAD_SPOTS = arrayOf(
        doubleArrayOf(0.0, 0.16), doubleArrayOf(0.17, 0.33), doubleArrayOf(0.67, 0.83), doubleArrayOf(0.84, 1.0),
    )
    private const val SPREAD_UP_MAX = 5f
    /** White rows between the pieces put into one picture. */
    private const val GAP_PX = 24
    /**
     * How long a caller waits for one recognition. Generous: the bitmap
     * stays ML Kit's until its task ends either way, and the real time of
     * every call is logged ("ocr …") when it ends.
     */
    private const val RECOGNIZE_TIMEOUT_MS = 35_000L
    /**
     * A call that timed out still runs inside ML Kit; the next call waits
     * up to this long for it first. Run 21 started a new call after every
     * 20 s timeout, ML Kit queued them, and single calls then took 70–180 s.
     */
    private const val PREVIOUS_WAIT_MS = 60_000L
    /** A whole page (Markdown save) takes longer than the margins. */
    private const val PAGE_TIMEOUT_MS = 60_000L
    private const val TAG = "AstarScanMlkit"
    /** The last call handed to ML Kit (one at a time, see PREVIOUS_WAIT_MS). */
    private var inFlight: Task<Text>? = null
    private val callLock = Any()

    private val recognizer by lazy {
        TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())
    }
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)

    fun read(page: Bitmap, marginFrac: Double = PageNumbers.MARGIN_FRAC, minWidth: Int = 1600, folio: Boolean = true): List<PageNumbers.Line> {
        val out = ArrayList<PageNumbers.Line>()
        out.addAll(bandLines(page, marginFrac, minWidth))
        if (folio) out.addAll(folioLines(page, marginFrac))
        return out
    }

    /**
     * Load the model and run it once on a tiny picture, so the first page
     * does not wait for that (logged as "ocr warmup").
     */
    fun warmUp() {
        val b = Bitmap.createBitmap(320, 96, Bitmap.Config.ARGB_8888)
        Canvas(b).apply {
            drawColor(Color.WHITE)
            drawText("12", 120f, 70f, Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 56f; color = Color.BLACK })
        }
        recognize(b, "warmup")
    }

    /**
     * The top and bottom margin bands, each enlarged to `minWidth`, read in
     * ONE recognition (stacked into one picture). Run 20: one call per band
     * and per piece of print (up to 10 a page) took 60–80 s a page on the
     * CI emulator; one call costs about the same as each of those.
     */
    fun bandLines(page: Bitmap, marginFrac: Double, minWidth: Int): List<PageNumbers.Line> =
        recognizeTiles(page, bandTiles(page, marginFrac, minWidth), "band")

    /**
     * The band tiles AND the folio tiles in ONE picture, one ML Kit call
     * (run 22: band then folio = two calls of ~9 s each on the CI emulator
     * while pages are taken; the number came 14 s after the page, 32 s with
     * the second read). Lines keep their pass ("band" / "folio"), so the
     * caller still prefers the band's number (PageNumbers.pickNative).
     */
    fun marginLines(page: Bitmap, bandFrac: Double, folioFrac: Double, minWidth: Int, what: String = "margins"): List<PageNumbers.Line> =
        recognizeTiles(page, bandTiles(page, bandFrac, minWidth) + folioTiles(page, folioFrac), what)

    /**
     * The other renderings of where a single page's folio sits (see
     * [extraTiles]), in ONE more call: only when the first picture
     * ([marginLines]) gave no number, so a page whose number reads at
     * once costs one call. Empty for a spread (no call).
     */
    fun extraLines(page: Bitmap, what: String = "extra"): List<PageNumbers.Line> {
        val tiles = extraTiles(page)
        if (tiles.isEmpty()) return emptyList()
        return recognizeTiles(page, tiles, what)
    }

    private fun bandTiles(page: Bitmap, marginFrac: Double, minWidth: Int): List<Tile> {
        val w = page.width
        val h = page.height
        val band = (h * marginFrac.coerceIn(0.02, 0.5)).toInt().coerceAtLeast(1)
        // To minWidth either way: a wider band only costs recognition time
        // (the camera saw the page at well under 1000 px).
        val up = (minWidth.toFloat() / w).coerceIn(0.25f, 4f)
        return listOf(
            Tile(Rect(0, 0, w, band), up),
            Tile(Rect(0, h - band, w, h), up),
        )
    }

    /** The picture `bandLines` hands to ML Kit (for [timeAlone]). */
    fun bandPicture(page: Bitmap, marginFrac: Double, minWidth: Int): Bitmap = compose(page, bandTiles(page, marginFrac, minWidth))

    /** The picture `marginLines` hands to ML Kit (for [timeAlone]). */
    fun marginPicture(page: Bitmap, bandFrac: Double, folioFrac: Double, minWidth: Int): Bitmap =
        compose(page, bandTiles(page, bandFrac, minWidth) + folioTiles(page, folioFrac))

    /**
     * One ML Kit call on `pic` (consumed), logged as "ocr solo …": the
     * capture screen runs it when it closes, with the camera stopped and
     * no page being read, so the log shows what one call costs on this
     * device alone next to the calls made while pages were being taken.
     */
    fun timeAlone(pic: Bitmap, note: String) {
        Log.i(TAG, "solo call ($note)")
        recognize(pic, "solo 1")
    }

    /**
     * Short, isolated pieces of print in the margin bands (a page number
     * such as "— 31 —" stands alone), each cut out and enlarged so its text
     * is ~FOLIO_TEXT_PX tall, all read in ONE recognition (one under the
     * other in one picture).
     */
    fun folioLines(page: Bitmap, marginFrac: Double): List<PageNumbers.Line> {
        val tiles = folioTiles(page, marginFrac)
        if (tiles.isEmpty()) return emptyList()
        return recognizeTiles(page, tiles, "folio")
    }

    private fun folioTiles(page: Bitmap, marginFrac: Double): List<Tile> {
        val w = page.width
        val h = page.height
        val band = (h * marginFrac.coerceIn(0.02, 0.5)).toInt().coerceAtLeast(1)
        val tiles = ArrayList<Tile>()
        for (top in listOf(true, false)) {
            val y0 = if (top) 0 else h - band
            // Fewer at the top (running head) than at the bottom: every tile
            // makes the one picture taller, and run 25's ~2900 px pictures
            // took 15–23 s on the CI emulator (20 s timeouts, pages unread).
            for (seg in printSegments(page, y0, band).take(if (top) MAX_FOLIO_SEGMENTS_TOP else MAX_FOLIO_SEGMENTS)) {
                val sh = seg[3] - seg[1]
                val sw = seg[2] - seg[0]
                val padX = sh * 3
                val padY = sh
                val x0 = (seg[0] - padX).coerceAtLeast(0)
                val x1 = (seg[2] + padX).coerceAtMost(w)
                val ry0 = (seg[1] - padY).coerceAtLeast(0)
                val ry1 = (seg[3] + padY).coerceAtMost(h)
                if (x1 - x0 < 4 || ry1 - ry0 < 4 || sw < 2) continue
                val up = (FOLIO_TEXT_PX.toFloat() / sh).coerceIn(1f, 8f)
                tiles.add(Tile(Rect(x0, ry0, x1, ry1), up, "folio"))
            }
        }
        // Where a folio usually sits: the middle of the bottom margin, cut
        // out whether or not a piece was found there (run 22:
        // single-land-white's "— 33 —" next to a thumb was found on 1 page
        // of 10). On a spread (wider than tall) the middle of each page's
        // bottom margin and the outer bottom corners instead, enlarged more:
        // its numbers are ~5 px tall in the CI emulator's 960×1280 picture.
        val strip = (h * CENTER_STRIP_FRAC).toInt().coerceAtLeast(4)
        val textPx = h * FOLIO_TEXT_FRAC
        if (w > h) {
            val upS = (FOLIO_TEXT_PX / textPx).toFloat().coerceIn(1f, SPREAD_UP_MAX)
            // A deeper strip than a single page's: the spread's frame
            // (DocAligner corners + edge fit) can sit a few % low, and the
            // folio's top is ~6 % above the paper's bottom edge.
            val y0 = h - (h * SPREAD_STRIP_FRAC).toInt().coerceAtLeast(4)
            for (fr in SPREAD_SPOTS) {
                tiles.add(Tile(Rect((w * fr[0]).toInt(), y0, (w * fr[1]).toInt(), h), upS, "folio"))
            }
        } else {
            // The bottom centre strip, up to 4× (at 2.5× run 24 read
            // single-land-white's "— 33 —" on 2 pages of 10), with the dash
            // marks of a "— N —" folio painted out ([dashMarks]): on the
            // phone-resolution stills ML Kit read "ー 35 一" at conf ~0.55
            // and the same print without its dashes ("35") at ~0.94; at
            // the CI emulator's 960x1280 the dashed line was dropped on 8
            // of 10 pages (run 26), while single-port-wood's bare "25", as
            // tall and as grey (~12 px, ink ~65 below the paper), read on
            // 12 of 12. The piece tiles above keep the print as it is.
            // The top strip and the other renderings are in [extraTiles].
            val upC = (FOLIO_TEXT_PX / textPx).toFloat().coerceIn(1f, 4f)
            tiles.add(Tile(Rect((w * 0.33).toInt(), h - strip, (w * 0.67).toInt(), h), upC, "folio", maskDashes = true))
        }
        return tiles
    }

    /**
     * A single page's second chance, for [extraLines]: the bottom centre
     * strip twice more, drawn differently (3×; 4× without the level
     * stretch — run 24 read a "— N —" folio on 4 of 10 pages, a different
     * one from picture to picture of the same page), the bottom outer
     * corners as drawn (no level stretch: a thumb in the corner would set
     * the levels; run 24, single-port-wood p7, p9, p11: the folio touches
     * the thumb, its ink joins the thumb's blob, which is too big for a
     * character and dropped by printSegments) and the top centre strip.
     * None for a spread.
     */
    private fun extraTiles(page: Bitmap): List<Tile> {
        val w = page.width
        val h = page.height
        if (w > h) return emptyList()
        val strip = (h * CENTER_STRIP_FRAC).toInt().coerceAtLeast(4)
        val upC = (FOLIO_TEXT_PX / (h * FOLIO_TEXT_FRAC)).toFloat().coerceIn(1f, 4f)
        val bottom = Rect((w * 0.33).toInt(), h - strip, (w * 0.67).toInt(), h)
        val cw = (w * CORNER_FRAC).toInt().coerceAtLeast(4)
        val upK = (upC * 0.55f).coerceAtLeast(1f)
        return listOf(
            Tile(bottom, (upC * 0.75f).coerceAtLeast(1f), "folio"),
            Tile(bottom, upC, "folio", stretch = false),
            // At ~2.2× (c7a9b3d): these folios are body size (~12 px on the
            // CI emulator), larger than "— N —" read in the centre strip.
            Tile(Rect(0, h - strip, cw, h), upK, "folio", stretch = false),
            Tile(Rect(w - cw, h - strip, w, h), upK, "folio", stretch = false),
            Tile(Rect((w * 0.33).toInt(), 0, (w * 0.67).toInt(), strip), upC, "folio"),
        )
    }

    /**
     * All the text of a page (for the Markdown file): one ML Kit call on
     * `page`, which is consumed (recycled when the call ends). Paragraphs
     * are ML Kit's blocks, top to bottom; lines keep their order.
     */
    fun pageText(page: Bitmap): List<List<String>> {
        val text = recognize(page, "page", PAGE_TIMEOUT_MS) ?: return emptyList()
        return text.textBlocks
            .sortedWith(compareBy({ it.boundingBox?.top ?: 0 }, { it.boundingBox?.left ?: 0 }))
            .map { b -> b.lines.map { it.text.trim() }.filter { it.isNotEmpty() } }
            .filter { it.isNotEmpty() }
    }

    /** Lines as JSON for the log lines the emulator check reads (book-measure.py). */
    fun json(lines: List<PageNumbers.Line>): String = lines.joinToString(",", "[", "]") { l ->
        "{\"text\":${quote(l.text)},\"conf\":${l.conf},\"cx\":${l.cx},\"cy\":${l.cy},\"pass\":\"${l.pass}\"${if (l.dashed) ",\"dashed\":true" else ""}}"
    }

    private fun quote(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> b.append("\\\"")
                c == '\\' -> b.append("\\\\")
                c < ' ' -> b.append(String.format("\\u%04x", c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }

    /** A region of the page and how much it is enlarged in the picture read. */
    private class Tile(
        val src: Rect,
        val up: Float,
        val pass: String = "band",
        val stretch: Boolean = pass == "folio",
        /** Paint out the dash marks of a "— N —" folio before ML Kit reads the tile ([dashMarks]). */
        val maskDashes: Boolean = false,
    ) {
        val outW: Int get() = (src.width() * up).toInt().coerceAtLeast(1)
        val outH: Int get() = (src.height() * up).toInt().coerceAtLeast(1)
        var top = 0
        /** Dash marks were found on both sides of the print and painted out. */
        var dashed = false
    }

    /**
     * The tiles one under the other (white between them) in one picture,
     * read once; each line goes back to the tile its centre falls in, its
     * centre normalised to the page.
     */
    private fun recognizeTiles(page: Bitmap, tiles: List<Tile>, pass: String): List<PageNumbers.Line> {
        val pic = compose(page, tiles)
        val text = recognize(pic, "$pass ${tiles.size}") ?: return emptyList()
        val out = ArrayList<PageNumbers.Line>()
        for (block in text.textBlocks) {
            for (line in block.lines) {
                val box = line.boundingBox ?: continue
                val bx = box.exactCenterX()
                val by = box.exactCenterY()
                val t = tiles.firstOrNull { by >= it.top - GAP_PX / 2f && by < it.top + it.outH + GAP_PX / 2f } ?: continue
                out.add(
                    PageNumbers.Line(
                        text = line.text,
                        cx = ((t.src.left + bx / t.up) / page.width).toDouble(),
                        cy = ((t.src.top + (by - t.top) / t.up) / page.height).toDouble(),
                        pass = t.pass,
                        conf = line.confidence.toDouble(),
                        dashed = t.dashed,
                    ),
                )
            }
        }
        return out
    }

    /** The tiles one under the other, white between them (sets each tile's `top`). */
    private fun compose(page: Bitmap, tiles: List<Tile>): Bitmap {
        var y = 0
        var cw = 1
        for (t in tiles) {
            t.top = y
            y += t.outH + GAP_PX
            cw = maxOf(cw, t.outW)
        }
        val ch = (y - GAP_PX).coerceAtLeast(1)
        val pic = Bitmap.createBitmap(cw, ch, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(pic)
        canvas.drawColor(Color.WHITE)
        for (t in tiles) {
            canvas.drawBitmap(page, t.src, Rect(0, t.top, t.outW, t.top + t.outH), if (t.stretch) levels(page, t.src) else paint)
            if (t.maskDashes) maskDashes(page, t, canvas)
        }
        return pic
    }

    /**
     * Paints the tile's dash marks ([dashMarks]) over with the paper: white
     * when the tile's levels are stretched (paper → white), else the paper
     * grey. Sets `t.dashed` when there were marks on both sides of the print.
     */
    private fun maskDashes(page: Bitmap, t: Tile, canvas: Canvas) {
        val m = dashMarks(page, t.src) ?: return
        if (m.rects.isEmpty()) return
        t.dashed = m.bothSides
        val fill = Paint().apply { color = if (t.stretch) Color.WHITE else Color.rgb(m.paper, m.paper, m.paper) }
        for (r in m.rects) {
            canvas.drawRect(
                (r.left - 1) * t.up,
                t.top + (r.top - 1) * t.up,
                (r.right + 1) * t.up,
                t.top + (r.bottom + 1) * t.up,
                fill,
            )
        }
    }

    /** Dash marks in a tile (tile px), whether they sit on both sides of the print, the paper grey. */
    private class DashMarks(val rects: List<Rect>, val bothSides: Boolean, val paper: Int)

    /**
     * The dash marks of a "— N —" folio in `src` of `page`: ink (darker than
     * halfway between the paper, 90th percentile, and the darkest ink, 0.5th)
     * split into connected blobs; the print's height is the tallest blob
     * that looks like a character (≥ 6 px, at most 3× as wide as tall, under
     * 60 % of the tile); a dash is a blob at most 0.45× that height, 2.5× as
     * wide as tall or more, at most 3× the print's height long, on the
     * print's row and within 2× its height of a character. Thresholded at
     * halfway, not at 0.75× the paper as in [printSegments]: the 4 px dashes
     * of the CI emulator's picture are lighter than the digits (run 26:
     * paper ~205, darkest ink ~141). Measured on run 26's pages: the dashes
     * of all 10 single-land-white folios, nothing on single-port-wood.
     */
    private fun dashMarks(page: Bitmap, src: Rect): DashMarks? {
        val w = src.width()
        val h = src.height()
        if (w < 8 || h < 8) return null
        val px = IntArray(w * h)
        page.getPixels(px, 0, w, src.left, src.top, w, h)
        val lum = IntArray(px.size) { i ->
            val c = px[i]
            ((c shr 16 and 0xff) * 299 + (c shr 8 and 0xff) * 587 + (c and 0xff) * 114) / 1000
        }
        val hist = IntArray(256)
        for (v in lum) hist[v]++
        fun pct(f: Double): Int {
            var acc = 0
            for (i in 0..255) {
                acc += hist[i]
                if (acc >= lum.size * f) return i
            }
            return 255
        }
        val paper = pct(0.90)
        val ink = pct(0.005)
        if (paper - ink < 24) return null
        val thr = (paper + ink) / 2
        val label = BooleanArray(w * h)
        val stack = IntArray(w * h)
        val blobs = ArrayList<Rect>()
        for (start in lum.indices) {
            if (label[start] || lum[start] >= thr) continue
            var top = 0
            stack[top++] = start
            label[start] = true
            var l = start % w
            var r = l
            var tt = start / w
            var b = tt
            var area = 0
            while (top > 0) {
                val p = stack[--top]
                area++
                val x = p % w
                val y = p / w
                if (x < l) l = x
                if (x > r) r = x
                if (y < tt) tt = y
                if (y > b) b = y
                for (dy in -1..1) for (dx in -1..1) {
                    val nx = x + dx
                    val ny = y + dy
                    if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
                    val q = ny * w + nx
                    if (!label[q] && lum[q] < thr) {
                        label[q] = true
                        stack[top++] = q
                    }
                }
            }
            if (area >= 3) blobs.add(Rect(l, tt, r + 1, b + 1))
        }
        val rowH = blobs.filter { it.height() >= 6 && it.height() <= h * 0.6 && it.width() <= 3 * it.height() }.maxOfOrNull { it.height() }
            ?: return DashMarks(emptyList(), false, paper)
        val glyphs = blobs.filter { it.height() >= 0.6 * rowH }
        val rects = ArrayList<Rect>()
        var left = false
        var right = false
        for (d in blobs) {
            val dh = d.height()
            val dw = d.width()
            if (dh > maxOf(3.0, 0.45 * rowH) || dw < 2.5 * dh || dw > 3 * rowH) continue
            val cy = d.exactCenterY()
            val near = glyphs.filter { g ->
                Math.abs(g.exactCenterY() - cy) <= 0.6 * rowH &&
                    minOf(Math.abs(g.left - d.right), Math.abs(d.left - g.right)) <= 2 * rowH
            }
            if (near.isEmpty()) continue
            rects.add(d)
            if (near.all { d.right <= it.left + 1 }) left = true
            if (near.all { d.left >= it.right - 1 }) right = true
        }
        return DashMarks(rects, left && right, paper)
    }

    /**
     * A paint that stretches the levels of `src` in `page`: its paper (90th
     * percentile of brightness) to white, its darkest ink (1st percentile)
     * to INK_LEVEL grey, linearly, nothing clipped. Small digits in the CI
     * emulator's camera picture are faint grey on grey (run 13). Run 23 took
     * the darkest ink to black: the blurred halo of 9 px digits went black
     * too, "35", "43", "45" became blobs and ML Kit read nothing on 7 of 10
     * pages of single-land-white; with the ink at mid grey the strokes stay
     * apart.
     */
    private fun levels(page: Bitmap, src: Rect): Paint {
        val w = src.width()
        val h = src.height()
        if (w < 2 || h < 2) return paint
        val px = IntArray(w * h)
        page.getPixels(px, 0, w, src.left, src.top, w, h)
        val hist = IntArray(256)
        for (c in px) hist[((c shr 16 and 0xff) * 299 + (c shr 8 and 0xff) * 587 + (c and 0xff) * 114) / 1000]++
        fun pct(f: Double): Int {
            var acc = 0
            for (i in 0..255) {
                acc += hist[i]
                if (acc >= px.size * f) return i
            }
            return 255
        }
        val ink = pct(0.01)
        val white = pct(0.90)
        if (white - ink < 24) return paint
        val k = (255f - INK_LEVEL) / (white - ink)
        val off = 255f - white * k
        val m = ColorMatrix(
            floatArrayOf(
                k, 0f, 0f, 0f, off,
                0f, k, 0f, 0f, off,
                0f, 0f, k, 0f, off,
                0f, 0f, 0f, 1f, 0f,
            ),
        )
        return Paint(Paint.FILTER_BITMAP_FLAG).apply { colorFilter = ColorMatrixColorFilter(m) }
    }

    /**
     * One ML Kit call on `input`, which is ML Kit's from here on: recycled
     * when its task ends, never before (run 20: recycling it on a timeout
     * left ML Kit reading recycled bitmaps). Logs the call's real time.
     * Null when it fails or does not end within RECOGNIZE_TIMEOUT_MS.
     */
    private fun recognize(input: Bitmap, what: String, timeoutMs: Long = RECOGNIZE_TIMEOUT_MS): Text? = synchronized(callLock) {
        val prev = inFlight
        if (prev != null && !prev.isComplete) {
            val tw = SystemClock.elapsedRealtime()
            try {
                Tasks.await(prev, PREVIOUS_WAIT_MS, TimeUnit.MILLISECONDS)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
            } catch (_: Exception) {
            }
            Log.i(TAG, "waited ${SystemClock.elapsedRealtime() - tw}ms for the previous call before $what")
        }
        val w = input.width
        val h = input.height
        val t0 = SystemClock.elapsedRealtime()
        val task = recognizer.process(InputImage.fromBitmap(input, 0))
        inFlight = task
        task.addOnCompleteListener(
            Executor { it.run() },
            OnCompleteListener<Text> { t ->
                val ms = SystemClock.elapsedRealtime() - t0
                Log.i(TAG, "ocr $what ${w}x$h ${ms}ms ${if (t.isSuccessful) "ok" else "failed ${t.exception?.message}"}")
                input.recycle()
            },
        )
        try {
            Tasks.await(task, timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            Log.w(TAG, "text recognition timed out ($what ${w}x$h)")
            null
        } catch (e: ExecutionException) {
            Log.w(TAG, "text recognition failed ($what ${w}x$h): ${e.cause?.message}")
            null
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            null
        }
    }

    /**
     * Short, isolated pieces of print in rows [y0, y0 + bh) of the page,
     * most isolated first, each [left, top, right, bottom] in page pixels.
     * Ink = darker than 0.75× the paper (90th percentile; small digits on
     * the emulator camera are faint grey). Ink is split into connected
     * blobs; blobs bigger than a character (a thumb, a rule, a figure) and
     * specks under 4 px are dropped; the rest are joined left to right into
     * pieces of one text row (gap ≤ 1.5× the row height). Pieces wider than
     * 12× their height are body text and dropped. Isolation is the gap to
     * the nearest other piece in row heights — a page number stands alone.
     */
    private fun printSegments(page: Bitmap, y0: Int, bh: Int): List<IntArray> {
        val w = page.width
        val h = page.height
        val px = IntArray(w * bh)
        page.getPixels(px, 0, w, 0, y0, w, bh)
        val lum = IntArray(px.size) { i ->
            val c = px[i]
            ((c shr 16 and 0xff) * 299 + (c shr 8 and 0xff) * 587 + (c and 0xff) * 114) / 1000
        }
        val hist = IntArray(256)
        for (v in lum) hist[v]++
        var acc = 0
        var paper = 255
        for (v in 255 downTo 0) {
            acc += hist[v]
            if (acc >= lum.size / 10) { paper = v; break }
        }
        val ink = (paper * 0.75).toInt()
        // Leave out the outer 3 % (page edges, gutter shadow).
        val xa = (w * 0.03).toInt()
        val xb = w - xa
        val minH = (h * 0.004).toInt().coerceAtLeast(2)
        val maxH = (h * 0.04).toInt().coerceAtLeast(minH + 1)
        // Connected blobs (8-neighbours), iterative flood fill.
        val label = IntArray(w * bh)
        val stack = IntArray(w * bh)
        val blobs = ArrayList<IntArray>()
        for (start in label.indices) {
            val sx = start % w
            if (sx < xa || sx >= xb || label[start] != 0 || lum[start] >= ink) continue
            var top = 0
            stack[top++] = start
            label[start] = 1
            var l = sx
            var r = sx
            var t = start / w
            var b = t
            var area = 0
            while (top > 0) {
                val p = stack[--top]
                area++
                val x = p % w
                val y = p / w
                if (x < l) l = x
                if (x > r) r = x
                if (y < t) t = y
                if (y > b) b = y
                for (dy in -1..1) for (dx in -1..1) {
                    val nx = x + dx
                    val ny = y + dy
                    if (nx < xa || nx >= xb || ny < 0 || ny >= bh) continue
                    val q = ny * w + nx
                    if (label[q] == 0 && lum[q] < ink) {
                        label[q] = 1
                        stack[top++] = q
                    }
                }
            }
            val bw = r - l + 1
            val bhh = b - t + 1
            if (area < 4 || bhh > maxH || bw > maxH * 3) continue
            blobs.add(intArrayOf(l, t, r + 1, b + 1))
        }
        blobs.sortBy { it[0] }
        val pieces = ArrayList<IntArray>()
        for (c in blobs) {
            var joined = false
            for (g in pieces) {
                val gh = maxOf(g[3] - g[1], c[3] - c[1], minH)
                val cy = (c[1] + c[3]) / 2.0
                val gy = (g[1] + g[3]) / 2.0
                if (Math.abs(cy - gy) <= gh * 0.6 && c[0] - g[2] <= gh * 1.5) {
                    g[0] = minOf(g[0], c[0]); g[1] = minOf(g[1], c[1])
                    g[2] = maxOf(g[2], c[2]); g[3] = maxOf(g[3], c[3])
                    joined = true
                    break
                }
            }
            if (!joined) pieces.add(c.copyOf())
        }
        val scored = ArrayList<Pair<Double, IntArray>>()
        for ((i, g) in pieces.withIndex()) {
            val gh = g[3] - g[1]
            val gw = g[2] - g[0]
            if (gh < minH || gw > gh * 12) continue
            var iso = bh.toDouble()
            for ((j, o) in pieces.withIndex()) {
                if (j == i) continue
                val d = maxOf(maxOf(o[0] - g[2], g[0] - o[2]), maxOf(o[1] - g[3], g[1] - o[3]))
                if (d < iso) iso = d.toDouble()
            }
            scored.add(Pair(iso / gh, intArrayOf(g[0], g[1] + y0, g[2], g[3] + y0)))
        }
        return scored.sortedByDescending { it.first }.map { it.second }
    }}
