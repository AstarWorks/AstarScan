package com.astarworks.mlkitscanner

import android.graphics.Bitmap
import java.util.Random
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * "Is this still the page that was just taken?" — the capture screen's
 * turn check (CaptureActivity: no page is taken again until the camera
 * shows another page).
 *
 * Run 21 judged it on the page warped from the frame found, at 32×32: the
 * frame found on one page jumps between two shapes (with and without a
 * strip of the facing page), so the same page differed by 0.73–0.94 and was
 * taken 7× per hold (292 pages for 41 holds). Whole-picture differences do
 * not work either: on the book clips the moving glare and the thumb change
 * a held page as much as a page turn does.
 *
 * What does work is matching the print itself: corner points (FAST-9) with
 * a 256-bit binary descriptor each (BRIEF on a 5×5 box-smoothed picture),
 * cross-checked nearest matches, and the largest set of matches one affine
 * map explains (RANSAC). The same page under hand shake keeps ≥ 100 such
 * matches, the next page ≤ 24 (all five book clips, every pair of frames;
 * measured with this exact algorithm in numpy, see the PR). Pure logic on
 * a luminance array, plus one helper that makes that array from a Bitmap.
 */
object PageMatch {
    /** The picture is matched at this width (the camera's 960 px → 360). */
    const val WIDTH = 360
    const val MAX_FEATURES = 300
    /** Fewer matches than this: another page (same page ≥ 100, next page ≤ 24 on the clips). */
    const val OTHER_PAGE = 40
    /** A reference with fewer corner points than this (a blank page) cannot be matched. */
    const val MIN_FEATURES = 80
    private const val FAST_T = 15
    /** Descriptor tests reach 12 px, their 5×5 boxes 2 px more (+1 for the integral picture). */
    private const val MARGIN = 15
    private const val MAX_HAMMING = 64
    private const val RANSAC_ITERS = 200
    private const val RANSAC_TOL = 3.0

    /** Circle of radius 3 (FAST), clockwise from the top. */
    private val CX = intArrayOf(0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3, -3, -3, -2, -1)
    private val CY = intArrayOf(-3, -3, -2, -1, 0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3)

    /** 256 point pairs in [-12, 12]² (x1, y1, x2, y2), from a fixed LCG. */
    private val PAIRS: IntArray = run {
        var s = 12345L
        IntArray(256 * 4) {
            s = (s * 1103515245L + 12345L) and 0x7fffffffL
            (s % 25).toInt() - 12
        }
    }

    class Gray(val lum: IntArray, val w: Int, val h: Int, /** picture px per Gray px */ val scale: Float)

    class Features(val xs: IntArray, val ys: IntArray, val desc: LongArray) {
        val size: Int get() = xs.size
    }

    /** `frame` at WIDTH px wide, as luminance. */
    fun gray(frame: Bitmap): Gray {
        val k = WIDTH.toFloat() / frame.width
        val w = WIDTH
        val h = max(1, (frame.height * k).roundToInt())
        val small = Bitmap.createScaledBitmap(frame, w, h, true)
        val px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        if (small !== frame) small.recycle()
        return Gray(PageFrame.luminance(px), w, h, 1 / k)
    }

    /**
     * Corner points and their descriptors, the MAX_FEATURES strongest whose
     * position (Gray px) falls in `region` (x0, y0, x1, y1; null: anywhere).
     */
    fun features(g: Gray, region: FloatArray? = null): Features {
        val w = g.w
        val h = g.h
        val lum = g.lum
        val off = IntArray(16) { CY[it] * w + CX[it] }
        val score = IntArray(w * h)
        for (y in 3 until h - 3) {
            val row = y * w
            for (x in 3 until w - 3) {
                val i = row + x
                val c = lum[i]
                val hi = c + FAST_T
                val lo = c - FAST_T
                // Any 9 in a row on the circle cover ≥ 2 of the 4 compass points.
                var nb = 0
                var nd = 0
                for (k in 0 until 16 step 4) {
                    val v = lum[i + off[k]]
                    if (v > hi) nb++ else if (v < lo) nd++
                }
                if (nb < 2 && nd < 2) continue
                var bright = 0
                var dark = 0
                var s = 0
                for (k in 0 until 16) {
                    val v = lum[i + off[k]]
                    if (v > hi) bright = bright or (1 shl k) else if (v < lo) dark = dark or (1 shl k)
                    val d = abs(v - c) - FAST_T
                    if (d > 0) s += d
                }
                if (run9(bright) || run9(dark)) score[i] = s
            }
        }
        val cand = ArrayList<Int>()
        val x0 = max(MARGIN, region?.let { it[0].toInt() } ?: 0)
        val y0 = max(MARGIN, region?.let { it[1].toInt() } ?: 0)
        val x1 = min(w - MARGIN, region?.let { it[2].toInt() + 1 } ?: w)
        val y1 = min(h - MARGIN, region?.let { it[3].toInt() + 1 } ?: h)
        for (y in y0 until y1) {
            for (x in x0 until x1) {
                val i = y * w + x
                val s = score[i]
                if (s <= 0) continue
                var top = true
                loop@ for (dy in -1..1) for (dx in -1..1) {
                    if (score[i + dy * w + dx] > s) { top = false; break@loop }
                }
                if (top) cand.add(i)
            }
        }
        val pick = cand.sortedByDescending { score[it] }.take(MAX_FEATURES)
        // Box sums (5×5) from an integral picture, for the descriptor tests.
        val iw = w + 1
        val integ = IntArray(iw * (h + 1))
        for (y in 0 until h) {
            var rs = 0
            for (x in 0 until w) {
                rs += lum[y * w + x]
                integ[(y + 1) * iw + x + 1] = integ[y * iw + x + 1] + rs
            }
        }
        fun box(x: Int, y: Int): Int =
            integ[(y + 3) * iw + x + 3] - integ[(y - 2) * iw + x + 3] - integ[(y + 3) * iw + x - 2] + integ[(y - 2) * iw + x - 2]
        val n = pick.size
        val xs = IntArray(n)
        val ys = IntArray(n)
        val desc = LongArray(n * 4)
        for ((f, i) in pick.withIndex()) {
            val x = i % w
            val y = i / w
            xs[f] = x
            ys[f] = y
            for (b in 0 until 256) {
                val p = b * 4
                if (box(x + PAIRS[p], y + PAIRS[p + 1]) < box(x + PAIRS[p + 2], y + PAIRS[p + 3])) {
                    desc[f * 4 + b / 64] = desc[f * 4 + b / 64] or (1L shl (b % 64))
                }
            }
        }
        return Features(xs, ys, desc)
    }

    private fun run9(mask: Int): Boolean {
        if (mask == 0) return false
        val m = mask or (mask shl 16)
        var run = 0
        for (k in 0 until 32) {
            if (m and (1 shl k) != 0) {
                run++
                if (run >= 9) return true
            } else {
                run = 0
            }
        }
        return false
    }

    private fun hamming(a: LongArray, i: Int, b: LongArray, j: Int): Int =
        java.lang.Long.bitCount(a[i * 4] xor b[j * 4]) + java.lang.Long.bitCount(a[i * 4 + 1] xor b[j * 4 + 1]) +
            java.lang.Long.bitCount(a[i * 4 + 2] xor b[j * 4 + 2]) + java.lang.Long.bitCount(a[i * 4 + 3] xor b[j * 4 + 3])

    /** How many cross-checked matches between `a` and `b` one affine map explains (within RANSAC_TOL px). */
    fun inliers(a: Features, b: Features, seed: Long = 1L): Int {
        val na = a.size
        val nb = b.size
        if (na < 3 || nb < 3) return 0
        val bestA = IntArray(na)
        val distA = IntArray(na)
        val bestB = IntArray(nb) { -1 }
        val distB = IntArray(nb) { Int.MAX_VALUE }
        for (i in 0 until na) {
            var bj = 0
            var bd = Int.MAX_VALUE
            for (j in 0 until nb) {
                val d = hamming(a.desc, i, b.desc, j)
                if (d < bd) { bd = d; bj = j }
                if (d < distB[j]) { distB[j] = d; bestB[j] = i }
            }
            bestA[i] = bj
            distA[i] = bd
        }
        val px = ArrayList<Int>()
        val qx = ArrayList<Int>()
        for (i in 0 until na) {
            val j = bestA[i]
            if (bestB[j] == i && distA[i] <= MAX_HAMMING) {
                px.add(i)
                qx.add(j)
            }
        }
        val m = px.size
        if (m < 3) return m
        val ax = DoubleArray(m) { a.xs[px[it]].toDouble() }
        val ay = DoubleArray(m) { a.ys[px[it]].toDouble() }
        val bx = DoubleArray(m) { b.xs[qx[it]].toDouble() }
        val by = DoubleArray(m) { b.ys[qx[it]].toDouble() }
        val rnd = Random(seed)
        var best = 0
        val t = DoubleArray(6)
        repeat(RANSAC_ITERS) {
            val i = rnd.nextInt(m)
            var j = rnd.nextInt(m - 1)
            if (j >= i) j++
            var k = rnd.nextInt(m - 2)
            if (k >= min(i, j)) k++
            if (k >= max(i, j)) k++
            if (!affine(ax, ay, bx, by, i, j, k, t)) return@repeat
            var n = 0
            for (p in 0 until m) {
                val ex = t[0] * ax[p] + t[1] * ay[p] + t[2] - bx[p]
                val ey = t[3] * ax[p] + t[4] * ay[p] + t[5] - by[p]
                if (hypot(ex, ey) <= RANSAC_TOL) n++
            }
            if (n > best) best = n
        }
        return best
    }

    /** The affine map taking points i, j, k of (ax, ay) to (bx, by), into t (a b c / d e f). */
    private fun affine(ax: DoubleArray, ay: DoubleArray, bx: DoubleArray, by: DoubleArray, i: Int, j: Int, k: Int, t: DoubleArray): Boolean {
        val det = ax[i] * (ay[j] - ay[k]) - ay[i] * (ax[j] - ax[k]) + (ax[j] * ay[k] - ax[k] * ay[j])
        if (abs(det) < 1e-6) return false
        fun solve(v0: Double, v1: Double, v2: Double, o: Int) {
            t[o] = (v0 * (ay[j] - ay[k]) - ay[i] * (v1 - v2) + (v1 * ay[k] - v2 * ay[j])) / det
            t[o + 1] = (ax[i] * (v1 - v2) - v0 * (ax[j] - ax[k]) + (ax[j] * v2 - ax[k] * v1)) / det
            t[o + 2] = (ax[i] * (ay[j] * v2 - ay[k] * v1) - ay[i] * (ax[j] * v2 - ax[k] * v1) + v0 * (ax[j] * ay[k] - ax[k] * ay[j])) / det
        }
        solve(bx[i], bx[j], bx[k], 0)
        solve(by[i], by[j], by[k], 3)
        return true
    }

    /** The frame's bounding box grown by `grow` of its size on every side, in Gray px. */
    fun region(q: Quad, g: Gray, grow: Float = 0.10f): FloatArray {
        val x0 = q.x.minOrNull()!! / g.scale
        val x1 = q.x.maxOrNull()!! / g.scale
        val y0 = q.y.minOrNull()!! / g.scale
        val y1 = q.y.maxOrNull()!! / g.scale
        val gx = (x1 - x0) * grow
        val gy = (y1 - y0) * grow
        return floatArrayOf(max(0f, x0 - gx), max(0f, y0 - gy), min(g.w.toFloat(), x1 + gx), min(g.h.toFloat(), y1 + gy))
    }
}
