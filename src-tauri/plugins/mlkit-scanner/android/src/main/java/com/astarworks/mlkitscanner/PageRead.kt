package com.astarworks.mlkitscanner

import android.graphics.Bitmap
import android.util.Log
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * How the capture screen cuts a page out of a camera picture and reads its
 * printed number. One place for both callers, so they cannot drift apart:
 * - CaptureActivity, on every page it takes;
 * - StillsCheck (emulator check only), on full-resolution stills of the
 *   book clips (a phone's 12 MP picture instead of the CI emulator's
 *   960x1280 camera).
 */
object PageRead {
    /** Long side of the page image cut from the picture. */
    const val PAGE_MAX_SIDE = 2400
    /** The margin bands go to ML Kit at this width (run 21: 1600 px, 20–180 s a call). */
    const val BAND_WIDTH = 1000
    /**
     * Height of the top / bottom band read whole (share of the page):
     * the numbers of the five book clips sit within 7 % of the edge;
     * a smaller band is less body text for ML Kit to read (run 22: one
     * call ~9 s while pages were taken). Folio pieces are still looked
     * for in PageNumbers.MARGIN_FRAC.
     */
    const val BAND_FRAC = 0.10
    private const val MLKIT_TAG = "AstarScanMlkit"

    class Cut(val kept: Quad, val gutter: GutterTrim.Cut?, val page: Bitmap)

    /**
     * The frame the screen keeps for `q` on `photo` (gutter cut / edge fit,
     * PageFrame.keep, on a copy of at most 1600 px) and the page cut upright
     * from `photo` along it, long side at most PAGE_MAX_SIDE.
     */
    fun cut(photo: Bitmap, q: Quad): Cut {
        val ks = min(1f, 1600f / max(photo.width, photo.height))
        val probe = if (ks < 1f) Bitmap.createScaledBitmap(photo, (photo.width * ks).roundToInt(), (photo.height * ks).roundToInt(), true) else photo
        val (kept0, gutter) = try {
            PageFrame.keep(probe, q.scaled(ks, ks))
        } finally {
            if (probe !== photo) probe.recycle()
        }
        val kept = kept0.scaled(1 / ks, 1 / ks)
        return Cut(kept, gutter, PageFrame.warp(photo, kept, PAGE_MAX_SIDE))
    }

    /**
     * The page's number: the margin bands and the folio pieces in ONE ML Kit
     * call (MarginReader.marginLines), then PageNumbers.pickNative. Only
     * when that gives no number, and `fallback`: one more call on the other
     * renderings of a single page's folio (MarginReader.extraLines; none for
     * a spread). Run 25 put all of them in the first picture (11–15 tiles,
     * ~10.7 s a call next to the camera on the CI emulator, 9 timeouts);
     * on a phone the first call reads the number and stays the only one.
     * Every pass is logged ("margins <name> … pass=band|folio|extra").
     * `what` names the calls in the "ocr …" log lines (the stills check
     * uses its own, so its calls are not counted with the capture screen's).
     */
    fun read(page: Bitmap, name: String, spread: Boolean, fallback: Boolean = true, what: String = "margins"): PageNumbers.Pick {
        val first = lines(page, name, what)
        val pick = PageNumbers.pickNative(first, spread)
        if (!fallback || spread || pick.nums.isNotEmpty()) return pick
        val extra = MarginReader.extraLines(page, if (what == "margins") "extra" else "$what-extra")
        Log.i(MLKIT_TAG, "margins $name ${page.width}x${page.height} pass=extra ${MarginReader.json(extra)}")
        if (extra.isEmpty()) return pick
        return PageNumbers.pickNative(first + extra, spread)
    }

    fun lines(page: Bitmap, name: String, what: String = "margins"): List<PageNumbers.Line> {
        val lines = MarginReader.marginLines(page, BAND_FRAC, PageNumbers.MARGIN_FRAC, BAND_WIDTH, what)
        Log.i(MLKIT_TAG, "margins $name ${page.width}x${page.height} pass=band ${MarginReader.json(lines.filter { it.pass == "band" })}")
        Log.i(MLKIT_TAG, "margins $name ${page.width}x${page.height} pass=folio ${MarginReader.json(lines.filter { it.pass == "folio" })}")
        return lines
    }
}
