package com.astarworks.mlkitscanner

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.util.Log
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A page frame (four corners, tl tr br bl, image px) and what the capture
 * screen does with it: checks (convex, big enough), the gutter cut of one
 * page, the edge fit of a spread, and the warp to an upright page image.
 * Mirrors app_frame() of scripts/eval/book-clips/corner-compare.py, where the
 * choice was measured on the book clips.
 */
class Quad(val x: FloatArray, val y: FloatArray) {
    init {
        require(x.size == 4 && y.size == 4)
    }

    val width: Double get() = (hypot((x[1] - x[0]).toDouble(), (y[1] - y[0]).toDouble()) + hypot((x[2] - x[3]).toDouble(), (y[2] - y[3]).toDouble())) / 2
    val height: Double get() = (hypot((x[3] - x[0]).toDouble(), (y[3] - y[0]).toDouble()) + hypot((x[2] - x[1]).toDouble(), (y[2] - y[1]).toDouble())) / 2
    val diagonal: Double get() = hypot((x[2] - x[0]).toDouble(), (y[2] - y[0]).toDouble())

    /** A spread: wider than tall (one page is ~0.7 × its height). */
    val isSpread: Boolean get() = height < width * PageFrame.PORTRAIT_MIN

    fun area(): Double {
        var s = 0.0
        for (i in 0 until 4) {
            val j = (i + 1) % 4
            s += x[i].toDouble() * y[j] - x[j].toDouble() * y[i]
        }
        return abs(s) / 2
    }

    fun convex(): Boolean {
        var sign = 0
        for (i in 0 until 4) {
            val ax = x[(i + 1) % 4] - x[i]
            val ay = y[(i + 1) % 4] - y[i]
            val bx = x[(i + 2) % 4] - x[(i + 1) % 4]
            val by = y[(i + 2) % 4] - y[(i + 1) % 4]
            val c = ax * by - ay * bx
            val s = if (c > 0) 1 else if (c < 0) -1 else 0
            if (s == 0) return false
            if (sign == 0) sign = s else if (s != sign) return false
        }
        return true
    }

    /** Largest corner distance to `o`. */
    fun maxMove(o: Quad): Double = (0 until 4).maxOf { hypot((x[it] - o.x[it]).toDouble(), (y[it] - o.y[it]).toDouble()) }

    fun scaled(sx: Float, sy: Float) = Quad(FloatArray(4) { x[it] * sx }, FloatArray(4) { y[it] * sy })

    fun points(): FloatArray = floatArrayOf(x[0], y[0], x[1], y[1], x[2], y[2], x[3], y[3])

    override fun toString(): String = (0 until 4).joinToString(";") { "%.1f,%.1f".format(x[it], y[it]) }

    companion object {
        /** Four points in any order → tl, tr, br, bl (angle around the centre, tl = smallest x + y first). */
        fun ordered(px: FloatArray, py: FloatArray): Quad {
            val cx = px.average().toFloat()
            val cy = py.average().toFloat()
            val idx = (0 until 4).sortedBy { atan2((py[it] - cy).toDouble(), (px[it] - cx).toDouble()) }
            val k = idx.indices.minByOrNull { px[idx[it]] + py[idx[it]] } ?: 0
            val o = (0 until 4).map { idx[(it + k) % 4] }
            return Quad(FloatArray(4) { px[o[it]] }, FloatArray(4) { py[o[it]] })
        }
    }
}

object PageFrame {
    const val PORTRAIT_MIN = 1.05
    /** Frames smaller than this share of the image are not a page (CLAUDE.md: area < 10 %). */
    const val MIN_AREA = 0.10

    fun plausible(q: Quad, w: Int, h: Int): Boolean = q.convex() && q.area() >= MIN_AREA * w * h

    /** A corner further than OUT_TOL of the picture outside it (DocAligner pads to a square, so corners can land off the picture). */
    const val OUT_TOL = 0.03

    /** The paper runs off the w×h camera picture (a corner clearly outside it). */
    fun outside(q: Quad, w: Int, h: Int): Boolean {
        val mx = w * OUT_TOL
        val my = h * OUT_TOL
        return (0 until 4).any { q.x[it] < -mx || q.x[it] > w + mx || q.y[it] < -my || q.y[it] > h + my }
    }

    /** Matrix taking the unit square (0,0)(1,0)(1,1)(0,1) to `q`. */
    private fun unitTo(q: Quad): Matrix = Matrix().apply {
        setPolyToPoly(floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 1f), 0, q.points(), 0, 4)
    }

    /**
     * The frame the screen keeps (corner-compare.py app_frame): a portrait
     * frame is one page — cut back to the book's gutter when it ran past it
     * (GutterTrim.find on the page warped to ≤ 800 px); a wide frame is a
     * spread — each side moved onto the strongest paper edge within a few
     * px (DocAligner's corners sit on a 128-cell grid).
     */
    fun keep(img: Bitmap, q: Quad): Pair<Quad, GutterTrim.Cut?> {
        if (!q.isSpread) {
            val probe = warp(img, q, 800)
            val cut = try {
                val w = probe.width
                val h = probe.height
                val px = IntArray(w * h)
                probe.getPixels(px, 0, w, 0, 0, w, h)
                GutterTrim.find(luminance(px), w, h)
            } finally {
                probe.recycle()
            }
            // Corners in the frame's unit square: tl, tr, br, bl.
            val pts = floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 1f)
            val cutLeft = cut.leftTop > 0 || cut.leftBottom > 0
            val cutRight = cut.rightTop > 0 || cut.rightBottom > 0
            if (cutLeft) {
                pts[0] = cut.leftTop.toFloat()
                pts[6] = cut.leftBottom.toFloat()
            }
            if (cutRight) {
                pts[2] = (1 - cut.rightTop).toFloat()
                pts[4] = (1 - cut.rightBottom).toFloat()
            }
            // A side not cut back may stop short of the gutter: out to the fold.
            val reach: Array<GutterTrim.Side?> = if (cutLeft && cutRight) arrayOfNulls(2) else try {
                reachOut(img, q)
            } catch (e: Exception) {
                arrayOfNulls<GutterTrim.Side>(2)
            }
            val l = reach[0]
            if (!cutLeft && l != null) {
                pts[0] = l.uTop.toFloat(); pts[1] = l.vTop.toFloat()
                pts[6] = l.uBottom.toFloat(); pts[7] = l.vBottom.toFloat()
            }
            val r = reach[1]
            if (!cutRight && r != null) {
                pts[2] = r.uTop.toFloat(); pts[3] = r.vTop.toFloat()
                pts[4] = r.uBottom.toFloat(); pts[5] = r.vBottom.toFloat()
            }
            if (!cut.any && reach.all { it == null }) return Pair(q, cut)
            unitTo(q).mapPoints(pts)
            val out = Quad(floatArrayOf(pts[0], pts[2], pts[4], pts[6]), floatArrayOf(pts[1], pts[3], pts[5], pts[7]))
            Log.i("AstarScanCapture", "page frame reach left=${l ?: "-"} right=${r ?: "-"}")
            return Pair(if (out.convex()) out else q, cut)
        }
        return Pair(refineEdges(img, q), null)
    }

    /**
     * GutterTrim.reach on the frame widened by REACH_OUT / REACH_V; a side
     * whose widened edge leaves the picture is not looked at (null).
     */
    private fun reachOut(img: Bitmap, q: Quad): Array<GutterTrim.Side?> {
        val e = GutterTrim.REACH_OUT.toFloat()
        val v = GutterTrim.REACH_V.toFloat()
        val wide = floatArrayOf(-e, -v, 1 + e, -v, 1 + e, 1 + v, -e, 1 + v)
        unitTo(q).mapPoints(wide)
        val inside = BooleanArray(4) { i -> wide[2 * i] >= 0 && wide[2 * i] < img.width && wide[2 * i + 1] >= 0 && wide[2 * i + 1] < img.height }
        val pw = REACH_PROBE_W
        val ph = max(8, (pw * q.height * (1 + 2 * v) / (q.width * (1 + 2 * e))).roundToInt())
        val m = Matrix()
        m.setPolyToPoly(wide, 0, floatArrayOf(0f, 0f, pw.toFloat(), 0f, pw.toFloat(), ph.toFloat(), 0f, ph.toFloat()), 0, 4)
        val probe = Bitmap.createBitmap(pw, ph, Bitmap.Config.ARGB_8888)
        val px = IntArray(pw * ph)
        try {
            Canvas(probe).drawBitmap(img, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
            probe.getPixels(px, 0, pw, 0, 0, pw, ph)
        } finally {
            probe.recycle()
        }
        val found = GutterTrim.reach(luminance(px), pw, ph)
        if (!(inside[0] && inside[3])) found[0] = null
        if (!(inside[1] && inside[2])) found[1] = null
        return found
    }

    /** Width of the picture GutterTrim.reach looks at. */
    private const val REACH_PROBE_W = 600

    fun luminance(px: IntArray): IntArray = IntArray(px.size) { i ->
        val c = px[i]
        ((c shr 16 and 0xff) * 299 + (c shr 8 and 0xff) * 587 + (c and 0xff) * 114) / 1000
    }

    /** The page inside `q`, warped upright, long side at most `maxSide`. */
    fun warp(img: Bitmap, q: Quad, maxSide: Int): Bitmap {
        val s = min(1.0, maxSide / max(q.width, q.height))
        val ow = max(8, (q.width * s).roundToInt())
        val oh = max(8, (q.height * s).roundToInt())
        val m = Matrix()
        m.setPolyToPoly(q.points(), 0, floatArrayOf(0f, 0f, ow.toFloat(), 0f, ow.toFloat(), oh.toFloat(), 0f, oh.toFloat()), 0, 4)
        val out = Bitmap.createBitmap(ow, oh, Bitmap.Config.ARGB_8888)
        Canvas(out).drawBitmap(img, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
        return out
    }

    /**
     * Fit each side of `q` to the strongest brightness edge across it
     * (Sobel along the side's normal, ±6 px per 960 px of image, 25 samples,
     * least-squares line with one outlier pass), then intersect the sides.
     * Returns `q` unchanged when a side has too few edge points or a corner
     * would move more than 12 px per 960 px.
     */
    fun refineEdges(img: Bitmap, q: Quad): Quad {
        val w = img.width
        val h = img.height
        val px = IntArray(w * h)
        img.getPixels(px, 0, w, 0, 0, w, h)
        val g = luminance(px)
        val unit = max(w, h) / 960.0
        val reach = max(3, (6 * unit).roundToInt())
        fun lum(x: Int, y: Int) = g[y * w + x]
        val lines = ArrayList<DoubleArray>() // px, py, dx, dy
        for (i in 0 until 4) {
            val ax = q.x[i].toDouble()
            val ay = q.y[i].toDouble()
            val dx = q.x[(i + 1) % 4] - ax
            val dy = q.y[(i + 1) % 4] - ay
            val len = hypot(dx, dy)
            if (len < 10) return q
            val tx = dx / len
            val ty = dy / len
            val nx = -ty
            val ny = tx
            val ptsX = ArrayList<Double>()
            val ptsY = ArrayList<Double>()
            for (k in 0 until 25) {
                val s = 0.1 + 0.8 * k / 24
                val cx = ax + dx * s
                val cy = ay + dy * s
                var best = -1.0
                var bx = 0.0
                var by = 0.0
                for (o in -reach..reach) {
                    val x = cx + nx * o
                    val y = cy + ny * o
                    val xi = x.roundToInt()
                    val yi = y.roundToInt()
                    if (xi < 1 || yi < 1 || xi >= w - 1 || yi >= h - 1) continue
                    val gx = (lum(xi + 1, yi - 1) + 2 * lum(xi + 1, yi) + lum(xi + 1, yi + 1)) -
                        (lum(xi - 1, yi - 1) + 2 * lum(xi - 1, yi) + lum(xi - 1, yi + 1))
                    val gy = (lum(xi - 1, yi + 1) + 2 * lum(xi, yi + 1) + lum(xi + 1, yi + 1)) -
                        (lum(xi - 1, yi - 1) + 2 * lum(xi, yi - 1) + lum(xi + 1, yi - 1))
                    val v = abs(gx * nx + gy * ny)
                    if (v > best) {
                        best = v
                        bx = x
                        by = y
                    }
                }
                if (best > 20) {
                    ptsX.add(bx)
                    ptsY.add(by)
                }
            }
            if (ptsX.size < 6) {
                lines.add(doubleArrayOf(ax, ay, tx, ty))
                continue
            }
            var fit = fitLine(ptsX, ptsY, null)
            // One outlier pass: drop points more than 2 px (per 960) off the line.
            val keep = ptsX.indices.filter { j -> abs((ptsX[j] - fit[0]) * -fit[3] + (ptsY[j] - fit[1]) * fit[2]) <= 2 * unit }
            if (keep.size >= 6) fit = fitLine(ptsX, ptsY, keep)
            lines.add(fit)
        }
        val ox = FloatArray(4)
        val oy = FloatArray(4)
        for (i in 0 until 4) {
            val a = lines[(i + 3) % 4]
            val b = lines[i]
            val det = a[2] * -b[3] - a[3] * -b[2]
            if (abs(det) < 1e-6) return q
            val rx = b[0] - a[0]
            val ry = b[1] - a[1]
            val s = (rx * -b[3] - ry * -b[2]) / det
            ox[i] = (a[0] + a[2] * s).toFloat()
            oy[i] = (a[1] + a[3] * s).toFloat()
        }
        val out = Quad(ox, oy)
        return if (out.maxMove(q) > 12 * unit || !out.convex()) q else out
    }

    /** Total least squares line through the points: (x0, y0, dx, dy). */
    private fun fitLine(xs: List<Double>, ys: List<Double>, idx: List<Int>?): DoubleArray {
        val ii = idx ?: xs.indices.toList()
        val mx = ii.sumOf { xs[it] } / ii.size
        val my = ii.sumOf { ys[it] } / ii.size
        var sxx = 0.0
        var syy = 0.0
        var sxy = 0.0
        for (i in ii) {
            val a = xs[i] - mx
            val b = ys[i] - my
            sxx += a * a
            syy += b * b
            sxy += a * b
        }
        val theta = 0.5 * atan2(2 * sxy, sxx - syy)
        return doubleArrayOf(mx, my, Math.cos(theta), Math.sin(theta))
    }
}
