/**
 * OCR text-fingerprint similarity — the same-page verifier for dense-text
 * pairs where every classical signal fails (measured: pHash / tile / ORB /
 * IoU / NCC all overlap between same-page and different-page pairs on
 * dense text; 3-gram Jaccard separates them at 0.249–0.329 vs 0.000–0.166).
 *
 * Inputs are OCR texts with whitespace already stripped by the caller.
 * The OCR engine itself is environment-specific (YomiToku subprocess in
 * the eval harness, NDLOCR-Lite Web Worker in the browser) — only the
 * judgment lives here.
 */

import {
  VERIFY_CONTAINMENT,
  VERIFY_CONTAINMENT_MAX_GAP_S,
  VERIFY_JACCARD,
} from './constants.js'

/** Texts shorter than this carry too few shingles to judge → abstain. */
export const VERIFY_MIN_TEXT_LENGTH = 30

export function shingles(s: string, n = 3): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i <= s.length - n; i += 1) set.add(s.slice(i, i + n))
  return set
}

export interface TextSimilarity {
  jaccard: number
  containment: number
}

export function textSimilarity(ta: string, tb: string): TextSimilarity {
  const A = shingles(ta)
  const B = shingles(tb)
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return {
    jaccard: inter / (A.size + B.size - inter || 1),
    containment: inter / (Math.min(A.size, B.size) || 1),
  }
}

export interface VerifySameTextOptions {
  jaccardThreshold?: number
  containmentThreshold?: number
  containmentMaxGapS?: number
  minTextLength?: number
}

/**
 * Same-page verdict from two OCR texts.
 *
 * Returns `null` (abstain) when either text is missing or too short for
 * 3-gram shingling. Containment rescues partial-coverage crops (a crop
 * showing only the page header has low Jaccard against the full page but
 * its shingles are CONTAINED in it) — headers repeat across pages of the
 * same manual, so containment is only trusted at near-zero time gaps.
 */
export function verifySameText(
  ta: string | null | undefined,
  tb: string | null | undefined,
  gapS: number = Infinity,
  opts: VerifySameTextOptions = {},
): { same: boolean; jaccard: number; containment: number } | null {
  const minLen = opts.minTextLength ?? VERIFY_MIN_TEXT_LENGTH
  if (ta == null || tb == null || ta.length < minLen || tb.length < minLen)
    return null
  const { jaccard, containment } = textSimilarity(ta, tb)
  const same =
    jaccard >= (opts.jaccardThreshold ?? VERIFY_JACCARD) ||
    (gapS <= (opts.containmentMaxGapS ?? VERIFY_CONTAINMENT_MAX_GAP_S) &&
      containment >= (opts.containmentThreshold ?? VERIFY_CONTAINMENT))
  return { same, jaccard, containment }
}
