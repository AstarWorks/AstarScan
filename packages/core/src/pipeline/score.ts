/**
 * Composite frame-quality score: sharpness-dominant ranking of accepted
 * frames within a page hold. See constants.ts for the tuning rationale.
 */

import {
  SCORE_LAP_NORM,
  SCORE_TEN_NORM,
  SCORE_W_AREA,
  SCORE_W_CONF,
  SCORE_W_LAP,
  SCORE_W_TEN,
} from './constants.js'

export function combinedScore(
  laplacian: number,
  tenengrad: number,
  confidence: number,
  areaFrac: number,
): number {
  const normLap = Math.min(1, laplacian / SCORE_LAP_NORM)
  const normTen = Math.min(1, tenengrad / SCORE_TEN_NORM)
  return (
    SCORE_W_LAP * normLap +
    SCORE_W_TEN * normTen +
    SCORE_W_AREA * areaFrac +
    SCORE_W_CONF * confidence
  )
}
