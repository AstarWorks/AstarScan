package com.astarworks.mlkitscanner

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log
import android.util.Size
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The capture screen: the camera with what the app sees drawn over it.
 *
 * 1. A green frame around the paper found (DocAligner, CaptureDetector).
 * 2. When the frame has stood still for STABLE_MS the page is taken by
 *    itself: "✓ 撮れた — めくってください" and a short vibration at once,
 *    the sign to turn the page. Its printed number is read meanwhile
 *    (ML Kit, MarginReader, on its own thread) and, when known, the banner
 *    becomes "✓ 35 ページ 撮れた — めくってください" (if no newer page was
 *    taken since; a missing page found later is always shown in red). The
 *    same page is not taken again until the camera shows another page
 *    (PageMatch: the print no longer matches the page taken).
 * 3. When it cannot: yellow "紙全体を画面に入れてください" when no frame is
 *    found or it keeps moving for YELLOW_MS; red "36 ページが抜けています。
 *    戻って撮ってください" when the number jumps (going back and taking it
 *    fills the gap in place); grey "番号なし" when no number was read.
 *
 * Done (button at the bottom, or Back) hands every page taken to the app
 * (ScannerPlugin.captureResult) as JPEG files in filesDir/scans; Back never
 * throws pages away. The page list is also written to
 * filesDir/scans/capture-<stamp>.json after every page, so the pages taken
 * survive the process (ScannerPlugin.takePending picks them up).
 *
 * Every banner and every page is logged (tag AstarScanCapture) for the
 * emulator check (scripts/android/emulator-check.sh, book-measure.py);
 * with the external files folder `eval/` present the camera picture of
 * every page is kept there too, with the frame found on it.
 */
class CaptureActivity : ComponentActivity() {
    private lateinit var previewView: PreviewView
    private lateinit var overlay: OverlayView
    private lateinit var banner: TextView
    private lateinit var info: TextView
    private lateinit var doneButton: Button

    private val analysisExec = Executors.newSingleThreadExecutor()
    private val work = Executors.newSingleThreadExecutor()
    private val stillExec = Executors.newSingleThreadExecutor()
    /** Page numbers are read here, one page after the other, while the user turns on. */
    private val readExec = Executors.newSingleThreadExecutor()
    private val pendingReads = AtomicInteger(0)
    /** The newest page taken: only its number result replaces the banner. */
    @Volatile private var newestShot: String? = null
    /** Set when the result is written: later reads change nothing. */
    private val closed = AtomicBoolean(false)
    private var detector: CaptureDetector? = null
    private var imageCapture: ImageCapture? = null
    private lateinit var session: CaptureSession
    private var evalDir: File? = null
    private val scansDir by lazy { File(filesDir, "scans").apply { mkdirs() } }
    private val stamp = System.currentTimeMillis()
    private var seq = 0

    // Analysis-thread state.
    private var lastAnalyzed = 0L
    private var anchor: Quad? = null
    /** The last SMOOTH_N frames found; stillness is judged on their median (corners jitter 20–30 px, run 20). */
    private val recent = ArrayDeque<Quad>()
    private var nullStreak = 0
    private var stableSince = 0L
    private var lastGoodAt = 0L
    private var armed = true
    private var turnSeen = false
    /** The page last taken, as PageMatch sees it (and where in the picture it was). */
    private var refFeatures: PageMatch.Features? = null
    private var refRegion: FloatArray? = null
    /** After re-arming: the picture stillness counts from; the page is taken only while the print still matches it. */
    private var candFeatures: PageMatch.Features? = null
    private var lastMatchAt = 0L
    private var lastCaptureAt = 0L
    private var lastSigLog = 0L
    private var frameInfoLogged = false
    private var lastStatusLog = 0L
    /** Since when the frame found runs off the camera picture (0: it does not). */
    @Volatile private var offSince = 0L
    private val busy = AtomicBoolean(false)
    private val finishing = AtomicBoolean(false)

    /** Camera pictures held while a page's number is read, with that page's seq (grabHeld / readHeld). */
    private val held = ArrayDeque<Pair<Int, Bitmap>>()
    /** The seq of the page last taken (0: none yet). */
    @Volatile private var heldSeq = 0
    private var lastHeldAt = 0L

    /** The newest page's band picture, for the solo ML Kit call on close (eval mode only). */
    private var soloSample: Bitmap? = null
    private var cameraProvider: ProcessCameraProvider? = null

    // Main-thread state.
    private var bannerKind = ""
    private var yellowShown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val known = intent.getIntArrayExtra(EXTRA_KNOWN)?.toList() ?: emptyList()
        // The step (every page / one side only) belongs to the book being
        // taken: with an empty list it is learnt again (run 22: the web app's
        // default 1 made 3, 5, 7 … of a right-pages-only book "jumps", every
        // one red and read twice).
        session = CaptureSession(known, if (known.isEmpty()) 0 else intent.getIntExtra(EXTRA_STEP, 0))
        evalDir = getExternalFilesDir("eval")?.takeIf { File(it, ".on").exists() }
        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = finishWithPages()
        })
        setBanner("idle", "ページ全体を画面に入れて止めてください")
        updateInfo()
        readExec.execute {
            val t0 = SystemClock.elapsedRealtime()
            try {
                MarginReader.warmUp()
                Log.i(TAG, "text recognition ready in ${SystemClock.elapsedRealtime() - t0}ms")
            } catch (e: Exception) {
                Log.w(TAG, "text recognition warm-up failed", e)
            }
        }
        work.execute {
            try {
                detector = CaptureDetector(this)
                Log.i(TAG, "detector ready")
            } catch (e: Exception) {
                Log.e(TAG, "detector failed", e)
                runOnUiThread { finishWithError("DETECTOR_FAILED", e.message ?: "model") }
            }
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
        else finishWithError("CAMERA_DENIED", "camera permission denied")
    }

    override fun onDestroy() {
        super.onDestroy()
        analysisExec.shutdown()
        work.execute { detector?.close() }
        work.shutdown()
        stillExec.shutdown()
        readExec.shutdown()
        synchronized(this) {
            soloSample?.recycle()
            soloSample = null
        }
        synchronized(held) {
            for (e in held) e.second.recycle()
            held.clear()
        }
    }

    // ------------------------------------------------------------------ UI

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).roundToInt()

    private fun buildUi() {
        val root = FrameLayout(this)
        root.setBackgroundColor(Color.BLACK)
        previewView = PreviewView(this).apply {
            // The whole camera picture on the screen (run 19: FILL_CENTER cut the
            // sides of a spread off a tall phone screen, so the user could not
            // see whether all the paper was in).
            scaleType = PreviewView.ScaleType.FIT_CENTER
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        }
        root.addView(previewView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        overlay = OverlayView(this)
        root.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        banner = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            setPadding(dp(16), dp(14), dp(16), dp(14))
            contentDescription = "banner"
        }
        root.addView(banner, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP).apply {
            setMargins(dp(12), dp(28), dp(12), 0)
        })
        // One-handed: everything the user presses is at the bottom.
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(18))
            setBackgroundColor(0xCC000000.toInt())
        }
        info = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 17f
        }
        bar.addView(info, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        doneButton = Button(this).apply {
            text = "完了"
            textSize = 20f
            minHeight = dp(56)
            minWidth = dp(120)
            setOnClickListener { finishWithPages() }
        }
        bar.addView(doneButton)
        root.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        setContentView(root)
    }

    private fun bannerBackground(color: Int) = GradientDrawable().apply {
        cornerRadius = dp(14).toFloat()
        setColor(color)
    }

    /** kind: idle, busy, shot (taken, number still being read), taken, unread, gap, filled, duplicate, yellow. */
    private fun setBanner(kind: String, text: String) {
        val color = when (kind) {
            "taken", "filled", "shot" -> 0xEE1B8E3E.toInt()
            "gap" -> 0xEED32F2F.toInt()
            "yellow" -> 0xEEF9C80E.toInt()
            "unread", "duplicate" -> 0xEE616161.toInt()
            else -> 0x99000000.toInt()
        }
        banner.background = bannerBackground(color)
        banner.setTextColor(if (kind == "yellow") Color.BLACK else Color.WHITE)
        banner.text = text
        if (kind != bannerKind || kind != "idle") Log.i(TAG, "banner $kind $text")
        bannerKind = kind
        yellowShown = kind == "yellow"
    }

    private fun updateInfo() {
        val (n, miss, reading) = synchronized(session) { Triple(session.pages.size, session.missing.toList(), session.reading) }
        val base = if (miss.isEmpty()) "$n 枚" else "$n 枚 · 抜け ${CaptureSession.label(miss)}"
        info.text = if (reading > 0) "$base · 番号読み取り中 $reading" else base
        doneButton.text = if (n > 0) "完了（$n）" else "完了"
    }

    private fun vibrate(ms: Long) {
        val v = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator ?: return
        try {
            if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE))
            else @Suppress("DEPRECATION") v.vibrate(ms)
        } catch (_: Exception) {
        }
    }

    // -------------------------------------------------------------- camera

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = try {
                future.get()
            } catch (e: Exception) {
                Log.e(TAG, "camera provider failed", e)
                finishWithError("CAMERA_FAILED", e.message ?: "camera")
                return@addListener
            }
            val sel = ResolutionSelector.Builder()
                .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                .setResolutionStrategy(ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build()
            val preview = Preview.Builder().setResolutionSelector(sel).build()
            preview.setSurfaceProvider(previewView.surfaceProvider)
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(sel)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .build()
            analysis.setAnalyzer(analysisExec) { analyze(it) }
            val capture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .setResolutionSelector(
                    ResolutionSelector.Builder()
                        .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
                        .build(),
                )
                .build()
            cameraProvider = provider
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis, capture)
                imageCapture = capture
                Log.i(TAG, "camera bound: preview + analysis + still capture")
            } catch (e: Exception) {
                // Some cameras cannot run three streams: pages are then cut
                // from the analysis frames.
                Log.w(TAG, "camera with still capture failed (${e.message}); binding preview + analysis", e)
                try {
                    provider.unbindAll()
                    provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    imageCapture = null
                } catch (e2: Exception) {
                    Log.e(TAG, "camera bind failed", e2)
                    finishWithError("CAMERA_FAILED", e2.message ?: "camera")
                }
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun upright(src: Bitmap, rotation: Int): Bitmap {
        if (rotation % 360 == 0) return src
        val m = Matrix().apply { postRotate(rotation.toFloat()) }
        return Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true).also { if (it !== src) src.recycle() }
    }

    // ------------------------------------------------------------ analysis

    private fun analyze(image: ImageProxy) {
        try {
            val now = SystemClock.elapsedRealtime()
            // While the page just taken is read: keep a few more camera
            // pictures of it (another chance for its folio, see readHeld).
            if (!armed && !busy.get() && !finishing.get() && pendingReads.get() > 0 && now - lastHeldAt >= HELD_EVERY_MS) {
                lastHeldAt = now
                grabHeld(image)
            }
            // No frame finding while a page is being cut, nor (for up to
            // READ_PAUSE_MS) while the number of the page just taken is read
            // ("✓ 撮れた" is up, the user is turning), and less of it while
            // older numbers are read: DocAligner and ML Kit share the CPU,
            // and on a slow phone (the CI emulator, run 21: one ML Kit call
            // ~3–7 s alone, ~20 s next to DocAligner) the frame finder
            // starves it. A phone reads a number in well under a second.
            val reading = !armed && pendingReads.get() > 0 && now - lastCaptureAt < READ_PAUSE_MS
            val every = if (pendingReads.get() > 0) READING_ANALYSIS_MS else ANALYSIS_MS
            if (busy.get() || reading || now - lastAnalyzed < every || finishing.get()) return
            lastAnalyzed = now
            val det = detector ?: return
            val rot = image.imageInfo.rotationDegrees
            val frame = upright(image.toBitmap(), rot)
            if (!frameInfoLogged) {
                frameInfoLogged = true
                Log.i(TAG, "frame ${image.width}x${image.height} rotation=$rot upright=${frame.width}x${frame.height}")
            }
            val t0 = SystemClock.elapsedRealtime()
            val res = try {
                det.detect(frame)
            } catch (e: Exception) {
                Log.w(TAG, "detect failed", e)
                null
            }
            val detectMs = SystemClock.elapsedRealtime() - t0
            val sure = res != null && res.minPeak >= CaptureDetector.MIN_PEAK
            val plausible = res != null && PageFrame.plausible(res.quad, frame.width, frame.height)
            val found = res?.quad?.takeIf { sure && plausible }
            // Paper running off the camera picture: framed, but not taken
            // (the page would be cut) — the yellow notice asks for all of it.
            val off = found != null && PageFrame.outside(found, frame.width, frame.height)
            val q = if (off) null else found
            if (!off) offSince = 0L else if (offSince == 0L) offSince = now
            step(now, q, frame)
            val stable = q != null && anchor != null && now - stableSince >= STABLE_MS
            if (now - lastStatusLog >= STATUS_LOG_MS) {
                lastStatusLog = now
                Log.i(
                    TAG,
                    "status detect=${detectMs}ms peaks=${res?.peaks?.joinToString(",") { "%.2f".format(it) } ?: "-"} " +
                        "plausible=$plausible off=$off frame=${found ?: "-"} stableFor=${if (q != null && anchor != null) now - stableSince else -1} " +
                        "armed=$armed turnSeen=$turnSeen busy=${busy.get()} reading=${pendingReads.get()} banner=$bannerKind cores=${Runtime.getRuntime().availableProcessors()}",
                )
            }
            val fw = frame.width
            val fh = frame.height
            // Not kept past this frame (the capture works on its own copy).
            frame.recycle()
            runOnUiThread { overlay.show(found, fw, fh, stable, off) }
        } catch (e: Exception) {
            Log.w(TAG, "analysis failed", e)
        } finally {
            image.close()
        }
    }

    /**
     * Analysis thread: the camera picture now, kept for the page last taken
     * (`heldSeq`) when its print still matches that page (PageMatch inliers
     * ≥ HELD_MATCH; the same page scores ~190–216 on the CI emulator, the
     * next one ~5), at most HELD_MAX of them.
     */
    private fun grabHeld(image: ImageProxy) {
        val s = heldSeq
        if (s == 0) return
        synchronized(held) { if (held.count { it.first == s } >= HELD_MAX) return }
        val ref = refFeatures ?: return
        if (ref.size < PageMatch.MIN_FEATURES) return
        val f = upright(image.toBitmap(), image.imageInfo.rotationDegrees)
        val n = try {
            PageMatch.inliers(ref, PageMatch.features(PageMatch.gray(f), refRegion))
        } catch (e: Exception) {
            0
        }
        if (n < HELD_MATCH || heldSeq != s) {
            f.recycle()
            return
        }
        synchronized(held) {
            held.addLast(Pair(s, f))
            while (held.size > HELD_MAX) held.removeFirst().second.recycle()
        }
        Log.i(TAG, "held picture for page $s (match=$n)")
    }

    /** The newest held picture of page `s` (removed from the list); older pages' pictures are dropped. */
    private fun takeHeld(s: Int): Bitmap? = synchronized(held) {
        val iter = held.iterator()
        while (iter.hasNext()) {
            val e = iter.next()
            if (e.first < s) {
                e.second.recycle()
                iter.remove()
            }
        }
        val e = held.lastOrNull { it.first == s } ?: return null
        held.remove(e)
        e.second
    }

    /**
     * Read thread: the page's number on the pictures held after the shot,
     * when the shot's own picture gave none. Each is framed again
     * (DocAligner; the shot's frame when the model is not sure) and read
     * with the same one ML Kit call. Run 25/26, single-land-white at
     * 960x1280: the folio "— N —" read on 2 of 10 shots; another rendering
     * of the same picture (MarginReader.extraLines) read none of the other
     * 8, while run 24 saw the same page read on one camera picture and not
     * on the next — a new picture is the better second chance.
     */
    private fun readHeld(name: String, spread: Boolean, s: Int, kf: Quad): PageNumbers.Pick? {
        for (i in 1..HELD_READS) {
            if (closed.get()) return null
            val f = takeHeld(s) ?: return null
            val page = try {
                val r = detector?.detect(f)
                val q = r?.quad?.takeIf { r.minPeak >= CaptureDetector.MIN_PEAK && PageFrame.plausible(it, f.width, f.height) && !PageFrame.outside(it, f.width, f.height) }
                if (q != null) PageRead.cut(f, q).page else PageFrame.warp(f, kf, PageRead.PAGE_MAX_SIDE)
            } catch (e: Exception) {
                Log.w(TAG, "held picture $i of $name not cut", e)
                null
            } finally {
                f.recycle()
            }
            if (page == null) continue
            val pick = try {
                readNumber(page, "$name#h$i", spread, fallback = false)
            } finally {
                page.recycle()
            }
            Log.i(TAG, "number for $name: held picture $i read ${pick.nums}${if (pick.strong) "" else " (weak)"}")
            if (pick.nums.isNotEmpty()) return pick
        }
        return null
    }

    /** One analysed frame: stability, re-arming after a turn, auto-capture, the yellow notice. */
    private fun step(now: Long, q: Quad?, frame: Bitmap) {
        if (q == null) {
            // One frame without the paper (a blink of the model) keeps the
            // stillness; NULL_RESET in a row start it again.
            nullStreak++
            if (nullStreak >= NULL_RESET) {
                anchor = null
                recent.clear()
            }
            if (!armed && now - lastCaptureAt > 300) turnSeen = true
        } else {
            nullStreak = 0
            recent.addLast(q)
            while (recent.size > SMOOTH_N) recent.removeFirst()
            val m = median(recent)
            val a = anchor
            if (a == null || m.maxMove(a) > STABLE_TOL * m.diagonal) {
                if (a != null && !armed && now - lastCaptureAt > 300) turnSeen = true
                anchor = m
                stableSince = now
            }
            if (now - stableSince >= GOOD_MS) lastGoodAt = now
        }
        val stableFor = if (q != null && anchor != null) now - stableSince else 0L
        // After a page is taken: not again until the camera shows another
        // page — its print no longer matches the page taken (PageMatch). A
        // page with too little print to match (blank) needs a visible turn.
        if (!armed && !busy.get() && q != null && stableFor >= STABLE_MS && now - lastMatchAt >= MATCH_EVERY_MS) {
            lastMatchAt = now
            val ref = refFeatures
            val t0 = SystemClock.elapsedRealtime()
            if (ref != null && ref.size >= PageMatch.MIN_FEATURES) {
                val g = PageMatch.gray(frame)
                val cur = PageMatch.features(g, refRegion)
                val n = PageMatch.inliers(ref, cur)
                val ms = SystemClock.elapsedRealtime() - t0
                val other = n < PageMatch.OTHER_PAGE
                if (other || now - lastSigLog > 2000) {
                    lastSigLog = now
                    Log.i(TAG, "rearm check match=$n of ${ref.size}/${cur.size} (${ms}ms) ${if (other) "another page" else "same page"} turnSeen=$turnSeen")
                }
                if (other) {
                    armed = true
                    candFeatures = cur
                    Log.i(TAG, "armed (match=$n)")
                }
            } else if (turnSeen) {
                armed = true
                Log.i(TAG, "armed (turn seen; page had ${ref?.size ?: 0} points to match)")
            }
            // The new page is taken only after STABLE_MS more of stillness:
            // the frame that showed "another page" may be mid-turn.
            if (armed) {
                stableSince = now
                return
            }
        }
        if (armed && !busy.get() && q != null && stableFor >= STABLE_MS) {
            // Still = the corners AND the print: during a turn the outer
            // corners of a spread stay put (run 21 took pages with the leaf
            // standing up). The print must match the picture the stillness
            // counts from; otherwise it counts again from this one.
            val cand = candFeatures
            if (cand != null && cand.size >= PageMatch.MIN_FEATURES) {
                val cur = try {
                    PageMatch.features(PageMatch.gray(frame), refRegion)
                } catch (e: Exception) {
                    null
                }
                val n = if (cur != null) PageMatch.inliers(cand, cur) else 0
                if (cur != null && n < PageMatch.OTHER_PAGE) {
                    Log.i(TAG, "still check match=$n: the print is still changing")
                    candFeatures = cur
                    stableSince = now
                    return
                }
            }
            candFeatures = null
            armed = false
            turnSeen = false
            lastCaptureAt = now
            lastMatchAt = now
            try {
                val g = PageMatch.gray(frame)
                val region = PageMatch.region(q, g)
                refRegion = region
                refFeatures = PageMatch.features(g, region)
                Log.i(TAG, "reference ${refFeatures?.size} points")
            } catch (e: Exception) {
                Log.w(TAG, "page points failed", e)
                refFeatures = null
            }
            busy.set(true)
            val copy = frame.copy(Bitmap.Config.ARGB_8888, false)
            val at = System.currentTimeMillis()
            runOnUiThread { setBanner("busy", "撮影中…") }
            work.execute { capture(copy, q, at) }
            return
        }
        // Yellow: waiting for a page, and for YELLOW_MS no frame held still.
        val waiting = armed || turnSeen
        val quiet = now - lastCaptureAt > BANNER_MS
        val offLong = offSince != 0L && now - offSince >= OFF_YELLOW_MS
        if (waiting && quiet && !busy.get() && (offLong || now - max(lastGoodAt, lastCaptureAt) >= YELLOW_MS)) {
            runOnUiThread { if (bannerKind != "yellow" && bannerKind != "gap") setBanner("yellow", "紙全体を画面に入れてください") }
        } else if (q != null && stableFor >= GOOD_MS) {
            runOnUiThread { if (bannerKind == "yellow") setBanner("idle", "そのまま止めてください") }
        }
    }

    /** Corner by corner median of the frames found. */
    private fun median(qs: Collection<Quad>): Quad {
        val l = qs.toList()
        fun med(v: List<Float>): Float {
            val s = v.sorted()
            val k = s.size / 2
            return if (s.size % 2 == 1) s[k] else (s[k - 1] + s[k]) / 2
        }
        return Quad(FloatArray(4) { i -> med(l.map { it.x[i] }) }, FloatArray(4) { i -> med(l.map { it.y[i] }) })
    }

    // ------------------------------------------------------------- capture

    /** Work thread: take the still, frame and cut the page, keep it; its number is read on readExec. */
    private fun capture(frame: Bitmap, frameQuad: Quad, at: Long) {
        var photo: Bitmap? = null
        try {
            val det = detector ?: return
            val t0 = SystemClock.elapsedRealtime()
            photo = takeStill() ?: frame
            val tStill = SystemClock.elapsedRealtime()
            // The frame found on the still itself; when the model is not
            // sure there, the analysis frame's scaled over.
            var q = frameQuad.scaled(photo.width.toFloat() / frame.width, photo.height.toFloat() / frame.height)
            var source = "analysis"
            if (photo !== frame) {
                val ph: Bitmap = photo
                fun sure(r: CaptureDetector.Result?) =
                    r != null && r.minPeak >= CaptureDetector.MIN_PEAK && PageFrame.plausible(r.quad, ph.width, ph.height)
                var r = det.detect(photo)
                var how = "still"
                if (!sure(r)) {
                    // The model wants desk around the paper (phone-resolution
                    // stills of the thick spread: 3–4 of 6 found as is, 6 of
                    // 6 with the edges repeated outward).
                    r = det.detect(photo, CaptureDetector.CONTEXT_PAD)
                    how = "still-padded"
                }
                // How far the still's frame is from the frame held still on
                // the analysed pictures (share of the picture's diagonal).
                // Run 25, single-land-white p39: the still came mid-change
                // (ghost of another page), DocAligner put its top-left
                // corner 300 px low and the page was cut 253 clip px off.
                val off = if (r != null && sure(r)) (r.quad.maxMove(q) / hypot(ph.width.toDouble(), ph.height.toDouble())).toFloat() else -1f
                if (r != null && sure(r) && off <= STILL_AGREE) {
                    q = r.quad
                    source = how
                } else if (photo.width == frame.width && photo.height == frame.height) {
                    if (off > STILL_AGREE) Log.i(TAG, "still frame ${r?.quad} is %.1f %% of the diagonal from the held frame $q; the analysed picture is cut".format(off * 100))
                    // Not sure on the still: the page is cut from the
                    // analysed frame its frame was found on (run 26: that
                    // frame laid over the still, taken a moment later by a
                    // shaking hand, missed spread-land-white-thick's corners
                    // by 50–90 clip px).
                    photo.recycle()
                    photo = frame
                }
            }
            val tDetect = SystemClock.elapsedRealtime()
            val pc = PageRead.cut(photo, q)
            val kept = pc.kept
            val cut = pc.gutter
            val page = pc.page
            // The same page cut from the analysis frame (another camera
            // picture of the same moment) for the number's second read.
            val second = if (photo !== frame) {
                val kf = kept.scaled(frame.width.toFloat() / photo.width, frame.height.toFloat() / photo.height)
                try {
                    PageFrame.warp(frame, kf, PageRead.PAGE_MAX_SIDE)
                } catch (e: Exception) {
                    null
                }
            } else {
                null
            }
            seq++
            val name = "$stamp-$seq.jpg"
            val pageSeq = seq
            // Held pictures only for a single page (readHeld is not used for spreads).
            heldSeq = if (kept.isSpread || HELD_READS == 0) 0 else seq
            val keptInFrame = kept.scaled(frame.width.toFloat() / photo.width, frame.height.toFloat() / photo.height)
            // The kept page is the curvature-corrected one (PageFlatten);
            // the number is still read on the straight cut `page`.
            val tFlat = SystemClock.elapsedRealtime()
            val (flat, flatWhy) = try {
                PageFlatten.flattenOrWhy(photo, kept, page.width, page.height)
            } catch (e: Exception) {
                Log.w(TAG, "flatten failed for $name", e)
                Pair(null, "error ${e.javaClass.simpleName}")
            }
            Log.i(
                TAG,
                if (flat != null) {
                    "flatten $name ${page.width}x${page.height} bow top=%.4f bottom=%.4f inliers=%d/%d %dms".format(
                        flat.topBow, flat.bottomBow, flat.inliersTop, flat.inliersBottom, SystemClock.elapsedRealtime() - tFlat,
                    )
                } else {
                    "flatten $name ${page.width}x${page.height} none (straight cut kept: $flatWhy) spread=${kept.isSpread} ${SystemClock.elapsedRealtime() - tFlat}ms"
                },
            )
            File(scansDir, name).outputStream().use { (flat?.image ?: page).compress(Bitmap.CompressFormat.JPEG, 90, it) }
            evalDir?.let { dir ->
                File(dir, name.replace(".jpg", "-frame.jpg")).outputStream().use { photo.compress(Bitmap.CompressFormat.JPEG, 92, it) }
                flat?.let { f -> File(dir, name.replace(".jpg", "-flat.jpg")).outputStream().use { f.image.compress(Bitmap.CompressFormat.JPEG, 92, it) } }
            }
            flat?.image?.recycle()
            // t = wall clock (ms) of the analysed frame that triggered the page.
            Log.i(TAG, "capture $name t=$at photo=${photo.width}x${photo.height} source=$source spread=${kept.isSpread} found=$q kept=$kept cut=$cut")
            val spread = kept.isSpread
            synchronized(session) { session.addPending(name, page.width, page.height, spread) }
            newestShot = name
            persist()
            val tShot = SystemClock.elapsedRealtime()
            Log.i(
                TAG,
                "timing-shot $name still=${tStill - t0}ms detect=${tDetect - tStill}ms page=${tShot - tDetect}ms total=${tShot - t0}ms",
            )
            runOnUiThread {
                setBanner("shot", "✓ 撮れた — めくってください")
                vibrate(80)
                updateInfo()
            }
            pendingReads.incrementAndGet()
            try {
                readExec.execute { readPage(name, page, second, spread, tShot, pageSeq, keptInFrame) }
            } catch (e: Exception) {
                pendingReads.decrementAndGet()
                Log.w(TAG, "number not read for $name", e)
            }
        } catch (e: Exception) {
            Log.e(TAG, "capture failed", e)
            runOnUiThread { setBanner("yellow", "撮れませんでした。もう一度止めてください") }
            armed = true
        } finally {
            if (photo != null && photo !== frame) photo.recycle()
            frame.recycle()
            busy.set(false)
        }
    }

    /**
     * Read thread: the page's printed number, then its place in the
     * session, the banner (newest page, or red for a missing page) and the
     * saved list. `page` and `second` are recycled here.
     */
    private fun readPage(name: String, page: Bitmap, second: Bitmap?, spread: Boolean, shotAt: Long, pageSeq: Int, keptInFrame: Quad) {
        try {
            if (closed.get()) return
            val t0 = SystemClock.elapsedRealtime()
            // Nothing on the shot: the pictures held since (readHeld). The
            // other renderings of the shot (MarginReader.extraLines) read
            // none of 8 such pages in run 26, so they are not tried here.
            var pick = readNumber(page, name, spread, fallback = false)
            // Single pages only, one held picture: at most one more call, as
            // the extra renderings were (spreads: none; at 960x1280 none of
            // run 26's 19 spread pages read a number on any picture).
            if (pick.nums.isEmpty() && !spread && HELD_READS > 0) pick = readHeld(name, spread, pageSeq, keptInFrame) ?: pick
            val tRead = SystemClock.elapsedRealtime()
            val (nums, guess) = confirm(pick, spread, name, second)
            val tConfirm = SystemClock.elapsedRealtime()
            Log.i(
                TAG,
                "timing $name queued=${t0 - shotAt}ms read=${tRead - t0}ms confirm=${tConfirm - tRead}ms " +
                    "total=${tConfirm - t0}ms",
            )
            val before = synchronized(session) { session.pages.associate { it.name to it.nums } }
            val outcome = synchronized(session) {
                if (closed.get()) null else session.resolve(name, nums, guess)
            } ?: return
            // Earlier pages whose number read once this page confirmed.
            val promoted = synchronized(session) {
                session.pages.filter { it.name != name && it.nums.isNotEmpty() && before[it.name]?.isEmpty() == true }.map { it.name to it.nums }
            }
            for ((pn, pnums) in promoted) Log.i(TAG, "page $pn kind=promoted nums=$pnums (confirmed by $name)")
            if (outcome is CaptureSession.Outcome.Duplicate) File(scansDir, name).delete()
            persist()
            val (missing, step, n) = synchronized(session) { Triple(session.missing.toList(), session.step, session.pages.size) }
            val kept = synchronized(session) { session.pages.firstOrNull { it.name == name }?.nums ?: emptyList() }
            Log.i(TAG, "page $name kind=${kindOf(outcome)} nums=$kept guess=$guess missing=$missing step=$step pages=$n")
            runOnUiThread { shown(name, outcome) }
        } catch (e: Exception) {
            Log.e(TAG, "reading the number of $name failed", e)
            val outcome = synchronized(session) { if (closed.get()) null else session.resolve(name, emptyList()) }
            if (outcome != null) {
                persist()
                Log.i(TAG, "page $name kind=${kindOf(outcome)} nums=[] (read failed)")
                runOnUiThread { shown(name, outcome) }
            }
        } finally {
            page.recycle()
            second?.recycle()
            pendingReads.decrementAndGet()
        }
    }

    /** A number result: on the banner when it is the newest page (a missing page always). */
    private fun shown(name: String, o: CaptureSession.Outcome) {
        if (finishing.get()) return
        if (name == newestShot || o is CaptureSession.Outcome.Gap) {
            show(o)
        } else {
            Log.i(TAG, "result $name ${kindOf(o)} (a newer page is on the banner)")
            updateInfo()
        }
    }

    /** The session as the result file (also written after every page, see the class doc). */
    private fun sessionJson(closing: Boolean): JSONObject = synchronized(session) {
        val pages = JSONArray()
        for (p in session.pages) {
            pages.put(
                JSONObject()
                    .put("file", File(scansDir, p.name).path)
                    .put("width", p.width)
                    .put("height", p.height)
                    .put("nums", JSONArray(p.nums))
                    .put("spread", p.spread)
                    .put("numberState", p.numberState),
            )
        }
        JSONObject()
            .put("pages", pages)
            .put("missing", JSONArray(session.missing.toList()))
            .put("sideStep", session.step)
            .put("final", closing)
    }

    private val resultFile by lazy { File(scansDir, "capture-$stamp.json") }

    /** Write the page list now (atomically), so the pages outlive the process. */
    private fun persist() {
        synchronized(resultFile) {
            if (closed.get()) return
            try {
                val tmp = File(scansDir, "capture-$stamp.json.tmp")
                tmp.writeText(sessionJson(false).toString())
                if (tmp.renameTo(resultFile)) return
                resultFile.writeText(tmp.readText())
                tmp.delete()
            } catch (e: Exception) {
                Log.w(TAG, "saving the page list failed", e)
            }
            Unit
        }
    }

    private fun takeStill(): Bitmap? {
        val cap = imageCapture ?: return null
        val done = CountDownLatch(1)
        var out: Bitmap? = null
        // Not on `work`: it is waiting for this picture.
        cap.takePicture(stillExec, object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                try {
                    out = upright(image.toBitmap(), image.imageInfo.rotationDegrees)
                } catch (e: Exception) {
                    Log.w(TAG, "still decode failed", e)
                } finally {
                    image.close()
                    done.countDown()
                }
            }

            override fun onError(exception: ImageCaptureException) {
                Log.w(TAG, "still capture failed: ${exception.message}")
                done.countDown()
            }
        })
        if (!done.await(STILL_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            Log.w(TAG, "still capture timed out")
            return null
        }
        return out
    }

    private fun readNumber(page: Bitmap, name: String, spread: Boolean, fallback: Boolean = true): PageNumbers.Pick {
        // One sample picture for the "solo" call on close (emulator check):
        // composed once, not on every page (CPU the read shares).
        if (evalDir != null && !name.contains('#') && synchronized(this) { soloSample == null }) {
            try {
                val pic = MarginReader.marginPicture(page, PageRead.BAND_FRAC, PageNumbers.MARGIN_FRAC, PageRead.BAND_WIDTH)
                synchronized(this) {
                    soloSample?.recycle()
                    soloSample = pic
                }
            } catch (_: Exception) {
            }
        }
        // One ML Kit call: the bands and the folio pieces in one picture;
        // a second, smaller one only when that read no number (`fallback`).
        return PageRead.read(page, name, spread, fallback)
    }

    /**
     * The number(s) to keep for a page (NumberRule, shared with the stills
     * check): the other camera picture `second` is read (one ML Kit call)
     * only when the rule needs it.
     */
    private fun confirm(pick: PageNumbers.Pick, spread: Boolean, name: String, second: Bitmap?): Pair<List<Int>, List<Int>> =
        NumberRule.decide(
            session,
            pick,
            spread,
            name,
            second?.let { b -> { readNumber(b, "$name#2", spread, fallback = false) } },
        ) { Log.i(TAG, it) }

    private fun kindOf(o: CaptureSession.Outcome): String = when (o) {
        is CaptureSession.Outcome.Taken -> "taken"
        is CaptureSession.Outcome.Unread -> "unread"
        is CaptureSession.Outcome.Filled -> "filled"
        is CaptureSession.Outcome.Gap -> "gap"
        is CaptureSession.Outcome.Duplicate -> "duplicate"
    }

    private fun show(o: CaptureSession.Outcome) {
        when (o) {
            is CaptureSession.Outcome.Taken -> {
                // (The vibration came with "✓ 撮れた".)
                setBanner("taken", "✓ ${CaptureSession.label(o.nums)} ページ 撮れた — めくってください")
            }
            is CaptureSession.Outcome.Unread -> {
                setBanner("unread", "✓ 撮れた（番号なし）— めくってください")
            }
            is CaptureSession.Outcome.Filled -> {
                setBanner("filled", "✓ ${CaptureSession.label(o.nums)} ページ 撮れた（抜けを埋めました）— 続きへ")
            }
            is CaptureSession.Outcome.Gap -> {
                setBanner("gap", "${CaptureSession.label(o.missing)} ページが抜けています。戻って撮ってください")
                vibrate(300)
            }
            is CaptureSession.Outcome.Duplicate -> setBanner("duplicate", "${CaptureSession.label(o.nums)} ページは撮影済みです — めくってください")
        }
        updateInfo()
    }

    // -------------------------------------------------------------- finish

    private fun finishWithPages() {
        if (!finishing.compareAndSet(false, true)) return
        doneButton.isEnabled = false
        val reading = pendingReads.get()
        Log.i(TAG, "finishing (numbers being read: $reading)")
        if (reading > 0) setBanner("busy", "番号を読み取り中…")
        // Eval mode: the camera stops first, so the solo ML Kit call below
        // runs with nothing else on the CPU.
        if (evalDir != null) {
            try {
                cameraProvider?.unbindAll()
            } catch (_: Exception) {
            }
        }
        work.execute {
            // A page being taken is finished first (the work thread is
            // serial); numbers still being read get FINISH_READ_WAIT_MS.
            try {
                readExec.submit {}.get(FINISH_READ_WAIT_MS, TimeUnit.MILLISECONDS)
            } catch (e: Exception) {
                Log.w(TAG, "closing with ${pendingReads.get()} numbers not read yet")
            }
            val sample = synchronized(this) { soloSample.also { soloSample = null } }
            if (sample != null) {
                try {
                    MarginReader.timeAlone(sample, "camera stopped, numbers still being read: ${pendingReads.get()}")
                } catch (e: Exception) {
                    Log.w(TAG, "solo call failed", e)
                }
            }
            val out = synchronized(session) {
                session.giveUpReading()
                sessionJson(true)
            }
            synchronized(resultFile) {
                closed.set(true)
                resultFile.writeText(out.toString())
            }
            Log.i(TAG, "done ${out.getJSONArray("pages").length()} pages, missing ${out.getJSONArray("missing")}")
            runOnUiThread {
                setResult(RESULT_OK, Intent().putExtra(EXTRA_RESULT, resultFile.path))
                finish()
            }
        }
    }

    private fun finishWithError(code: String, msg: String) {
        if (!finishing.compareAndSet(false, true)) return
        // Pages taken stay in the saved list (ScannerPlugin.takePending).
        Log.e(TAG, "closing: $code $msg")
        setResult(RESULT_CANCELED, Intent().putExtra(EXTRA_ERROR, code).putExtra(EXTRA_MESSAGE, msg))
        finish()
    }

    /** The frame found, drawn over the preview (FIT_CENTER: the camera picture fitted into the view); yellow when it runs off the picture. */
    private class OverlayView(context: Context) : View(context) {
        private var quad: Quad? = null
        private var fw = 1
        private var fh = 1
        private var stable = false
        private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            color = 0xFF2EE66B.toInt()
            strokeJoin = Paint.Join.ROUND
        }
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            color = 0x332EE66B
        }
        private val path = Path()

        private var off = false

        fun show(q: Quad?, w: Int, h: Int, stable: Boolean, off: Boolean) {
            quad = q
            fw = w
            fh = h
            this.stable = stable
            this.off = off
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val q = quad ?: return
            val s = min(width.toFloat() / fw, height.toFloat() / fh)
            val ox = (width - fw * s) / 2
            val oy = (height - fh * s) / 2
            path.reset()
            for (i in 0 until 4) {
                val x = ox + q.x[i] * s
                val y = oy + q.y[i] * s
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            path.close()
            stroke.strokeWidth = resources.displayMetrics.density * if (stable) 6 else 4
            stroke.color = if (off) 0xFFF9C80E.toInt() else 0xFF2EE66B.toInt()
            if (stable && !off) canvas.drawPath(path, fill)
            canvas.drawPath(path, stroke)
        }
    }

    companion object {
        const val TAG = "AstarScanCapture"
        const val EXTRA_KNOWN = "known"
        const val EXTRA_STEP = "sideStep"
        const val EXTRA_RESULT = "result"
        const val EXTRA_ERROR = "error"
        const val EXTRA_MESSAGE = "message"

        /** At most ~7 analysed frames a second (CLAUDE.md: 5–10 FPS is enough). */
        private const val ANALYSIS_MS = 140L
        /** While page numbers are being read (ML Kit needs the CPU too). */
        private const val READING_ANALYSIS_MS = 600L
        /** The frame finder pauses at most this long after a page is taken while its number is read. */
        private const val READ_PAUSE_MS = 15_000L
        /**
         * Largest corner move (share of the picture's diagonal, ~80 px on
         * the emulator's 960x1280) between the still's frame and the frame
         * held still on the analysed pictures for the still's frame to be
         * used; beyond it the still caught something else (a page turning,
         * the hand) and the analysed picture's frame is used.
         */
        private const val STILL_AGREE = 0.05f
        /** After a page is taken, the "another page?" match runs at most this often. */
        private const val MATCH_EVERY_MS = 400L
        /** Done waits this long for numbers still being read. */
        private const val FINISH_READ_WAIT_MS = 45_000L
        /** Frames whose corners are combined (median) for the stillness check. */
        private const val SMOOTH_N = 3
        /** This many frames in a row without the paper end the stillness. */
        private const val NULL_RESET = 2
        /** The paper runs off the camera picture this long → yellow notice. */
        private const val OFF_YELLOW_MS = 1000L
        /** One "status" log line (what the frame finder sees) this often. */
        private const val STATUS_LOG_MS = 2000L
        /** The frame must stand still this long before the page is taken. */
        private const val STABLE_MS = 1000L
        /** "Still": no corner of the median frame moves more than this share of the diagonal. */
        private const val STABLE_TOL = 0.04
        /** A frame held this long counts as "found" (resets the yellow timer). */
        private const val GOOD_MS = 500L
        /** No frame held still for this long → yellow notice. */
        private const val YELLOW_MS = 3000L
        /** A page's banner stays at least this long before yellow may replace it. */
        private const val BANNER_MS = 2500L
        private const val STILL_TIMEOUT_MS = 4000L
        /** A picture of the page just taken is held at most this often while its number is read. */
        private const val HELD_EVERY_MS = 1500L
        private const val HELD_MAX = 3
        /** PageMatch inliers for "still the page just taken" (re-arming needs < OTHER_PAGE = 40). */
        private const val HELD_MATCH = 100
        /** Held pictures read at most, one ML Kit call each. */
        /**
         * Off (0): run 27 read a held picture on 13 unread single pages,
         * ~15–20 s each next to the camera; it gave 4 numbers on
         * single-port-wood (12/12 also without it, run 26, by the step) and
         * none on single-land-white, and the median time to a number went
         * 13.7 → 14.2 s. Held pictures are not grabbed either (PageMatch on
         * the analysis thread shares the CPU with ML Kit).
         */
        private const val HELD_READS = 0
    }
}
