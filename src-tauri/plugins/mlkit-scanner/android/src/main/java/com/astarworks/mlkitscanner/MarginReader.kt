package com.astarworks.mlkitscanner

import android.graphics.Bitmap
import android.util.Log
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Text in the top and bottom margins of a page (where the printed page
 * number sits), read with ML Kit Text Recognition v2 (Japanese model, also
 * reads Latin; bundled in the APK, runs on the device). Used by the capture
 * screen on every page it takes, and by the `readMargins` command for pages
 * restored from an earlier session.
 *
 * Two passes, as before (emulator runs 8–18):
 * - "band": the top and bottom margin bands, each enlarged to `minWidth`;
 * - "folio": short, isolated pieces of print in those bands (a page number
 *   such as "— 31 —" stands alone, far from other text), each cut out
 *   tightly and enlarged so its text is ~FOLIO_TEXT_PX tall. The caller uses
 *   these lines only when the band pass gives no number.
 * Blocking: call from a worker thread.
 */
object MarginReader {
    private const val FOLIO_TEXT_PX = 48
    private const val MAX_FOLIO_SEGMENTS = 4
    private const val RECOGNIZE_TIMEOUT_S = 8L

    private val recognizer by lazy {
        TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())
    }

    fun read(page: Bitmap, marginFrac: Double = PageNumbers.MARGIN_FRAC, minWidth: Int = 1600, folio: Boolean = true): List<PageNumbers.Line> {
        val out = ArrayList<PageNumbers.Line>()
        out.addAll(bandLines(page, marginFrac, minWidth))
        if (folio) out.addAll(folioLines(page, marginFrac))
        return out
    }

    fun bandLines(page: Bitmap, marginFrac: Double, minWidth: Int): List<PageNumbers.Line> {
        val w = page.width
        val h = page.height
        val band = (h * marginFrac.coerceIn(0.02, 0.5)).toInt().coerceAtLeast(1)
        val out = ArrayList<PageNumbers.Line>()
        val up = (minWidth.toFloat() / w).coerceIn(1f, 4f)
        for (top in listOf(true, false)) {
            val y0 = if (top) 0 else h - band
            recognizeRegion(page, 0, y0, w, band, up, "band", out)
        }
        return out
    }

    fun folioLines(page: Bitmap, marginFrac: Double): List<PageNumbers.Line> {
        val w = page.width
        val h = page.height
        val band = (h * marginFrac.coerceIn(0.02, 0.5)).toInt().coerceAtLeast(1)
        val out = ArrayList<PageNumbers.Line>()
        for (top in listOf(true, false)) {
            val y0 = if (top) 0 else h - band
            for (seg in printSegments(page, y0, band).take(MAX_FOLIO_SEGMENTS)) {
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
                recognizeRegion(page, x0, ry0, x1 - x0, ry1 - ry0, up, "folio", out)
            }
        }
        return out
    }

    /** Lines as JSON for the log lines the emulator check reads (book-measure.py). */
    fun json(lines: List<PageNumbers.Line>): String = lines.joinToString(",", "[", "]") { l ->
        "{\"text\":${quote(l.text)},\"conf\":${l.conf},\"cx\":${l.cx},\"cy\":${l.cy},\"pass\":\"${l.pass}\"}"
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

    private fun recognizeRegion(
        page: Bitmap, x0: Int, y0: Int, rw: Int, rh: Int, up: Float, pass: String, out: MutableList<PageNumbers.Line>,
    ) {
        val w = page.width
        val h = page.height
        val strip = Bitmap.createBitmap(page, x0, y0, rw, rh)
        val input = if (up > 1f) {
            Bitmap.createScaledBitmap(strip, (rw * up).toInt(), (rh * up).toInt(), true)
                .also { if (it !== strip) strip.recycle() }
        } else {
            strip
        }
        try {
            // Bounded: a recognition that never returns must not hold the
            // capture screen on "撮影中…" (run 19).
            val text = try {
                Tasks.await(recognizer.process(InputImage.fromBitmap(input, 0)), RECOGNIZE_TIMEOUT_S, TimeUnit.SECONDS)
            } catch (e: TimeoutException) {
                Log.w("AstarScanMlkit", "text recognition timed out ($pass ${input.width}x${input.height})")
                return
            }
            for (block in text.textBlocks) {
                for (line in block.lines) {
                    val box = line.boundingBox ?: continue
                    out.add(
                        PageNumbers.Line(
                            text = line.text,
                            cx = ((x0 + box.exactCenterX() / up) / w).toDouble(),
                            cy = ((y0 + box.exactCenterY() / up) / h).toDouble(),
                            pass = pass,
                            conf = line.confidence.toDouble(),
                        ),
                    )
                }
            }
        } finally {
            if (input !== page) input.recycle()
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
