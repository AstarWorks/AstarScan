package com.astarworks.mlkitscanner

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import java.nio.FloatBuffer
import kotlin.math.max
import kotlin.math.min

/**
 * Page corners with DocAligner (DocsaidLab, Apache-2.0; lcnet100 heatmap
 * model, 4.8 MB, `assets/docaligner-lcnet100.onnx`, fetched at build time by
 * scripts/android/fetch-docaligner.sh), on ONNX Runtime on the device.
 *
 * Chosen over OpenCV contours and a paper-colour mask by measuring all
 * three on the book clips (scripts/eval/book-clips/corner-compare.py): the
 * contour finder breaks on thumbs and on a white desk, the mask on a white
 * desk; DocAligner frames every clip.
 *
 * Same steps as corner-compare.py DocAligner: the image is padded to a
 * square (black), scaled to 256×256, BGR / 255; each corner is the
 * arg-max of its 128×128 heatmap, refined to the weighted centroid of the
 * 5×5 cells around it. `peaks` says how sure the model is of each corner.
 */
class CaptureDetector(context: Context) : AutoCloseable {
    class Result(val quad: Quad, val peaks: FloatArray) {
        val minPeak: Float get() = peaks.minOrNull() ?: 0f
    }

    private val env = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val inputName: String
    private val input = FloatArray(3 * SIZE * SIZE)
    private val square = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
    private val px = IntArray(SIZE * SIZE)
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)

    init {
        val bytes = context.assets.open(MODEL).use { it.readBytes() }
        val opts = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(2)
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        }
        session = env.createSession(bytes, opts)
        inputName = session.inputNames.first()
    }

    /** Corners of the document in `img` (its pixels), or null when the model gives nothing. */
    @Synchronized
    fun detect(img: Bitmap): Result? {
        val w = img.width
        val h = img.height
        val s = max(w, h)
        val scale = SIZE.toFloat() / s
        val ox = (s - w) / 2f
        val oy = (s - h) / 2f
        val canvas = Canvas(square)
        canvas.drawColor(Color.BLACK)
        val m = Matrix().apply {
            postTranslate(ox, oy)
            postScale(scale, scale)
        }
        canvas.drawBitmap(img, m, paint)
        square.getPixels(px, 0, SIZE, 0, 0, SIZE, SIZE)
        val plane = SIZE * SIZE
        for (i in 0 until plane) {
            val c = px[i]
            input[i] = (c and 0xff) / 255f // B
            input[plane + i] = (c shr 8 and 0xff) / 255f // G
            input[2 * plane + i] = (c shr 16 and 0xff) / 255f // R
        }
        val tensor = OnnxTensor.createTensor(env, FloatBuffer.wrap(input), longArrayOf(1, 3, SIZE.toLong(), SIZE.toLong()))
        tensor.use { t ->
            session.run(mapOf(inputName to t)).use { r ->
                val out = r[0] as OnnxTensor
                val shape = out.info.shape // 1, 4, gh, gw
                val gh = shape[2].toInt()
                val gw = shape[3].toInt()
                val buf = out.floatBuffer
                val hm = FloatArray(buf.remaining())
                buf.get(hm)
                val xs = FloatArray(4)
                val ys = FloatArray(4)
                val peaks = FloatArray(4)
                for (k in 0 until 4) {
                    val off = k * gh * gw
                    var best = off
                    for (i in off until off + gh * gw) if (hm[i] > hm[best]) best = i
                    val by = (best - off) / gw
                    val bx = (best - off) % gw
                    peaks[k] = hm[best]
                    var sw = 0.0
                    var sx = 0.0
                    var sy = 0.0
                    for (yy in max(0, by - 2)..min(gh - 1, by + 2)) {
                        for (xx in max(0, bx - 2)..min(gw - 1, bx + 2)) {
                            val v = max(0f, hm[off + yy * gw + xx]).toDouble()
                            sw += v
                            sx += v * xx
                            sy += v * yy
                        }
                    }
                    val cx = if (sw > 1e-6) sx / sw else bx.toDouble()
                    val cy = if (sw > 1e-6) sy / sw else by.toDouble()
                    xs[k] = ((cx + 0.5) * s / gw - ox).toFloat()
                    ys[k] = ((cy + 0.5) * s / gh - oy).toFloat()
                }
                return Result(Quad.ordered(xs, ys), peaks)
            }
        }
    }

    override fun close() {
        session.close()
        square.recycle()
    }

    companion object {
        const val MODEL = "docaligner-lcnet100.onnx"
        const val SIZE = 256
        /** A corner the model is less sure of than this is not taken (corner-compare.py MIN_PEAK). */
        const val MIN_PEAK = 0.3f
    }
}
