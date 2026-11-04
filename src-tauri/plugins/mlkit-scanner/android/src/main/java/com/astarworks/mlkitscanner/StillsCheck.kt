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
 * screen's own steps: DocAligner frame (CaptureDetector, again on the
 * picture with its edges repeated outward when the first try gives no
 * plausible frame, source=detector-padded; the true corners only when
 * neither does, logged as source=truth),
 * PageRead.cut (gutter cut / edge fit, page warp) and PageRead.read (bands
 * + folio pieces in one ML Kit call, PageNumbers.pickNative). One "still"
 * log line per image; the image is deleted after it. Nothing happens
 * without that folder.
 *
 * Then, per clip, the session the capture screen would have built from
 * those reads: the stills in hold order (`sequence.txt`, one line
 * "<clip> <hold> <hold> …", e.g. single-land-white without hold 3 = p37,
 * skipped on purpose; a clip not listed: every hold in order), each read
 * kept or not by NumberRule (the screen's rule; no second camera picture,
 * as on the emulator) and placed by CaptureSession — the code that decides
 * ✓ / red / grey on the capture screen and in the list. One "stillseq"
 * line per page (what the banner would say) and one per clip (the list:
 * rows, red = the session's missing pages).
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
        val reads = HashMap<String, Read>()
        val order = sequence(File(dir, "sequence.txt"))
        try {
            for (f in files) one(f, dir, det)?.let { reads[f.name] = it }
        } finally {
            det?.close()
        }
        try {
            replay(files.map { it.name }, reads, order)
        } catch (e: Throwable) {
            Log.e(TAG, "stillseq failed", e)
        }
        Log.i(TAG, "stills done ${files.size}")
    }

    /** One still's read, for the replay. */
    private class Read(val pick: PageNumbers.Pick, val spread: Boolean, val width: Int, val height: Int)

    /** `<clip>__hNN.jpg` → (clip, NN). */
    private fun clipHold(name: String): Pair<String, Int>? {
        val m = Regex("^(.+)__h(\\d+)\\.jpg$").find(name) ?: return null
        return Pair(m.groupValues[1], m.groupValues[2].toInt())
    }

    /** `sequence.txt`: clip → holds in the order they are taken. */
    private fun sequence(f: File): Map<String, List<Int>> {
        val out = HashMap<String, List<Int>>()
        val text = try {
            if (f.exists()) f.readText() else ""
        } catch (e: Exception) {
            ""
        }
        for (line in text.lines()) {
            val parts = line.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            if (parts.size < 2) continue
            out[parts[0]] = parts.drop(1).mapNotNull { it.toIntOrNull() }
        }
        f.delete()
        return out
    }

    /**
     * Each clip's stills in hold order through NumberRule and CaptureSession,
     * as the capture screen takes them (addPending, then resolve).
     */
    private fun replay(names: List<String>, reads: Map<String, Read>, order: Map<String, List<Int>>) {
        val byClip = LinkedHashMap<String, MutableMap<Int, String>>()
        for (n in names) {
            val (clip, hold) = clipHold(n) ?: continue
            byClip.getOrPut(clip) { HashMap() }[hold] = n
        }
        for ((clip, holds) in byClip) {
            val seq = order[clip] ?: holds.keys.sorted()
            val skipped = holds.keys.sorted().filter { it !in seq }
            val session = CaptureSession()
            for ((step, hold) in seq.withIndex()) {
                val n = holds[hold] ?: continue
                val r = reads[n]
                if (r == null) {
                    Log.i(TAG, "stillseq $clip step=$step hold=$hold file=$n not read")
                    continue
                }
                session.addPending(n, r.width, r.height, r.spread)
                val (nums, guess) = NumberRule.decide(session, r.pick, r.spread, n, null) { Log.i(TAG, "stillseq $clip $it") }
                val o = session.resolve(n, nums, guess)
                Log.i(
                    TAG,
                    "stillseq $clip step=$step hold=$hold file=$n read=${r.pick.nums} strong=${r.pick.strong} framed=${r.pick.framed} " +
                        "kept=$nums guess=$guess banner=${o?.let { NumberRule.bannerMark(it) } ?: "-"} missing=${session.missing.toList()}",
                )
            }
            val rows = session.pages.joinToString(",") { p ->
                val h = clipHold(p.name)?.second
                "h$h:${NumberRule.listMark(p)}"
            }
            Log.i(
                TAG,
                "stillseq $clip list rows=${session.pages.size} [$rows] red=${session.missing.toList()} step=${session.step} " +
                    "skipped=$skipped",
            )
        }
    }

    private fun one(f: File, dir: File, det: CaptureDetector?): Read? {
        var photo: Bitmap? = null
        val quadFile = File(dir, f.name.removeSuffix(".jpg") + ".quad")
        try {
            val t0 = SystemClock.elapsedRealtime()
            val opts = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
            val img = BitmapFactory.decodeFile(f.path, opts) ?: throw IllegalStateException("decode failed")
            photo = img
            val w = img.width
            val h = img.height
            fun ok(r: CaptureDetector.Result?) =
                r?.quad?.takeIf { r.minPeak >= CaptureDetector.MIN_PEAK && PageFrame.plausible(it, w, h) && !PageFrame.outside(it, w, h) }
            var r = det?.detect(img)
            var source = "detector"
            var q = ok(r)
            if (q == null && det != null) {
                // As the capture screen does on its still: the picture's
                // edges repeated outward, so the paper has desk around it
                // (run 25: the thick spread at 4000x3000, 3 of 6 not framed).
                r = det.detect(img, CaptureDetector.CONTEXT_PAD)
                q = ok(r)
                source = "detector-padded"
            }
            if (q == null) {
                q = truthQuad(quadFile)
                source = "truth"
            }
            if (q == null) {
                Log.w(TAG, "still ${f.name} ${w}x$h: no frame (model peaks ${r?.peaks?.joinToString(",") { "%.2f".format(it) } ?: "-"})")
                return null
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
                PageRead.read(page, "still:${f.name}", spread, what = "still")
            } finally {
                page.recycle()
            }
            val t2 = SystemClock.elapsedRealtime()
            Log.i(
                TAG,
                "still ${f.name} ${w}x$h source=$source spread=$spread page=${pw}x$ph nums=${pick.nums} strong=${pick.strong} " +
                    "framed=${pick.framed} cut=${t1 - t0}ms read=${t2 - t1}ms",
            )
            return Read(pick, spread, pw, ph)
        } catch (e: Throwable) {
            Log.e(TAG, "still ${f.name} failed", e)
            return null
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
