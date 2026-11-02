package com.astarworks.mlkitscanner

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

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
 * Google ML Kit Document Scanner (SCANNER_MODE_FULL: edge detection,
 * auto-capture, crop/rotate/filter UI, no page limit) → JPEG pages copied
 * into the app's files dir. `readPage` hands a downscaled copy to the
 * webview; `savePdf` writes the full-size JPEGs into one PDF under
 * Download/AstarScan.
 */
@TauriPlugin
class ScannerPlugin(private val activity: Activity) : Plugin(activity) {
    private val io = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())

    @Command
    fun scan(invoke: Invoke) {
        startScan(invoke, 0)
    }

    /**
     * On first use Play services downloads the scanner module in the
     * background and `getStartScanIntent` fails with "Feature not
     * available" until it lands, so retry for up to ~3 minutes.
     */
    private fun startScan(invoke: Invoke, attempt: Int) {
        val options = GmsDocumentScannerOptions.Builder()
            .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
            .setGalleryImportAllowed(true)
            .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
            .build()
        GmsDocumentScanning.getClient(options)
            .getStartScanIntent(activity)
            .addOnSuccessListener { sender ->
                startIntentSenderForResult(
                    invoke,
                    IntentSenderRequest.Builder(sender).build(),
                    "scanResult",
                )
            }
            .addOnFailureListener { e ->
                if (attempt < MAX_ATTEMPTS) {
                    Log.w(TAG, "scanner not ready (attempt ${attempt + 1}): ${e.message}")
                    handler.postDelayed({ startScan(invoke, attempt + 1) }, RETRY_MS)
                } else {
                    Log.e(TAG, "scanner unavailable", e)
                    invoke.reject(e.message ?: "scanner unavailable", "SCANNER_UNAVAILABLE")
                }
            }
    }

    @ActivityCallback
    private fun scanResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            invoke.resolve(JSObject().put("canceled", true).put("pages", JSArray()))
            return
        }
        val scan = GmsDocumentScanningResult.fromActivityResultIntent(result.data)
        val uris = scan?.pages?.map { it.imageUri } ?: emptyList()
        io.execute {
            try {
                val dir = File(activity.filesDir, "scans").apply { mkdirs() }
                val stamp = System.currentTimeMillis()
                val pages = JSArray()
                uris.forEachIndexed { i, src ->
                    val dest = File(dir, "$stamp-${i + 1}.jpg")
                    activity.contentResolver.openInputStream(src)!!.use { input ->
                        dest.outputStream().use { input.copyTo(it) }
                    }
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(dest.path, bounds)
                    pages.put(
                        JSObject()
                            .put("uri", Uri.fromFile(dest).toString())
                            .put("width", bounds.outWidth)
                            .put("height", bounds.outHeight)
                            .put("thumb", jpegDataUrl(dest, 360, 70)),
                    )
                }
                invoke.resolve(JSObject().put("canceled", false).put("pages", pages))
            } catch (e: Exception) {
                Log.e(TAG, "copy scanned pages failed", e)
                invoke.reject(e.message ?: "copy failed", "COPY_FAILED")
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
                val band = (h * args.marginFrac.coerceIn(0.02, 0.5)).toInt().coerceAtLeast(1)
                val lines = JSArray()
                // Pass "band": each whole margin band, enlarged to minWidth.
                val bandLines = JSArray()
                val up = (args.minWidth.toFloat() / w).coerceIn(1f, 4f)
                for (top in listOf(true, false)) {
                    val y0 = if (top) 0 else h - band
                    recognizeRegion(page, 0, y0, w, band, up, "band", bandLines)
                }
                // Run 8 also read the outer 10 % in three enlarged tiles: +1
                // right, +1 wrong (p9 as "6" at 0.91) of 41 pages, so only the
                // band pass is kept — a wrong number makes a false 抜け row.
                for (i in 0 until bandLines.length()) lines.put(bandLines.get(i))
                // One line per page for the emulator check (book-measure.py).
                val name = nameOf(args.uri)
                Log.i(TAG, "margins $name ${w}x$h pass=band $bandLines")
                invoke.resolve(JSObject().put("lines", lines).put("width", w).put("height", h))
            } catch (e: Exception) {
                Log.e(TAG, "read margins failed", e)
                invoke.reject(e.message ?: "read failed", "OCR_FAILED")
            } finally {
                page?.recycle()
            }
        }
    }

    /** Recognise one region of the page (enlarged `up`×) into `out`, centres normalised to the page. */
    private fun recognizeRegion(
        page: Bitmap, x0: Int, y0: Int, rw: Int, rh: Int, up: Float, pass: String, out: JSArray,
    ) {
        val w = page.width
        val h = page.height
        val strip = Bitmap.createBitmap(page, x0, y0, rw, rh)
        val input = if (up > 1f) {
            Bitmap.createScaledBitmap(strip, (rw * up).toInt(), (rh * up).toInt(), true)
                .also { if (it !== strip) strip.recycle() }
        } else {
            strip
        }
        try {
            val text = Tasks.await(recognizer.process(InputImage.fromBitmap(input, 0)))
            for (block in text.textBlocks) {
                for (line in block.lines) {
                    val box = line.boundingBox ?: continue
                    out.put(
                        JSObject()
                            .put("text", line.text)
                            .put("conf", line.confidence.toDouble())
                            .put("cx", ((x0 + box.exactCenterX() / up) / w).toDouble())
                            .put("cy", ((y0 + box.exactCenterY() / up) / h).toDouble())
                            .put("h", (box.height() / up / h).toDouble())
                            .put("pass", pass),
                    )
                }
            }
        } finally {
            input.recycle()
        }
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

    private val recognizer by lazy {
        TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())
    }

    companion object {
        private const val TAG = "AstarScanMlkit"
        private const val MAX_OCR_SIDE = 4096
        private const val MAX_ATTEMPTS = 36
        private const val RETRY_MS = 5000L
    }
}
