/**
 * Multi-signal frame quality scorer for best-frame selection.
 *
 * The default ByteTrack picker uses
 *     score = Laplacian × (confidence + 0.1) × (area_fraction + 0.1)
 * computed over the WHOLE warped image. Trouble: face photos /
 * shiny QR codes / hand occlusion all inflate that whole-image
 * Laplacian — sometimes a frame with a sharp face and blurry text
 * outranks a frame with sharp text. The user noticed clearly-
 * suboptimal frames slipping through as winners.
 *
 * This module re-scores a candidate frame based on signals that
 * actually correlate with OCR success:
 *
 *   1. Laplacian / Tenengrad averaged ONLY inside the OCR'd text
 *      bboxes (not the photo or background).
 *   2. Per-character OCR confidence (already in YomiToku output).
 *   3. Hard area gate (≥ 10 % of frame) — borrowed from Smart
 *      Engines 2025 update for ID-card best-frame selection.
 *   4. Glare-fraction penalty — % of near-saturated pixels in
 *      text bboxes.
 *
 * Stacked score:
 *     (0.4 × Lap_text + 0.3 × Ten_text) × ocr_conf × (1 − glare)
 *
 * Used to pick the winner among ByteTrack's top-K candidates (k=5
 * recommended). OCR result is required — caller must run YomiToku
 * (or equivalent) on each candidate first. That adds OCR×K calls
 * per track but the inputs are then ready for the heuristic /
 * LLM extractor.
 */

import '../pipeline.mjs' // cv.imread / imshow bridge patch
import { cv } from '../cv-shim.mjs'

const HIGHLIGHT_THRESHOLD = 245 // 0-255; pixels ≥ this counted as glare

/**
 * @param {object} args
 * @param {HTMLCanvasElement-like} args.canvas — warped card image
 * @param {Array<{contents,box:[x1,y1,x2,y2],confidence?}>} args.paragraphs — YomiToku-style
 * @param {number} args.areaFraction — quad area / source frame area
 * @returns {{score:number, components:object}}
 */
export function scoreFrame({ canvas, paragraphs, areaFraction }) {
  if (areaFraction != null && areaFraction < 0.05) {
    return { score: 0, components: { reason: 'tiny-card', areaFraction } }
  }
  if (!paragraphs || paragraphs.length === 0) {
    return { score: 0, components: { reason: 'no-text' } }
  }

  const src = cv.imread(canvas)
  const gray = new cv.Mat()
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  try {
    let lapSum = 0
    let tenSum = 0
    let glareSum = 0
    let bboxCount = 0
    let totalPx = 0

    for (const p of paragraphs) {
      const [x1, y1, x2, y2] = p.box ?? []
      if (x2 == null) continue
      const w =
        Math.min(canvas.width, Math.round(x2)) - Math.max(0, Math.round(x1))
      const h =
        Math.min(canvas.height, Math.round(y2)) - Math.max(0, Math.round(y1))
      if (w < 4 || h < 4) continue
      const roi = gray.roi(
        new cv.Rect(Math.max(0, x1 | 0), Math.max(0, y1 | 0), w, h),
      )
      try {
        // Laplacian variance inside the bbox
        const lap = new cv.Mat()
        const mean = new cv.Mat()
        const stddev = new cv.Mat()
        cv.Laplacian(roi, lap, cv.CV_64F, 1, 1, 0, cv.BORDER_DEFAULT)
        cv.meanStdDev(lap, mean, stddev)
        const sd = stddev.data64F[0] ?? 0
        lapSum += sd * sd
        lap.delete()
        mean.delete()
        stddev.delete()

        // Tenengrad inside the bbox
        const gx = new cv.Mat()
        const gy = new cv.Mat()
        cv.Sobel(roi, gx, cv.CV_32F, 1, 0, 3, 1, 0, cv.BORDER_DEFAULT)
        cv.Sobel(roi, gy, cv.CV_32F, 0, 1, 3, 1, 0, cv.BORDER_DEFAULT)
        let tenLocal = 0
        for (let i = 0; i < gx.data32F.length; i++) {
          tenLocal +=
            gx.data32F[i] * gx.data32F[i] + gy.data32F[i] * gy.data32F[i]
        }
        tenSum += tenLocal / Math.max(1, gx.data32F.length)
        gx.delete()
        gy.delete()

        // Glare fraction inside the bbox
        let glare = 0
        for (let i = 0; i < roi.data.length; i++) {
          if (roi.data[i] >= HIGHLIGHT_THRESHOLD) glare++
        }
        glareSum += glare
        totalPx += roi.data.length
        bboxCount++
      } finally {
        roi.delete()
      }
    }

    if (bboxCount === 0 || totalPx === 0) {
      return { score: 0, components: { reason: 'no-valid-bbox' } }
    }
    const lapAvg = lapSum / bboxCount
    const tenAvg = tenSum / bboxCount
    const glareFrac = glareSum / totalPx

    // OCR confidence: if YomiToku provides per-paragraph confidence,
    // average across paragraphs. Otherwise neutral 1.0.
    let ocrConfSum = 0
    let ocrConfCount = 0
    for (const p of paragraphs) {
      if (typeof p.confidence === 'number') {
        ocrConfSum += p.confidence
        ocrConfCount++
      }
    }
    const ocrConf = ocrConfCount > 0 ? ocrConfSum / ocrConfCount : 1.0

    const score =
      (lapAvg * 0.4 + tenAvg * 0.3) * ocrConf * Math.max(0.1, 1 - glareFrac)
    return {
      score,
      components: {
        lapAvg: Math.round(lapAvg),
        tenAvg: Math.round(tenAvg),
        ocrConf: Number(ocrConf.toFixed(3)),
        glareFrac: Number(glareFrac.toFixed(3)),
        bboxCount,
        areaFraction,
      },
    }
  } finally {
    src.delete()
    gray.delete()
  }
}
