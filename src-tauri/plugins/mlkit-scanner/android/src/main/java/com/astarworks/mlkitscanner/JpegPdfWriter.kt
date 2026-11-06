package com.astarworks.mlkitscanner

import java.io.OutputStream

/**
 * Minimal PDF writer that embeds JPEGs as-is (DCTDecode): no re-encoding,
 * so the PDF keeps the scanner's quality and stays the size of the JPEGs.
 * Android's PdfDocument would re-encode every page losslessly (huge files).
 * Each page is A4 wide (595.28 pt) with the image's aspect ratio.
 */
object JpegPdfWriter {
    private class Jpeg(val width: Int, val height: Int, val components: Int)

    private class Counting(private val out: OutputStream) {
        var offset = 0L
            private set

        fun write(bytes: ByteArray) {
            out.write(bytes)
            offset += bytes.size
        }

        fun write(s: String) = write(s.toByteArray(Charsets.ISO_8859_1))
    }

    fun write(out: OutputStream, pages: List<() -> ByteArray>) {
        val w = Counting(out)
        val pageCount = pages.size
        val objCount = 2 + pageCount * 3
        val offsets = LongArray(objCount + 1)

        w.write("%PDF-1.4\n%âãÏÓ\n")
        offsets[1] = w.offset
        w.write("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        offsets[2] = w.offset
        val kids = (0 until pageCount).joinToString(" ") { "${3 + it * 3} 0 R" }
        w.write("2 0 obj\n<< /Type /Pages /Kids [$kids] /Count $pageCount >>\nendobj\n")

        pages.forEachIndexed { i, load ->
            val bytes = load()
            val info = parse(bytes)
            val pageObj = 3 + i * 3
            val imgObj = pageObj + 1
            val contentObj = pageObj + 2
            val pw = 595.28
            val ph = pw * info.height / info.width
            val pwS = "%.2f".format(java.util.Locale.ROOT, pw)
            val phS = "%.2f".format(java.util.Locale.ROOT, ph)

            offsets[pageObj] = w.offset
            w.write(
                "$pageObj 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 $pwS $phS] " +
                    "/Resources << /XObject << /Im0 $imgObj 0 R >> >> /Contents $contentObj 0 R >>\nendobj\n",
            )

            val colorSpace = when (info.components) {
                1 -> "/DeviceGray"
                4 -> "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]"
                else -> "/DeviceRGB"
            }
            offsets[imgObj] = w.offset
            w.write(
                "$imgObj 0 obj\n<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} " +
                    "/ColorSpace $colorSpace /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.size} >>\nstream\n",
            )
            w.write(bytes)
            w.write("\nendstream\nendobj\n")

            val content = "q $pwS 0 0 $phS 0 0 cm /Im0 Do Q\n"
            offsets[contentObj] = w.offset
            w.write("$contentObj 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n")
        }

        val xref = w.offset
        val sb = StringBuilder("xref\n0 ${objCount + 1}\n0000000000 65535 f \n")
        for (n in 1..objCount) sb.append("%010d 00000 n \n".format(java.util.Locale.ROOT, offsets[n]))
        sb.append("trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF\n")
        w.write(sb.toString())
        out.flush()
    }

    /** Read width / height / component count from the JPEG's SOF segment. */
    private fun parse(b: ByteArray): Jpeg {
        require(b.size > 4 && b[0] == 0xFF.toByte() && b[1] == 0xD8.toByte()) { "not a JPEG" }
        var i = 2
        while (i + 9 < b.size) {
            if (b[i] != 0xFF.toByte()) {
                i++
                continue
            }
            val marker = b[i + 1].toInt() and 0xFF
            if (marker == 0xFF) {
                i++
                continue
            }
            if (marker == 0xD8 || marker == 0x01 || marker in 0xD0..0xD7) {
                i += 2
                continue
            }
            val len = ((b[i + 2].toInt() and 0xFF) shl 8) or (b[i + 3].toInt() and 0xFF)
            val isSof = marker in 0xC0..0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            if (isSof) {
                val h = ((b[i + 5].toInt() and 0xFF) shl 8) or (b[i + 6].toInt() and 0xFF)
                val w = ((b[i + 7].toInt() and 0xFF) shl 8) or (b[i + 8].toInt() and 0xFF)
                val c = b[i + 9].toInt() and 0xFF
                return Jpeg(w, h, c)
            }
            i += 2 + len
        }
        throw IllegalArgumentException("JPEG has no SOF segment")
    }
}
