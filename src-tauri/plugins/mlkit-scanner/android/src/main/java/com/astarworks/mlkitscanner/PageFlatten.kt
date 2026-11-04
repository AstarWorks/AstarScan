package com.astarworks.mlkitscanner

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Curvature correction ("dewarp") of one page of an open book, on the device.
 *
 * An open book's page is not flat: it arches up from the spine, so seen
 * from above its top and bottom edges bow outward between the corners
 * (book clips: 1–3 % of the page height, the thick book most) and the text
 * lines bow with them. A straight four-corner warp (PageFrame.warp) keeps
 * the corners but cuts the arch off and leaves the lines curved.
 *
 * Here the page is first cut with a margin around its four corners
 * (MARGIN of the page on every side), the top and bottom paper edges are
 * found in that cut as curves, and every column is stretched so that its
 * top edge goes to the first row and its bottom edge to the last one — the
 * page between the two curves becomes the rectangle (a cylinder model:
 * straight along the spine, curved across). Left and right edges stay where
 * the corners put them; the foreshortening near the spine is not undone.
 *
 * Edge finding, per column (COLUMNS across the page): the strongest step
 * up into the bright paper, going inward, within the outer band (MARGIN +
 * SEARCH of the page; the running head sits ~4 % inside), the outermost
 * winning ties. A curve y(u) = c + a·u(1−u) + b·u²(1−u)
 * (u = column across the page) is fitted to those points, outliers dropped
 * once. The page is left as the straight warp (null) when either edge has
 * too few points that agree, or the curve would move the edge more than
 * MAX_BOW of the page height.
 */
object PageFlatten {
    /** Margin cut around the page, share of its width / height. */
    private const val MARGIN = 0.05
    /** How far inside the page an edge is looked for (beyond the margin). */
    private const val SEARCH = 0.03
    /** Largest edge displacement accepted (share of the page height). */
    private const val MAX_BOW = 0.06
    /** Columns sampled across the page. */
    private const val COLUMNS = 60
    /** Share of the columns that must agree with the fitted curve. */
    private const val MIN_INLIERS = 0.45

    class Result(
        val image: Bitmap,
        /** Largest move of the top / bottom edge from straight, share of the page height (+ = outward). */
        val topBow: Double,
        val bottomBow: Double,
        val inliersTop: Int,
        val inliersBottom: Int,
    )

    /**
     * The flattened page (`ow` x `oh`, the size of the straight warp) cut
     * from `img` around `q`, or null when the edges are not found well
     * enough (the caller keeps the straight warp).
     */
    fun flatten(img: Bitmap, q: Quad, ow: Int, oh: Int): Result? = flattenOrWhy(img, q, ow, oh).first

    /**
     * [flatten], and when it gives null why (for the log the emulator check
     * reports): "top|bottom edge: <n>/COLUMNS columns with an edge step"
     * (too few), "… <n> of them on one curve" (they disagree), or "… bows
     * <x> % of the page height" (more than MAX_BOW).
     */
    fun flattenOrWhy(img: Bitmap, q: Quad, ow: Int, oh: Int): Pair<Result?, String> {
        val why = StringBuilder()
        return Pair(flattenInto(img, q, ow, oh, why), why.toString())
    }

    private fun flattenInto(img: Bitmap, q: Quad, ow: Int, oh: Int, why: StringBuilder): Result? {
        // The page with a margin, in page units scaled to ow x oh.
        val mx = (ow * MARGIN).roundToInt()
        val my = (oh * MARGIN).roundToInt()
        val ew = ow + 2 * mx
        val eh = oh + 2 * my
        val m = Matrix()
        m.setPolyToPoly(
            q.points(), 0,
            floatArrayOf(mx.toFloat(), my.toFloat(), (mx + ow).toFloat(), my.toFloat(), (mx + ow).toFloat(), (my + oh).toFloat(), mx.toFloat(), (my + oh).toFloat()),
            0, 4,
        )
        val ext = Bitmap.createBitmap(ew, eh, Bitmap.Config.ARGB_8888)
        Canvas(ext).drawBitmap(img, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
        try {
            val px = IntArray(ew * eh)
            ext.getPixels(px, 0, ew, 0, 0, ew, eh)
            val lum = PageFrame.luminance(px)
            val reach = my + (oh * SEARCH).roundToInt()
            val top = fitEdge(lum, ew, eh, mx, ow, 0, reach, my.toDouble(), oh, "top", why) ?: return null
            val bottom = fitEdge(lum, ew, eh, mx, ow, eh - 1, eh - 1 - reach, (my + oh).toDouble(), oh, "bottom", why) ?: return null
            val out = IntArray(ow * oh)
            for (x in 0 until ow) {
                val u = (x + 0.5) / ow
                val sx = mx + x + 0.5
                val y0 = top.at(u)
                val y1 = bottom.at(u)
                for (y in 0 until oh) {
                    val sy = y0 + (y + 0.5) / oh * (y1 - y0)
                    out[y * ow + x] = sample(px, ew, eh, sx - 0.5, sy - 0.5)
                }
            }
            val flat = Bitmap.createBitmap(out, ow, oh, Bitmap.Config.ARGB_8888)
            return Result(
                flat,
                topBow = (my - top.extreme()) / oh,
                bottomBow = (bottom.extreme(max = true) - (my + oh)) / oh,
                inliersTop = top.inliers,
                inliersBottom = bottom.inliers,
            )
        } finally {
            ext.recycle()
        }
    }

    /** y(u) = c + a·u(1−u) + b·u²(1−u), in rows of the cut with margin. */
    private class Curve(val c: Double, val a: Double, val b: Double, val inliers: Int) {
        fun at(u: Double) = c + a * u * (1 - u) + b * u * u * (1 - u)

        /** Smallest (or largest) y along the page. */
        fun extreme(max: Boolean = false): Double {
            var best = at(0.0)
            for (i in 1..50) {
                val v = at(i / 50.0)
                if (if (max) v > best else v < best) best = v
            }
            return best
        }
    }

    /**
     * The paper edge between rows `from` (outside) and `to` (inside the
     * page) in every sampled column, and the curve through them. `straight`
     * is where the four-corner warp put the edge.
     */
    private fun fitEdge(
        lum: IntArray,
        w: Int,
        h: Int,
        x0: Int,
        pw: Int,
        from: Int,
        to: Int,
        straight: Double,
        ph: Int,
        edge: String,
        why: StringBuilder,
    ): Curve? {
        val dir = if (to > from) 1 else -1
        val us = ArrayList<Double>()
        val ys = ArrayList<Double>()
        for (k in 0 until COLUMNS) {
            val u = 0.04 + 0.92 * k / (COLUMNS - 1)
            val x = (x0 + u * pw).roundToInt().coerceIn(2, w - 3)
            var best = 0.0
            var bestY = -1
            var y = from + dir * 2
            while ((to - y) * dir > 0) {
                // Step into brighter paper going inward, averaged over 5
                // columns (desk → dark cover board is a step the other way).
                var g = 0.0
                for (dx in -2..2) {
                    g += lum[(y + dir) * w + x + dx] - lum[(y - dir) * w + x + dx]
                }
                val v = g / 5
                if (v > best + 1e-6) {
                    best = v
                    bestY = y
                }
                y += dir
            }
            if (bestY >= 0 && best >= 12) {
                us.add(u)
                ys.add(bestY.toDouble())
            }
        }
        if (us.size < COLUMNS * MIN_INLIERS) {
            why.append("$edge edge: ${us.size}/$COLUMNS columns with an edge step")
            return null
        }
        var fit = lsq(us, ys, null) ?: return null.also { why.append("$edge edge: no curve fit") }
        val tol = max(2.0, ph * 0.012)
        val keep = us.indices.filter { abs(ys[it] - fit.at(us[it])) <= tol }
        if (keep.size < COLUMNS * MIN_INLIERS) {
            why.append("$edge edge: ${us.size}/$COLUMNS columns with an edge step, ${keep.size} of them on one curve")
            return null
        }
        fit = lsq(us, ys, keep) ?: return null.also { why.append("$edge edge: no curve fit") }
        // Not more than MAX_BOW away from where the corners put the edge.
        for (i in 0..20) {
            val d = abs(fit.at(i / 20.0) - straight)
            if (d > ph * MAX_BOW) {
                why.append("$edge edge: bows %.1f %% of the page height".format(d / ph * 100))
                return null
            }
        }
        return Curve(fit.c, fit.a, fit.b, keep.size)
    }

    /** Least squares for c, a, b (3x3 normal equations). */
    private fun lsq(us: List<Double>, ys: List<Double>, idx: List<Int>?): Curve? {
        val ix = idx ?: us.indices.toList()
        val n = Array(3) { DoubleArray(3) }
        val r = DoubleArray(3)
        for (i in ix) {
            val u = us[i]
            val f = doubleArrayOf(1.0, u * (1 - u), u * u * (1 - u))
            for (p in 0 until 3) {
                for (q in 0 until 3) n[p][q] += f[p] * f[q]
                r[p] += f[p] * ys[i]
            }
        }
        val s = solve3(n, r) ?: return null
        return Curve(s[0], s[1], s[2], ix.size)
    }

    private fun solve3(a: Array<DoubleArray>, b: DoubleArray): DoubleArray? {
        val m = Array(3) { i -> doubleArrayOf(a[i][0], a[i][1], a[i][2], b[i]) }
        for (c in 0 until 3) {
            var p = c
            for (i in c + 1 until 3) if (abs(m[i][c]) > abs(m[p][c])) p = i
            if (abs(m[p][c]) < 1e-12) return null
            val t = m[c]; m[c] = m[p]; m[p] = t
            for (i in 0 until 3) {
                if (i == c) continue
                val f = m[i][c] / m[c][c]
                for (j in c until 4) m[i][j] -= f * m[c][j]
            }
        }
        return DoubleArray(3) { m[it][3] / m[it][it] }
    }

    /** Bilinear sample of ARGB pixels at (x, y), clamped to the image. */
    private fun sample(px: IntArray, w: Int, h: Int, x: Double, y: Double): Int {
        val xc = min(max(x, 0.0), w - 1.001)
        val yc = min(max(y, 0.0), h - 1.001)
        val x0 = xc.toInt()
        val y0 = yc.toInt()
        val fx = xc - x0
        val fy = yc - y0
        val p00 = px[y0 * w + x0]
        val p10 = px[y0 * w + x0 + 1]
        val p01 = px[(y0 + 1) * w + x0]
        val p11 = px[(y0 + 1) * w + x0 + 1]
        var out = 0xff shl 24
        for (sh in intArrayOf(16, 8, 0)) {
            val v = ((p00 shr sh and 0xff) * (1 - fx) + (p10 shr sh and 0xff) * fx) * (1 - fy) +
                ((p01 shr sh and 0xff) * (1 - fx) + (p11 shr sh and 0xff) * fx) * fy
            out = out or (v.roundToInt().coerceIn(0, 255) shl sh)
        }
        return out
    }
}
