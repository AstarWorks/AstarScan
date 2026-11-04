/**
 * Read a page's printed number ("ノンブル") from its top and bottom margins.
 *
 * Android app: ML Kit Text Recognition v2 on the device, on the full-size
 * scan (`readPageNumbersNative`). Web: the app's OCR (NDLOCR-Lite) on the
 * two margins stacked into one small image (`readPageNumbers`).
 */

import {
  pickPageNumbers,
  type PageNumberLine,
} from '@astarworks/scan-core/pipeline'
import { runOcr } from '~/services/ocr-service'
import { nativeReadMargins } from '~/services/native-scanner'

/** Share of the page height read at the top and at the bottom. */
const MARGIN_FRAC = 0.15

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

/** Printed page number(s) of one page: `[]` unread, two for a spread. */
export async function readPageNumbers(dataUrl: string): Promise<number[]> {
  const img = await loadImage(dataUrl)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const band = Math.max(1, Math.round(h * MARGIN_FRAC))

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = band * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.drawImage(img, 0, 0, w, band, 0, 0, w, band)
  ctx.drawImage(img, 0, h - band, w, band, 0, band, w, band)

  const result = await runOcr(canvas.toDataURL('image/jpeg', 0.9))
  const lines: PageNumberLine[] = result.lines.map((l) => {
    const [x, y, bw, bh] = l.bbox
    const cyComposite = y + bh / 2
    // Composite rows [0, band) are the page top; [band, 2·band) its bottom.
    const cyPage = cyComposite < band ? cyComposite : h - 2 * band + cyComposite
    return { text: l.text, cx: (x + bw / 2) / w, cy: cyPage / h }
  })
  return pickPageNumbers(lines, MARGIN_FRAC)
}

/**
 * Printed page number(s) of a page scanned in the Android app (`file://`
 * from the scanner, or a data URL of a restored page), read with ML Kit.
 */
export async function readPageNumbersNative(uri: string): Promise<number[]> {
  const lines = await nativeReadMargins(uri, MARGIN_FRAC)
  return pickNativePageNumbers(lines)
}

/**
 * The band pass first; the folio pass (each isolated piece of margin print
 * read enlarged) only when the band pass gives no number, so a folio
 * misread never replaces a number the band pass read (run 8: an extra
 * pass added one wrong number, and a wrong number makes a false 抜け row).
 */
export function pickNativePageNumbers(
  lines: readonly (PageNumberLine & { readonly pass?: string })[],
): number[] {
  const band = pickPageNumbers(
    lines.filter((l) => (l.pass ?? 'band') === 'band'),
    MARGIN_FRAC,
  )
  if (band.length > 0) return band
  return pickPageNumbers(
    lines.filter((l) => l.pass === 'folio'),
    MARGIN_FRAC,
  )
}
