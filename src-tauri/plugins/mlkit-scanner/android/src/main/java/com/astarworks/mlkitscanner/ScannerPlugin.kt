package com.astarworks.mlkitscanner

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

@InvokeArg
class ScanArgs {
    /** Page numbers already in the app's list (an earlier capture), so the screen goes on from them. */
    var known: IntArray = IntArray(0)
    /** 1 or 2 when an earlier capture learnt it (CaptureSession.step); 0 unknown. */
    var sideStep: Int = 0
}

@InvokeArg
class ReadPageArgs {
    lateinit var uri: String
    var maxSide: Int = 1600
    var quality: Int = 85
}

@InvokeArg
class ReadMarginsArgs {
    /** A `file://` page returned by `scan`, or a `data:image/jpeg;base64,` URL. */
    lateinit var uri: String
    /** Share of the page height read at the top and at the bottom. */
    var marginFrac: Double = 0.15
    /** A band narrower than this is enlarged (at most 4×) before recognition. */
    var minWidth: Int = 1600
}

@InvokeArg
class SavePdfArgs {
    /** `file://` paths returned by `scan`, or `data:image/jpeg;base64,` URLs. */
    lateinit var pages: Array<String>
    var name: String? = null
    var open: Boolean = false
}

@InvokeArg
class UploadArgs {
    /** AstarManagement origin, e.g. `https://app.example.com`. */
    lateinit var server: String
    /** Service account token (`asm_sk_…`); sent only as a Bearer header. */
    lateinit var token: String
    lateinit var folderId: String
    lateinit var name: String
    lateinit var pages: Array<String>
}

/**
 * The app's own capture screen (CaptureActivity: camera, DocAligner page
 * frame, auto-capture, page number read on the spot) → JPEG pages in the
 * app's files dir. `readPage` hands a downscaled copy to the webview;
 * `savePdf` writes the full-size JPEGs into one PDF under Download/AstarScan.
 */
@TauriPlugin
class ScannerPlugin(private val activity: Activity) : Plugin(activity) {
    private val io = Executors.newSingleThreadExecutor()

    @Command
    fun scan(invoke: Invoke) {
        val args = invoke.parseArgs(ScanArgs::class.java)
        val intent = Intent(activity, CaptureActivity::class.java)
            .putExtra(CaptureActivity.EXTRA_KNOWN, args.known)
            .putExtra(CaptureActivity.EXTRA_STEP, args.sideStep)
        startActivityForResult(invoke, intent, "captureResult")
    }

    @ActivityCallback
    private fun captureResult(invoke: Invoke, result: ActivityResult) {
        val data = result.data
        val path = data?.getStringExtra(CaptureActivity.EXTRA_RESULT)
        if (result.resultCode != Activity.RESULT_OK || path == null) {
            val code = data?.getStringExtra(CaptureActivity.EXTRA_ERROR)
            if (code != null) {
                invoke.reject(data.getStringExtra(CaptureActivity.EXTRA_MESSAGE) ?: code, code)
            } else {
                // The screen went away without its result (killed): nothing to hand over.
                Log.i(TAG, "capture closed without a result (${result.resultCode})")
                invoke.resolve(JSObject().put("canceled", true).put("pages", JSArray()).put("missing", JSArray()))
            }
            return
        }
        io.execute {
            try {
                val json = JSONObject(File(path).readText())
                val src = json.getJSONArray("pages")
                val pages = JSArray()
                for (i in 0 until src.length()) {
                    val p = src.getJSONObject(i)
                    val f = File(p.getString("file"))
                    if (!f.exists()) continue
                    pages.put(
                        JSObject()
                            .put("uri", Uri.fromFile(f).toString())
                            .put("width", p.getInt("width"))
                            .put("height", p.getInt("height"))
                            .put("nums", ints(p.getJSONArray("nums")))
                            .put("spread", p.getBoolean("spread"))
                            .put("numberState", p.getString("numberState"))
                            .put("thumb", jpegDataUrl(f, 360, 70)),
                    )
                }
                File(path).delete()
                invoke.resolve(
                    JSObject()
                        .put("canceled", false)
                        .put("pages", pages)
                        .put("missing", ints(json.getJSONArray("missing")))
                        .put("sideStep", json.optInt("sideStep", 1)),
                )
            } catch (e: Exception) {
                Log.e(TAG, "reading the capture result failed", e)
                invoke.reject(e.message ?: "result failed", "COPY_FAILED")
            }
        }
    }

    @Command
    fun readPage(invoke: Invoke) {
        val args = invoke.parseArgs(ReadPageArgs::class.java)
        io.execute {
            try {
                val dataUrl = jpegDataUrl(fileOf(args.uri), args.maxSide, args.quality)
                invoke.resolve(JSObject().put("dataUrl", dataUrl))
            } catch (e: Exception) {
                invoke.reject(e.message ?: "read failed", "READ_FAILED")
            }
        }
    }

    /**
     * Text in the top and bottom margins of a page (where the printed page
     * number sits), read with ML Kit Text Recognition v2 (Japanese model,
     * also reads Latin; bundled in the APK, runs on the device). Reads the
     * full-size scan, not the webview's 1600 px copy. Each line comes back
     * with its centre normalised to the page and ML Kit's confidence.
     */
    @Command
    fun readMargins(invoke: Invoke) {
        val args = invoke.parseArgs(ReadMarginsArgs::class.java)
        io.execute {
            var page: Bitmap? = null
            try {
                page = decodePage(args.uri, MAX_OCR_SIDE)
                val w = page.width
                val h = page.height
                val lines = JSArray()
                // Run 8 also read the outer 10 % in three enlarged tiles: +1
                // right, +1 wrong (p9 as "6" at 0.91) of 41 pages, so only the
                // band pass is kept — a wrong number makes a false 抜け row.
                val band = MarginReader.bandLines(page, args.marginFrac, args.minWidth)
                val folio = MarginReader.folioLines(page, args.marginFrac)
                for (l in band + folio) lines.put(lineJs(l))
                // One line per page and pass for the emulator check (book-measure.py).
                val name = nameOf(args.uri)
                Log.i(TAG, "margins $name ${w}x$h pass=band ${MarginReader.json(band)}")
                Log.i(TAG, "margins $name ${w}x$h pass=folio ${MarginReader.json(folio)}")
                invoke.resolve(JSObject().put("lines", lines).put("width", w).put("height", h))
            } catch (e: Exception) {
                Log.e(TAG, "read margins failed", e)
                invoke.reject(e.message ?: "read failed", "OCR_FAILED")
            } finally {
                page?.recycle()
            }
        }
    }

    /**
     * Emulator check only: page images pushed by adb into the app's external
     * files dir `ocr-probe/` are read with the same band pass as `readMargins`
     * when the app starts, one "probe" log line each, and deleted. Lets the
     * check compare ML Kit on the clip's own resolution with the emulator
     * camera's (scripts/android/probe-pages.py). Nothing happens without
     * that folder.
     */
    override fun load(webView: WebView) {
        super.load(webView)
        val dir = activity.getExternalFilesDir("ocr-probe") ?: return
        val files = dir.listFiles { f -> f.name.endsWith(".jpg") }?.sortedBy { it.name } ?: return
        if (files.isEmpty()) return
        io.execute {
            Log.i(TAG, "probe start ${files.size}")
            for (f in files) {
                var page: Bitmap? = null
                try {
                    page = BitmapFactory.decodeFile(f.path) ?: throw IllegalStateException("decode failed")
                    val band = MarginReader.bandLines(page, 0.15, 1600)
                    Log.i(TAG, "probe ${f.name} ${page.width}x${page.height} pass=band ${MarginReader.json(band)}")
                    val folio = MarginReader.folioLines(page, 0.15)
                    Log.i(TAG, "probe ${f.name} ${page.width}x${page.height} pass=folio ${MarginReader.json(folio)}")
                } catch (e: Exception) {
                    Log.e(TAG, "probe ${f.name} failed", e)
                } finally {
                    page?.recycle()
                    f.delete()
                }
            }
            Log.i(TAG, "probe done ${files.size}")
        }
    }

    private fun lineJs(l: PageNumbers.Line): JSObject = JSObject()
        .put("text", l.text)
        .put("conf", l.conf)
        .put("cx", l.cx)
        .put("cy", l.cy)
        .put("pass", l.pass)

    private fun ints(a: org.json.JSONArray): JSArray {
        val out = JSArray()
        for (i in 0 until a.length()) out.put(a.getInt(i))
        return out
    }

    @Command
    fun savePdf(invoke: Invoke) {
        val args = invoke.parseArgs(SavePdfArgs::class.java)
        if (args.pages.isEmpty()) {
            invoke.reject("no pages", "NO_PAGES")
            return
        }
        val base = (args.name ?: "astarscan-${System.currentTimeMillis()}")
            .replace(Regex("[\\\\/:*?\"<>|]"), "_")
        val fileName = if (base.endsWith(".pdf")) base else "$base.pdf"
        io.execute {
            try {
                val saved = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                        put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf")
                        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/AstarScan")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val resolver = activity.contentResolver
                    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                        ?: throw IllegalStateException("MediaStore insert failed")
                    resolver.openOutputStream(uri)!!.use { JpegPdfWriter.write(it, args.pages.map { p -> { jpegBytes(p) } }) }
                    values.clear()
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                    Pair(uri, "${Environment.DIRECTORY_DOWNLOADS}/AstarScan/$fileName")
                } else {
                    val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS)
                        ?: File(activity.filesDir, "pdf")
                    dir.mkdirs()
                    val file = File(dir, fileName)
                    file.outputStream().use { JpegPdfWriter.write(it, args.pages.map { p -> { jpegBytes(p) } }) }
                    Pair(Uri.fromFile(file), file.path)
                }
                if (args.open && saved.first.scheme == "content") {
                    activity.runOnUiThread {
                        try {
                            activity.startActivity(
                                Intent(Intent.ACTION_VIEW)
                                    .setDataAndType(saved.first, "application/pdf")
                                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
                            )
                        } catch (e: Exception) {
                            Log.w(TAG, "no PDF viewer", e)
                        }
                    }
                }
                invoke.resolve(
                    JSObject().put("uri", saved.first.toString()).put("path", saved.second),
                )
            } catch (e: Exception) {
                Log.e(TAG, "save pdf failed", e)
                invoke.reject(e.message ?: "save failed", "SAVE_FAILED")
            }
        }
    }

    /**
     * Send the pages to AstarManagement's book capture
     * (`POST /api/v1/book-captures`, multipart: folderId, name, pages[]).
     * Done natively so the webview's origin and CORS do not matter. The
     * server flattens the pages and saves `<name>.pdf` / `<name>.md` into the
     * folder in the background; the 202 response carries the job.
     */
    @Command
    fun upload(invoke: Invoke) {
        val args = invoke.parseArgs(UploadArgs::class.java)
        val base = try {
            uploadBase(args.server)
        } catch (e: IllegalArgumentException) {
            invoke.reject(e.message ?: "bad server", "BAD_SERVER")
            return
        }
        if (args.pages.isEmpty()) {
            invoke.reject("no pages", "NO_PAGES")
            return
        }
        io.execute {
            var conn: HttpURLConnection? = null
            try {
                val boundary = "AstarScan" + UUID.randomUUID().toString().replace("-", "")
                conn = (URL("$base/api/v1/book-captures").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    doOutput = true
                    connectTimeout = 20_000
                    readTimeout = 120_000
                    setChunkedStreamingMode(64 * 1024)
                    setRequestProperty("Authorization", "Bearer ${args.token.trim()}")
                    setRequestProperty("Accept", "application/json")
                    setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                }
                conn.outputStream.buffered().use { out ->
                    fun line(s: String) = out.write("$s\r\n".toByteArray(Charsets.UTF_8))
                    fun field(key: String, value: String) {
                        line("--$boundary")
                        line("Content-Disposition: form-data; name=\"$key\"")
                        line("Content-Type: text/plain; charset=UTF-8")
                        line("")
                        line(value)
                    }
                    field("folderId", args.folderId.trim())
                    field("name", args.name.trim())
                    args.pages.forEachIndexed { i, page ->
                        line("--$boundary")
                        line("Content-Disposition: form-data; name=\"pages\"; filename=\"page-${i + 1}.jpg\"")
                        line("Content-Type: image/jpeg")
                        line("")
                        out.write(jpegBytes(page))
                        line("")
                    }
                    line("--$boundary--")
                }
                val status = conn.responseCode
                val body = (if (status in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (status in 200..299) {
                    invoke.resolve(JSObject().put("status", status).put("body", body))
                } else {
                    invoke.reject("HTTP $status ${body.take(300)}", "HTTP_$status")
                }
            } catch (e: Exception) {
                Log.e(TAG, "upload failed", e)
                invoke.reject(e.message ?: "upload failed", "UPLOAD_FAILED")
            } finally {
                conn?.disconnect()
            }
        }
    }

    /** https only, except loopback / the emulator's host alias for local stacks. */
    private fun uploadBase(server: String): String {
        val url = URL(server.trim().trimEnd('/'))
        val local = url.host in setOf("localhost", "127.0.0.1", "10.0.2.2")
        require(url.protocol == "https" || (url.protocol == "http" && local)) { "server must be https://" }
        return url.toString().trimEnd('/')
    }

    private fun fileOf(uri: String): File {
        val path = Uri.parse(uri).path ?: throw IllegalArgumentException("bad uri")
        val file = File(path).canonicalFile
        val scans = File(activity.filesDir, "scans").canonicalFile
        require(file.path.startsWith(scans.path + File.separator)) { "outside scans dir" }
        return file
    }

    private fun jpegBytes(page: String): ByteArray {
        if (page.startsWith("data:")) {
            return Base64.decode(page.substringAfter(","), Base64.DEFAULT)
        }
        return fileOf(page).readBytes()
    }

    private fun nameOf(page: String): String =
        if (page.startsWith("data:")) "data-url" else File(Uri.parse(page).path ?: page).name

    /** The page as a bitmap, its long side at most `maxSide` (power-of-two sampling). */
    private fun decodePage(page: String, maxSide: Int): Bitmap {
        val bytes = jpegBytes(page)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > maxSide) sample *= 2
        return BitmapFactory.decodeByteArray(
            bytes,
            0,
            bytes.size,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: throw IllegalStateException("decode failed")
    }

    private fun jpegDataUrl(file: File, maxSide: Int, quality: Int): String {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        val longSide = maxOf(bounds.outWidth, bounds.outHeight)
        var sample = 1
        while (longSide / (sample * 2) >= maxSide) sample *= 2
        val decoded = BitmapFactory.decodeFile(
            file.path,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: throw IllegalStateException("decode failed")
        val scale = maxSide.toFloat() / maxOf(decoded.width, decoded.height)
        val bitmap = if (scale < 1f) {
            Bitmap.createScaledBitmap(
                decoded,
                (decoded.width * scale).toInt().coerceAtLeast(1),
                (decoded.height * scale).toInt().coerceAtLeast(1),
                true,
            ).also { decoded.recycle() }
        } else {
            decoded
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 95), out)
        bitmap.recycle()
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    companion object {
        private const val TAG = "AstarScanMlkit"
        private const val MAX_OCR_SIDE = 4096
    }
}
