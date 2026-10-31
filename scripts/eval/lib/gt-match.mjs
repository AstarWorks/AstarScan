/**
 * Page-identity ground-truth matching for the eval harness.
 *
 * A GT manifest (test/fixtures/gt/<video-id>/manifest.json) lists the
 * distinct physical page faces in a video, each with a reference image
 * and the time range during which the face is on screen. This module
 * assigns each pipeline winner to a GT page and computes identity-aware
 * metrics that count-based recall/precision cannot express:
 *
 *   - perPageRecall: |GT pages with ≥1 winner| / |GT pages|  (optional
 *     pages excluded from the denominator)
 *   - duplicateRate: winners assigned to an already-claimed page / winners
 *   - falsePositiveRate: winners matching no GT page / winners
 *   - mergeErrors: winners visually matching ≥2 distinct GT pages
 *     (a sign two faces were merged into one crop/cluster)
 *
 * Matching is temporal-first: GT time ranges were curated independently
 * (filmstrip review of the raw video), so containment of the winner's
 * timestamp is authoritative and immune to the perceptual-hash/ORB
 * signals the dedup pipeline itself is tuned on. ORB inliers against the
 * reference images are computed as a cross-check and as fallback for
 * winners outside every range; disagreements are flagged for review,
 * never silently resolved.
 */

import path from 'node:path'
import fs from 'node:fs/promises'

import {
  computeOrbDescriptors,
  countOrbMatches,
  computeTilePHash,
  tileDistance,
} from '../pipeline.mjs'
import { jpegToCanvas } from '../canvas-utils.mjs'

/** ORB inliers at or above this = confident visual match. */
const VISUAL_MATCH_INLIERS = 30
/** ORB inliers at or above this against a 2nd page = merge-error signal. */
const MERGE_ERROR_INLIERS = 50
/** Tile-pHash distance at or below this also counts as a visual match. */
const VISUAL_MATCH_TILE_DIST = 18

/**
 * Resolve a --gt-map argument (manifest path or its directory) or the
 * default location for a video. Returns null when nothing exists.
 */
export async function resolveGtManifest({ gtMapArg, repoRoot, mp4Path }) {
  const candidates = []
  if (gtMapArg) {
    candidates.push(
      gtMapArg.endsWith('.json')
        ? gtMapArg
        : path.join(gtMapArg, 'manifest.json'),
    )
  } else {
    const base = path.basename(mp4Path, path.extname(mp4Path))
    candidates.push(
      path.join(repoRoot, 'test/fixtures/gt', base, 'manifest.json'),
    )
  }
  for (const p of candidates) {
    try {
      await fs.access(p)
      return path.resolve(p)
    } catch {
      /* try next */
    }
  }
  if (gtMapArg) {
    throw new Error(
      `--gt-map: manifest not found at ${candidates.join(' or ')}`,
    )
  }
  return null
}

async function loadRefFeatures(manifest, gtDir) {
  const refs = []
  for (const page of manifest.pages) {
    const canvas = await jpegToCanvas(path.join(gtDir, page.ref))
    refs.push({
      page,
      tileHash: computeTilePHash(canvas),
      orb: computeOrbDescriptors(canvas),
    })
  }
  return refs
}

function freeRefFeatures(refs) {
  for (const r of refs) r.orb?.descriptors?.delete()
}

function inRange(t, range) {
  return Array.isArray(range) && t >= range[0] && t <= range[1]
}

/**
 * Match winners against a GT manifest.
 *
 * @param {object} opts
 * @param {string} opts.manifestPath  absolute path to manifest.json
 * @param {Array<{idx:number, t_s:number, jpegPath:string}>} opts.winners
 * @returns {{assignments: Array, metrics: object}}
 */
export async function matchWinnersToGt({ manifestPath, winners }) {
  const gtDir = path.dirname(manifestPath)
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const refs = await loadRefFeatures(manifest, gtDir)

  const assignments = []
  try {
    for (const w of winners) {
      const canvas = await jpegToCanvas(w.jpegPath)
      const tileHash = computeTilePHash(canvas)
      const orb = computeOrbDescriptors(canvas)

      const visual = refs.map((r) => {
        const { inliers, gridCoverage } = countOrbMatches(orb, r.orb)
        return {
          pageId: r.page.id,
          inliers,
          gridCoverage,
          tileDist: Number(tileDistance(tileHash, r.tileHash)),
        }
      })
      orb?.descriptors?.delete()

      visual.sort((a, b) => b.inliers - a.inliers)
      const temporal = refs
        .filter((r) => inRange(w.t_s, r.page.timeRangeS))
        .map((r) => r.page.id)
      const bestVisual = visual[0]
      const visualOk = (v) =>
        v &&
        (v.inliers >= VISUAL_MATCH_INLIERS ||
          v.tileDist <= VISUAL_MATCH_TILE_DIST)

      let pageId = null
      let method = null
      let flag = null
      if (temporal.length === 1) {
        pageId = temporal[0]
        method = 'temporal'
        if (visualOk(bestVisual) && bestVisual.pageId !== pageId) {
          flag = `visual-disagrees:${bestVisual.pageId}(orb=${bestVisual.inliers})`
        }
      } else if (temporal.length > 1) {
        // Overlapping ranges shouldn't happen with curated GT; pick the
        // visually closest of the temporal candidates and flag it.
        const amongTemporal = visual.filter((v) => temporal.includes(v.pageId))
        pageId = (amongTemporal[0] ?? bestVisual).pageId
        method = 'temporal-ambiguous'
        flag = `ranges-overlap:${temporal.join('+')}`
      } else if (visualOk(bestVisual)) {
        pageId = bestVisual.pageId
        method = 'visual'
      }

      // Merge-error signal: strong visual match against 2+ distinct pages.
      const strong = visual.filter((v) => v.inliers >= MERGE_ERROR_INLIERS)
      const mergeSuspect = strong.length >= 2

      assignments.push({
        idx: w.idx,
        t_s: w.t_s,
        pageId,
        method,
        flag,
        mergeSuspect,
        visualTop: visual.slice(0, 3),
      })
    }
  } finally {
    freeRefFeatures(refs)
  }

  return { assignments, metrics: computeGtMetrics(manifest, assignments) }
}

export function computeGtMetrics(manifest, assignments) {
  const realPages = manifest.pages.filter((p) => !p.optional)
  const matched = new Set(
    assignments.filter((a) => a.pageId).map((a) => a.pageId),
  )
  const matchedReal = realPages.filter((p) => matched.has(p.id))
  const missedPages = realPages
    .filter((p) => !matched.has(p.id))
    .map((p) => p.id)

  const claimCounts = new Map()
  let duplicates = 0
  for (const a of assignments) {
    if (!a.pageId) continue
    const n = (claimCounts.get(a.pageId) ?? 0) + 1
    claimCounts.set(a.pageId, n)
    if (n > 1) duplicates += 1
  }
  const falsePositives = assignments.filter((a) => !a.pageId).length
  const mergeErrors = assignments.filter((a) => a.mergeSuspect).length
  const total = assignments.length

  return {
    gtPages: realPages.length,
    gtOptionalPages: manifest.pages.length - realPages.length,
    winners: total,
    matchedPages: matchedReal.length,
    perPageRecall: realPages.length
      ? +(matchedReal.length / realPages.length).toFixed(3)
      : null,
    missedPages,
    duplicates,
    duplicateRate: total ? +(duplicates / total).toFixed(3) : 0,
    falsePositives,
    falsePositiveRate: total ? +(falsePositives / total).toFixed(3) : 0,
    mergeErrors,
    flags: assignments
      .filter((a) => a.flag)
      .map((a) => ({ idx: a.idx, flag: a.flag })),
  }
}
