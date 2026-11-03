package com.astarworks.mlkitscanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import java.io.File

/**
 * Pull a page frame back to the book's gutter.
 *
 * On a single page of an open book a page frame sometimes runs past the
 * gutter into the facing page (emulator runs 11–16: single-land-white's
 * left edge 70–113 clip px past the spine, single-port-wood's top-left at
 * the spine curl). The page ML Kit returns is then the page plus a strip of
 * the neighbour page, with the gutter — a dark vertical shadow / fold line
 * across the whole height — inside it near that edge.
 *
 * The capture screen runs [find] on every single page it takes, on the
 * page warped from its frame (PageFrame.keep), before the list, the PDF and
 * the upload see it; [trim] does the same on a page file. It looks for that shadow
 * in the outer part of each side, separately in an upper and a lower band
 * (the fold need not be parallel to ML Kit's edge), and when found cuts the
 * page at the fold with a perspective warp: the side's top and bottom
 * corners move to the fold, the other corners stay.
 *
 * Only portrait results are touched: a spread comes back landscape (two
 * pages side by side), its gutter is in the middle and ML Kit's frame is on
 * its outer corners, so spreads are left exactly as ML Kit framed them.
 */
object GutterTrim {
    /** Long side of the copy the shadow is searched in. */
    private const val PROBE_SIDE = 800
    /** Fold searched between these shares of the width, from each side. */
    private const val SEARCH_FROM = 0.03
    private const val SEARCH_TO = 0.30
    /** The fold's paper must be this much darker than the page's paper. */
    private const val SHADOW_MAX = 0.80
    /** ...and the strip beyond it bright again (the facing page), at least this wide. */
    private const val BEYOND_RISE = 0.35
    private const val BEYOND_WIDTH = 0.01
    /** Results not taller than this × their width are spreads: never trimmed. */
    private const val PORTRAIT_MIN = 1.05
    /** Upper and lower bands, as shares of the height. */
    private val BANDS = arrayOf(doubleArrayOf(0.08, 0.40), doubleArrayOf(0.60, 0.92))

    /** Cut, as shares of the width: left side at the top / bottom, right side at the top / bottom. */
    class Cut(val leftTop: Double, val leftBottom: Double, val rightTop: Double, val rightBottom: Double) {
        val any: Boolean get() = leftTop > 0 || leftBottom > 0 || rightTop > 0 || rightBottom > 0
        override fun toString(): String =
            "left=%.4f,%.4f right=%.4f,%.4f".format(leftTop, leftBottom, rightTop, rightBottom)
    }

    /**
     * Find the gutter in `file` and, when found, rewrite the file cut at it.
     * Returns the cut (all zero when nothing was changed).
     */
    fun trim(file: File): Cut {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        val w0 = bounds.outWidth
        val h0 = bounds.outHeight
        val none = Cut(0.0, 0.0, 0.0, 0.0)
        if (w0 <= 0 || h0 < w0 * PORTRAIT_MIN) return none
        var sample = 1
        while (maxOf(w0, h0) / (sample * 2) >= PROBE_SIDE) sample *= 2
        val probe = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: return none
        val cut = try {
            val w = probe.width
            val h = probe.height
            val px = IntArray(w * h)
            probe.getPixels(px, 0, w, 0, 0, w, h)
            val lum = IntArray(px.size) { i ->
                val c = px[i]
                ((c shr 16 and 0xff) * 299 + (c shr 8 and 0xff) * 587 + (c and 0xff) * 114) / 1000
            }
            find(lum, w, h)
        } finally {
            probe.recycle()
        }
        if (!cut.any) return cut
        warp(file, w0, h0, cut)
        return cut
    }

    /** The cut for a luminance image (row-major, w × h). Pure; no Android types. */
    fun find(lum: IntArray, w: Int, h: Int): Cut {
        val per = BANDS.map { b -> bandProfile(lum, w, h, (h * b[0]).toInt(), (h * b[1]).toInt()) }
        val y0 = (BANDS[0][0] + BANDS[0][1]) / 2
        val y1 = (BANDS[1][0] + BANDS[1][1]) / 2
        val left = per.map { fold(it, false) }
        val right = per.map { fold(it, true) }
        val (lt, lb) = corners(left[0], left[1], y0, y1)
        val (rt, rb) = corners(right[0], right[1], y0, y1)
        return Cut(lt, lb, rt, rb)
    }

    /**
     * Fold positions found in the upper (`a`) and lower (`b`) band → the cut
     * at the top and bottom edge. Both found: the line through them,
     * extended to the edges. One found: only that corner moves.
     */
    private fun corners(a: Double?, b: Double?, ya: Double, yb: Double): Pair<Double, Double> {
        if (a == null && b == null) return Pair(0.0, 0.0)
        if (a == null) return Pair(0.0, b!!)
        if (b == null) return Pair(a, 0.0)
        val slope = (b - a) / (yb - ya)
        val top = a - slope * ya
        val bottom = a + slope * (1 - ya)
        return Pair(top.coerceIn(0.0, SEARCH_TO), bottom.coerceIn(0.0, SEARCH_TO))
    }

    /**
     * Paper brightness per column in rows [ya, yb): the 80th percentile, so
     * print (dark, sparse) does not count but a shadow (all rows) does;
     * smoothed over 1 % of the width.
     */
    private fun bandProfile(lum: IntArray, w: Int, h: Int, ya: Int, yb: Int): DoubleArray {
        val rows = (yb - ya).coerceAtLeast(1)
        val raw = DoubleArray(w)
        val hist = IntArray(256)
        for (x in 0 until w) {
            java.util.Arrays.fill(hist, 0)
            for (y in ya until minOf(yb, h)) hist[lum[y * w + x]]++
            var acc = 0
            var v = 255
            for (i in 0..255) {
                acc += hist[i]
                if (acc >= rows * 0.8) { v = i; break }
            }
            raw[x] = v.toDouble()
        }
        val r = (w * 0.005).toInt().coerceAtLeast(1)
        return DoubleArray(w) { x ->
            var s = 0.0
            var n = 0
            for (i in maxOf(0, x - r)..minOf(w - 1, x + r)) { s += raw[i]; n++ }
            s / n
        }
    }

    /**
     * The fold (darkest column) in the outer part of one side, as a share of
     * the width from that side, or null when there is no gutter: the column
     * must be clearly darker than the page's paper, and beyond it (towards
     * the edge) there must be bright paper again — the facing page — not
     * just the page's own edge or the background.
     */
    private fun fold(p: DoubleArray, fromRight: Boolean): Double? {
        val w = p.size
        fun at(d: Int) = p[if (fromRight) w - 1 - d else d]
        val mid = (0 until w).filter { it >= w * 0.35 && it <= w * 0.65 }.map { p[it] }.sorted()
        if (mid.isEmpty()) return null
        val paper = mid[mid.size / 2]
        if (paper < 60) return null
        val a = (w * SEARCH_FROM).toInt()
        val b = (w * SEARCH_TO).toInt()
        var best = a
        for (d in a..b) if (at(d) < at(best)) best = d
        if (at(best) > paper * SHADOW_MAX) return null
        // The facing page next to the fold is in the shadow too (run 16
        // c7: 155 against paper 204), so "bright again" is measured from
        // the fold: back at least BEYOND_RISE of the way up to the paper.
        val floor = at(best) + (paper - at(best)) * BEYOND_RISE
        val wide = (0 until best).count { at(it) >= floor }
        if (wide < w * BEYOND_WIDTH) return null
        return best.toDouble() / w
    }

    /** Rewrite `file` with the quad inside the cut warped to a rectangle (JPEG 92). */
    private fun warp(file: File, w: Int, h: Int, cut: Cut) {
        val src = BitmapFactory.decodeFile(file.path) ?: return
        try {
            val tlx = cut.leftTop * w
            val blx = cut.leftBottom * w
            val trx = w - cut.rightTop * w
            val brx = w - cut.rightBottom * w
            val outW = (((trx - tlx) + (brx - blx)) / 2).toInt().coerceAtLeast(1)
            val m = Matrix()
            m.setPolyToPoly(
                floatArrayOf(tlx.toFloat(), 0f, trx.toFloat(), 0f, brx.toFloat(), h.toFloat(), blx.toFloat(), h.toFloat()),
                0,
                floatArrayOf(0f, 0f, outW.toFloat(), 0f, outW.toFloat(), h.toFloat(), 0f, h.toFloat()),
                0,
                4,
            )
            val out = Bitmap.createBitmap(outW, h, Bitmap.Config.ARGB_8888)
            Canvas(out).drawBitmap(src, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
            val tmp = File(file.path + ".tmp")
            tmp.outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            out.recycle()
            if (!tmp.renameTo(file)) {
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
        } finally {
            src.recycle()
        }
    }
}
