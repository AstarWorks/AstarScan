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
import kotlin.math.abs
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
 *    same page is not taken again until it has been turned.
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
    private var lastSig: FloatArray? = null
    private var lastCaptureAt = 0L
    private var lastSigLog = 0L
    private var frameInfoLogged = false
    private var lastStatusLog = 0L
    /** Since when the frame found runs off the camera picture (0: it does not). */
    @Volatile private var offSince = 0L
    private val busy = AtomicBoolean(false)
    private val finishing = AtomicBoolean(false)

    // Main-thread state.
    private var bannerKind = ""
    private var yellowShown = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val known = intent.getIntArrayExtra(EXTRA_KNOWN)?.toList() ?: emptyList()
        session = CaptureSession(known, intent.getIntExtra(EXTRA_STEP, 0))
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
            // No frame finding while a page is being cut (a second or two),
            // and less of it while numbers are read: on a slow phone (the CI
            // emulator, runs 19–20: DocAligner ~0.7–2 s a frame) it starves
            // ML Kit.
            val every = if (pendingReads.get() > 0) READING_ANALYSIS_MS else ANALYSIS_MS
            if (busy.get() || now - lastAnalyzed < every || finishing.get()) return
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
                        "armed=$armed turnSeen=$turnSeen busy=${busy.get()} reading=${pendingReads.get()} banner=$bannerKind",
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
        // After a page is taken: wait until the picture is another page.
        if (!armed && !busy.get() && q != null && stableFor >= STABLE_MS) {
            val sig = signature(frame, q)
            val prev = lastSig
            val diff = if (prev != null) sigDiff(prev, sig) else 1.0
            if (now - lastSigLog > 1000) {
                lastSigLog = now
                Log.i(TAG, "rearm check diff=%.3f turnSeen=$turnSeen".format(diff))
            }
            if (diff > REARM_ALWAYS || (turnSeen && diff > REARM_AFTER_TURN)) {
                armed = true
                Log.i(TAG, "armed (diff=%.3f turnSeen=$turnSeen)".format(diff))
            }
        }
        if (armed && !busy.get() && q != null && stableFor >= STABLE_MS) {
            armed = false
            turnSeen = false
            lastCaptureAt = now
            lastSig = signature(frame, q)
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

    /** The page's look at 24×32 (local contrast), to tell a turned page from the same one. */
    private fun signature(frame: Bitmap, q: Quad): FloatArray {
        val small = PageFrame.warp(frame, q, 32)
        val w = small.width
        val h = small.height
        val px = IntArray(w * h)
        small.getPixels(px, 0, w, 0, 0, w, h)
        small.recycle()
        val lum = PageFrame.luminance(px)
        val mean = lum.average()
        val out = FloatArray(32 * 32)
        for (i in out.indices) {
            val x = (i % 32) * w / 32
            val y = (i / 32) * h / 32
            out[i] = (lum[min(h - 1, y) * w + min(w - 1, x)] - mean).toFloat()
        }
        return out
    }

    private fun sigDiff(a: FloatArray, b: FloatArray): Double {
        var d = 0.0
        var s = 0.0
        for (i in a.indices) {
            d += abs(a[i] - b[i])
            s += abs(a[i]) + abs(b[i])
        }
        return if (s < 1e-6) 0.0 else 2 * d / s
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
                val r = det.detect(photo)
                if (r != null && r.minPeak >= CaptureDetector.MIN_PEAK && PageFrame.plausible(r.quad, photo.width, photo.height)) {
                    q = r.quad
                    source = "still"
                }
            }
            val tDetect = SystemClock.elapsedRealtime()
            // Gutter cut / edge fit on a copy of at most 1600 px.
            val ks = min(1f, 1600f / max(photo.width, photo.height))
            val probe = if (ks < 1f) Bitmap.createScaledBitmap(photo, (photo.width * ks).roundToInt(), (photo.height * ks).roundToInt(), true) else photo
            val (kept0, cut) = PageFrame.keep(probe, q.scaled(ks, ks))
            if (probe !== photo) probe.recycle()
            val kept = kept0.scaled(1 / ks, 1 / ks)
            val page = PageFrame.warp(photo, kept, PAGE_MAX_SIDE)
            // The same page cut from the analysis frame (another camera
            // picture of the same moment) for the number's second read.
            val second = if (photo !== frame) {
                val kf = kept.scaled(frame.width.toFloat() / photo.width, frame.height.toFloat() / photo.height)
                try {
                    PageFrame.warp(frame, kf, PAGE_MAX_SIDE)
                } catch (e: Exception) {
                    null
                }
            } else {
                null
            }
            seq++
            val name = "$stamp-$seq.jpg"
            File(scansDir, name).outputStream().use { page.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            evalDir?.let { dir ->
                File(dir, name.replace(".jpg", "-frame.jpg")).outputStream().use { photo.compress(Bitmap.CompressFormat.JPEG, 92, it) }
            }
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
                readExec.execute { readPage(name, page, second, spread, tShot) }
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
    private fun readPage(name: String, page: Bitmap, second: Bitmap?, spread: Boolean, shotAt: Long) {
        try {
            if (closed.get()) return
            val t0 = SystemClock.elapsedRealtime()
            val pick = readNumber(page, name)
            val tRead = SystemClock.elapsedRealtime()
            val nums = confirm(pick, spread, name, second)
            val tConfirm = SystemClock.elapsedRealtime()
            Log.i(
                TAG,
                "timing $name queued=${t0 - shotAt}ms read=${tRead - t0}ms confirm=${tConfirm - tRead}ms " +
                    "total=${tConfirm - t0}ms",
            )
            val outcome = synchronized(session) {
                if (closed.get()) null else session.resolve(name, nums)
            } ?: return
            if (outcome is CaptureSession.Outcome.Duplicate) File(scansDir, name).delete()
            persist()
            val (missing, step, n) = synchronized(session) { Triple(session.missing.toList(), session.step, session.pages.size) }
            Log.i(TAG, "page $name kind=${kindOf(outcome)} nums=$nums missing=$missing step=$step pages=$n")
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
            .put("sideStep", if (session.step == 0) 1 else session.step)
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
                if (!tmp.renameTo(resultFile)) {
                    resultFile.writeText(tmp.readText())
                    tmp.delete()
                }
            } catch (e: Exception) {
                Log.w(TAG, "saving the page list failed", e)
            }
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

    private fun readNumber(page: Bitmap, name: String): PageNumbers.Pick {
        val band = MarginReader.bandLines(page, PageNumbers.MARGIN_FRAC, 1600)
        Log.i(AstarScanMlkit, "margins $name ${page.width}x${page.height} pass=band ${MarginReader.json(band)}")
        val b = PageNumbers.pick(band)
        if (b.nums.isNotEmpty()) return b
        val folio = MarginReader.folioLines(page, PageNumbers.MARGIN_FRAC)
        Log.i(AstarScanMlkit, "margins $name ${page.width}x${page.height} pass=folio ${MarginReader.json(folio)}")
        return PageNumbers.pick(folio)
    }

    /**
     * The number(s) to keep for a page, so that a misread number never
     * reaches the list (run 18: p47 read as "4" from the body text):
     * - the next number (or a missing one), read as a whole line → kept;
     * - anything else (a jump, the first page, a weak read) → read again on
     *   the analysis frame of the same moment (another camera picture);
     *   kept only when both reads agree, otherwise the page is "番号なし";
     * - a number lower than the last page (and not missing), or more than
     *   MAX_JUMP ahead → "番号なし".
     */
    private fun confirm(pick: PageNumbers.Pick, spread: Boolean, name: String, second: Bitmap?): List<Int> {
        val nums = pick.nums
        val rel = synchronized(session) { session.relation(nums, spread) }
        if (rel == "duplicate") return nums
        if (rel == "expected" && pick.strong) return nums
        if (rel == "lower" || rel == "far") {
            Log.i(TAG, "number $nums for $name is $rel; not kept")
            return emptyList()
        }
        val again = second?.let { readNumber(it, "$name#2") }
        if (again == null) {
            Log.i(TAG, "number $nums for $name: no second frame; ${if (rel == "first" && pick.strong) "kept" else "not kept"}")
            return if ((rel == "first" || rel == "expected") && pick.strong) nums else emptyList()
        }
        if (nums.isEmpty()) {
            // First read found nothing: the second read may (kept only when it is the next page).
            val r2 = synchronized(session) { session.relation(again.nums, spread) }
            Log.i(TAG, "number for $name: second read ${again.nums} ($r2)")
            return if (again.strong && (r2 == "expected" || r2 == "duplicate")) again.nums else emptyList()
        }
        if (again.nums.sorted() == nums.sorted()) {
            Log.i(TAG, "number $nums for $name confirmed by a second read ($rel)")
            return nums
        }
        // Reads disagree: a spread may lose one number on one read.
        if (spread && again.nums.isNotEmpty() && again.nums.all { it in nums }) {
            return again.nums.takeIf { synchronized(session) { session.relation(it, spread) } == "expected" } ?: emptyList()
        }
        Log.i(TAG, "number $nums for $name not confirmed (second read ${again.nums}); not kept")
        return emptyList()
    }

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
        work.execute {
            // A page being taken is finished first (the work thread is
            // serial); numbers still being read get FINISH_READ_WAIT_MS.
            try {
                readExec.submit {}.get(FINISH_READ_WAIT_MS, TimeUnit.MILLISECONDS)
            } catch (e: Exception) {
                Log.w(TAG, "closing with ${pendingReads.get()} numbers not read yet")
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
        private const val AstarScanMlkit = "AstarScanMlkit"
        const val EXTRA_KNOWN = "known"
        const val EXTRA_STEP = "sideStep"
        const val EXTRA_RESULT = "result"
        const val EXTRA_ERROR = "error"
        const val EXTRA_MESSAGE = "message"

        /** At most ~7 analysed frames a second (CLAUDE.md: 5–10 FPS is enough). */
        private const val ANALYSIS_MS = 140L
        /** While page numbers are being read (ML Kit needs the CPU too). */
        private const val READING_ANALYSIS_MS = 300L
        /** Done waits this long for numbers still being read. */
        private const val FINISH_READ_WAIT_MS = 15_000L
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
        /** Re-arm when the page looks this different (any time / after a turn was seen). */
        private const val REARM_ALWAYS = 0.45
        private const val REARM_AFTER_TURN = 0.15
        private const val STILL_TIMEOUT_MS = 4000L
        private const val PAGE_MAX_SIDE = 2400
    }
}
