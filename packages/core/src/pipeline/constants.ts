/**
 * Shared pipeline constants — single source of truth for the eval harness
 * (scripts/eval) and the production browser app (apps/web).
 *
 * Every threshold here was tuned empirically against the two GT eval videos
 * and is frozen by `bun scripts/eval/regress.mjs` (test/baselines/). Do not
 * change values without re-running the regression gate.
 */

/** Warped page output size (portrait A-series aspect). */
export const EXTRACT_W = 1200
export const EXTRACT_H = 1600

/** 16×16 = 256-bit average hash. 8×8 (classical pHash size) is too coarse
 *  for multi-page text documents — pages with different words but similar
 *  layout alias to nearly-identical 64-bit hashes. */
export const HASH_SIZE = 16

/** Tile-pHash grid: 4×4 = 16 tiles, each hashed at 8×8 = 64 bits.
 *  Distance is compared per-tile (80th percentile) so a single perturbed
 *  region (a hand on a corner) only blows up 1-2 tile distances. */
export const TILE_GRID = 4
export const TILE_HASH_SIZE = 8
export const TILE_BITS = TILE_HASH_SIZE * TILE_HASH_SIZE

/** OpenCV Otsu fallback detection. */
export const MORPH_KERNEL = 15
export const MIN_FRAME_FRACTION = 0.15
export const MAX_FRAME_FRACTION = 0.97

/** ORB runs on the top 60 % of the page: multi-page documents repeat
 *  boilerplate at the bottom (multilingual notices, footers) which RANSAC
 *  happily validates as a planar match across different pages. */
export const ORB_CROP_TOP_FRAC = 0.6
/** 4×4 grid for inlier spatial coverage (anti-boilerplate signal). */
export const ORB_GRID = 4
/** BFMatcher descriptor-distance cutoff for "good" matches. */
export const ORB_MAX_DESC_DIST = 35
/** Max ORB keypoints per image. */
export const ORB_MAX_FEATURES = 500

/** Composite frame score weights + normalizers. Normalization is tuned to
 *  ACTUAL handheld-footage ranges (Laplacian ~10-90, Tenengrad ~30-50 on
 *  warped pages); over-large normalizers crush the sharpness terms so
 *  area+confidence decide and blurry frames win (measured bug, 2026-06). */
export const SCORE_LAP_NORM = 120
export const SCORE_TEN_NORM = 60
export const SCORE_W_LAP = 0.45
export const SCORE_W_TEN = 0.35
export const SCORE_W_AREA = 0.1
export const SCORE_W_CONF = 0.1

/**
 * Segment-first clustering knobs. Defaults reflect the measured
 * distributions on the eval videos (frame indices assume 10 fps sampling).
 */
export const SEGMENT_DEFAULTS = {
  /** >1 s of rejected frames = page turn (10 fps sampling). */
  maxGapFrames: 10,
  /** Accepted-frame gap in [this, maxGapFrames] → verify boundary. */
  cutGapFrames: 5,
  /** ORB below this at a suspicious boundary → cut. */
  cutOrbInliers: 25,
  /** Segment gap ≤ this (seconds) counts as temporally adjacent. */
  adjacentGapS: 3,
  /** Inlier floor for adjacent merges. */
  orbAdjacent: 25,
  /** Inlier floor for distant merges. */
  orbDistant: 50,
  /** Inlier grid coverage floor for ALL merges (anti-boilerplate). */
  minGrid: 8,
  /** Tile distance ≤ this merges unconditionally. */
  tileLo: 18,
  /** Inter-segment gap > this (2.5 s) → rescue scan. */
  rescueMinGapFrames: 25,
} as const

export type SegmentOptions = {
  -readonly [K in keyof typeof SEGMENT_DEFAULTS]: number
}

/** Non-max-suppression radius for the gap-rescue pass (0.8 s at 10 fps):
 *  a rescued frame claims its neighborhood so recursion can't shave the
 *  same hold frame-by-frame. */
export const RESCUE_NMS_FRAMES = 8

/** Candidate floors for the gap-rescue pass. Measured on labeled rescues:
 *  every TRUE rescue had conf ≥ 0.52 and areaFrac ≥ 0.12; floors sit below
 *  with margin. Laplacian is NOT usable — the Lean Startup cover was
 *  rescued at lap = 2. */
export const RESCUE_MIN_TENENGRAD = 10
export const RESCUE_MIN_CONFIDENCE = 0.4
export const RESCUE_MIN_AREA_FRAC = 0.08

/** OCR text-fingerprint verifier: 3-gram Jaccard ≥ this → same page
 *  (measured same-page 0.249–0.329 vs different-page 0.000–0.166). */
export const VERIFY_JACCARD = 0.2
/** Containment ratio ≥ this (at small time gaps) rescues partial-coverage
 *  crops whose Jaccard is diluted by the missing region. */
export const VERIFY_CONTAINMENT = 0.5
/** Containment shortcut only applies at time gaps ≤ this (seconds). */
export const VERIFY_CONTAINMENT_MAX_GAP_S = 1.5
