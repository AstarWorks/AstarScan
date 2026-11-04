package com.astarworks.mlkitscanner

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.Log
import java.io.File

/**
 * Emulator check only: the page number read on phone-resolution stills.
 *
 * The CI emulator's camera hands the app 960x1280, where a spread's page
 * is ~360 px wide and its printed number ~6 px tall — nothing reads that.
 * A phone's still is ~12 MP. scripts/eval/book-clips/stills.py renders
 * the middle frame of every hold of the book clips at 3000x4000 (one page)
 * or 4000x3000 (a spread); emulator-check.sh pushes them into the app's
 * external files dir `stills/` (with `<name>.quad`, the page's true
 * corners) and restarts the app. Each still then goes through the capture
 * screen's own steps: DocAligner frame (CaptureDetector; the true corners
 * only when the model gives no plausible frame, logged as source=truth),
 * PageRead.cut (gutter cut / edge fit, page warp) and PageRead.read (bands
 * + folio pieces in one ML Kit call, PageNumbers.pickNative). One "still"
 * log line per image; the image is deleted after it. Nothing happens
 * without that folder.
 */
object StillsCheck {
    private const val TAG = "AstarScanMlkit"

    fun run(context: Context) {
        val dir = context.getExternalFilesDir("stills") ?: return
        val files = dir.listFiles { f -> f.name.endsWith(".jpg") }?.sortedBy { it.name } ?: return
        if (files.isEmpty()) return
        Log.i(TAG, "stills start ${files.size}")
        val det = try {
            CaptureDetector(context)
        } catch (e: Exception) {
            Log.e(TAG, "stills: detector failed", e)
            null
        }
        try {
            for (f in files) one(f, dir, det)
        } finally {
            det?.close()
        }
        Log.i(TAG, "stills done ${files.size}")
    }

    private fun one(f: File, dir: File, det: CaptureDetector?) {
        var photo: Bitmap? = null
        val quadFile = File(dir, f.name.removeSuffix(".jpg") + ".quad")
        try {
            val t0 = SystemClock.elapsedRealtime()
            val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
            val img = BitmapFactory.decodeFile(f.path, opts) ?: throw IllegalStateException("decode failed")
            photo = img
            val w = img.width
            val h = img.height
            val r = det?.detect(img)
            var source = "detector"
            var q = r?.quad?.takeIf { r.minPeak >= CaptureDetector.MIN_PEAK && PageFrame.plausible(it, w, h) && !PageFrame.outside(it, w, h) }
            if (q == null) {
                q = truthQuad(quadFile)
                source = "truth"
            }
            if (q == null) {
                Log.w(TAG, "still ${f.name} ${w}x$h: no frame (model peaks ${r?.peaks?.joinToString(",") { "%.2f".format(it) } ?: "-"})")
                return
            }
            val pc = PageRead.cut(img, q)
            img.recycle()
            photo = null
            val page = pc.page
            val pw = page.width
            val ph = page.height
            val spread = pc.kept.isSpread
            val t1 = SystemClock.elapsedRealtime()
            val pick = try {
                PageRead.read(page, "still:${f.name}", spread)
            } finally {
                page.recycle()
            }
            val t2 = SystemClock.elapsedRealtime()
            Log.i(
                TAG,
                "still ${f.name} ${w}x$h source=$source spread=$spread page=${pw}x$ph nums=${pick.nums} strong=${pick.strong} " +
                    "framed=${pick.framed} cut=${t1 - t0}ms read=${t2 - t1}ms",
            )
        } catch (e: Throwable) {
            Log.e(TAG, "still ${f.name} failed", e)
        } finally {
            photo?.recycle()
            f.delete()
            quadFile.delete()
        }
    }

    /** "x y x y x y x y" (tl tr br bl, still px) from `<name>.quad`. */
    private fun truthQuad(f: File): Quad? {
        val v = try {
            f.readText().trim().split(Regex("\\s+")).map { it.toFloat() }
        } catch (e: Exception) {
            return null
        }
        if (v.size != 8) return null
        return Quad(floatArrayOf(v[0], v[2], v[4], v[6]), floatArrayOf(v[1], v[3], v[5], v[7]))
    }
}
