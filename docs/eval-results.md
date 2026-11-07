# Video-scan dedup evaluation (May 2026)

Empirical iteration on the AstarScan handheld page-extraction pipeline.
Measured against the two repo-bundled mp4s with ground truth supplied
verbally by the user (~10–11 unique pages each); subsequent visual
inspection of the pHash baseline winners suggested the true unique-page
counts are closer to ~9 per video, with the user's count likely
overcounting near-duplicate captures of the same physical page.

The eval harness is at `scripts/eval/`; run with:

```bash
bun scripts/eval/run.mjs <mp4> --gt N \
    [--algorithm phash|tile|tile-orb] \
    [--cluster-thr N] [--orb-merge N] \
    [--sweep cluster-thr 30:80:5]
```

Outputs land in `eval-out/<basename>/` with per-frame trace,
per-cluster jsonl, winner JPEGs, sweep CSV, and a single-file
`summary.html` viewer.

## Test data

| File                  | Length | Frames @ 0.1 s | Content                                                              |
| --------------------- | ------ | -------------- | -------------------------------------------------------------------- |
| `20260412_204840.mp4` | ~43 s  | 431            | Ergotron monitor-arm manual (multilingual notice repeats every page) |
| `20260412_212448.mp4` | ~66 s  | 663            | Yellow book cover at angles + dental receipt + product packaging     |

Both are handheld phone footage, ~30 fps native, with the user holding
each page for several seconds and turning between pages. The Ergotron
manual has heavy bottom-page boilerplate (multilingual safety text,
warning icons) that complicates feature-based dedup.

## Baselines

### Production (pre-change): pHash centroid clustering at `CLUSTER_THRESHOLD = 55`

| File  | Detected  | Winners | Notes                                                                   |
| ----- | --------- | ------- | ----------------------------------------------------------------------- |
| mp4-1 | 422 / 431 | 11      | 2 known dup pairs in winners (e.g. page 9, page 15 both captured twice) |
| mp4-2 | 641 / 663 | 24      | Book cover splits into 6 clusters at varying angles                     |

### Threshold sweep (pHash only)

mp4-1 sweet spot at thr 55–60 (winners 9–11). mp4-2 sweet spot at thr 80
(winners 10). **No single threshold satisfies both** — the same-page vs
different-page distance distributions overlap.

## Algorithm changes

### 1. Tile-pHash (4×4 grid, 64-bit per tile, 80th-percentile distance)

`apps/web/app/services/phash-dedup.ts:computeTilePHash` /
`tileDistance`. A hand occluding one corner only blows up 1–2 tile
hashes; the 80th percentile reflects "how well do the well-aligned
tiles match" while ignoring outliers. Same physical page typically 5–20
in this metric, distinct pages 28+. Bandwidth-equivalent to 256-bit
pHash (also 16 numbers per page); zero new dependencies.

### 2. ORB + RANSAC post-hoc merger

`apps/web/app/services/orb-merge.ts`. Tile-pHash is set
recall-oriented (`CLUSTER_THRESHOLD = 27`) so legitimate
same-page-at-angle captures (tile distance 28–35) over-split. The
merger then groups cluster pairs whose winners share ≥
`ORB_MERGE_INLIERS = 25` RANSAC-validated ORB inlier matches.
ORB is computed on the **top 60 %** of the warped page to skip
multilingual boilerplate; without that, RANSAC happily validates the
boilerplate region as a planar match across visually different pages.

### 3. OpenCV.js build swap

The previous `apps/web/public/opencv.js` (docs.opencv.org build, ~7.6
MB) lacks ORB/BFMatcher/findHomography. Swapped with
`@techstark/opencv-js`'s build (10.4 MB, +2.8 MB raw / +~700 KB gzip,
PWA-cached after first load). Same upstream OpenCV codebase, same
detection / warp behavior; only difference is feature-detector APIs are
compiled in.

## Final results

`tile-pHash CLUSTER_THRESHOLD=27 + ORB_MERGE_INLIERS=25` (no spatial
grid filter):

| File  | Baseline winners   | New winners               | Harness | Browser |
| ----- | ------------------ | ------------------------- | ------- | ------- |
| mp4-1 | 11 (2 dup pairs)   | 7 (harness) / 6 (browser) | 7       | 6       |
| mp4-2 | 24 (book cover ×6) | 12                        | 12      | 12      |

mp4-2 sees the dramatic improvement (24 → 12, half the false splits
gone). mp4-1 drops 11 → 6/7 — 2 are legitimate dup-pair merges, the
remaining 1–2 are false merges from boilerplate that the top-60% crop
doesn't fully eliminate. Recall 70 % on mp4-1, 100 % on mp4-2 (using
`min(1, winners / gt)` as a proxy).

## Why we didn't push harder

A spatial-distribution gate (4×4 grid coverage of inliers) cleanly
separates Ergotron false merges (grid coverage 5–7) from genuine
same-page merges in that footage (grid 9–10):

| Pair                          | Type            | ORB inliers | Grid cells |
| ----------------------------- | --------------- | ----------- | ---------- |
| mp4-1 same-page (page 9 dup)  | true merge      | 70          | 9          |
| mp4-1 same-page (page 15 dup) | true merge      | 69          | 10         |
| mp4-1 diff-page boilerplate   | **false** merge | 67          | 7          |
| mp4-1 diff-page boilerplate   | **false** merge | 75          | 5          |

But the same gate at `min-grid ≥ 8` blocks book-cover-at-angle merges
in mp4-2:

| Pair                  | Type       | ORB inliers | Grid cells      |
| --------------------- | ---------- | ----------- | --------------- |
| mp4-2 same book cover | true merge | 50          | 10              |
| mp4-2 same book cover | true merge | 52          | 7 ← blocked     |
| mp4-2 same book cover | true merge | 36          | 8               |
| mp4-2 same book cover | true merge | 33          | **4** ← blocked |

The empirical ranges overlap. A per-video parameter set works (mp4-1
likes `min-grid ≥ 8`, mp4-2 likes no grid filter), but production can't
know in advance which footage type the user is scanning. The current
choice prioritizes mp4-2-style content (book covers, photos —
"recall-oriented") because the alternative (mp4-1-style precision-
oriented) silently drops user pages with no UI affordance for recovery.

## Stability check (Phase 4 falsification)

±20 % on `cluster-thr` (22 → 32):

| thr | mp4-1 winners | mp4-1 abs_err | mp4-2 winners | mp4-2 abs_err |
| --- | ------------- | ------------- | ------------- | ------------- |
| 22  | 9             | 1             | 15            | 5             |
| 27  | **7**         | **3**         | **12**        | **2**         |
| 32  | 3             | 7             | 8             | 2             |

`thr=27` is the local minimum of total absolute error and the only
value where mp4-2 keeps abs_err ≤ 2. The pipeline is stable within
±20 % in the sense that result counts move smoothly (no cliff
collapse), but the recall-on-mp4-1 vs precision-on-mp4-2 trade-off is
intrinsic to the signal — see "Why we didn't push harder".

## Future work

The pHash family has hit its discrimination limit on this data.
Real improvement requires either:

1. **CLIP / SigLIP image embeddings** for content-level similarity
   (likely 50–100 MB extra ONNX, ~100 ms / inference). Would replace
   the tile-pHash + ORB pipeline entirely.
2. **Header / footer mask learned from user's document type** to
   exclude boilerplate before ORB extraction. Modest improvement
   on the Ergotron case, no effect on book covers.
3. **UI affordance for split / merge** so users can correct
   over-merge / over-split in one tap, since neither algorithm choice
   is dominant.

Path (3) is the cheapest and pairs naturally with whichever algorithm
ships. Path (1) is the next algorithm push if (3) proves insufficient.

---

# 2026-06-12 — Identity GT, signal falsification, segment-first pivot

## Page-identity ground truth replaces count-based metrics

`test/fixtures/gt/<video-id>/manifest.json` + reference crops now define
the distinct physical page faces per eval video (curated by dense
filmstrip review of the raw footage). `run.mjs` auto-discovers them and
emits identity metrics (`gtIdentity` in summary.json): per-page recall,
duplicate rate, false-positive rate, merge suspects, missed page list.
Matching is temporal-first (GT time ranges are independent of every
pipeline signal), ORB as cross-check/fallback.

**The count-based metrics were lying.** The "recall 1.0" YOLO runs:

| run                   | count-based            | identity recall | duplicates | missed          |
| --------------------- | ---------------------- | --------------- | ---------- | --------------- |
| mp4-1 yolo tile-orb   | recall 1.0 / prec 0.69 | **0.64** (7/11) | 7/14       | g02 g05 g11 g12 |
| mp4-2 yolo tile-orb   | recall 1.0 / prec 0.65 | **0.78** (7/9)  | 9/16       | h02 h08         |
| mp4-1 opencv tile-orb | recall 0.64 / prec 1.0 | **0.36** (4/11) | 1/5        | 7 pages         |

Duplicates were inflating the winner count past GT, masking that ~4
pages per video were never captured at all. mp4-2's true face count is
9, not 11 (the old verbal GT overcounted).

## Root cause of the missed pages: content-biased blur gate

Every missed page was REJECTED by `MIN_TENENGRAD=30` while detection
succeeded (conf 0.67–0.77). They are sharp but illustration-heavy /
low-texture (tilt-step diagrams, person-at-desk art, Lean Startup
cover): Tenengrad measures gradient density = texture amount, not
blur. A fixed threshold tuned on dense text necessarily drops sparse
pages. Fix direction: relative (per-segment) quality gating — keep a
segment's best frame regardless of the absolute gate.

## Same-page verification: classical signals are dead (measured)

On YOLO crops of the Ergotron manual, EVERY classical signal fails to
separate same-page from different-page pairs (full numbers in
`memory: dedup-signal-falsification`):

- consecutive pHash (median 49 same-page; jitter = real hand motion +
  detection interpretation flips, corner displacement median 24 px per
  100 ms — EMA smoothing measured ineffective)
- tile-pHash percentile (same p90 32 vs boundary 29–42)
- ORB+RANSAC (0–14 inliers on same-page dense text — repetitive glyph
  features die in crossCheck; works only on covers/graphics)
- quad bbox IoU continuity (new page lands exactly where the old was)
- raw-frame quad-region tile-pHash between consecutive frames
  (turns are gradual: every 100 ms step is small)
- NCC and quadrant-consistency NCC (multilingual warning pages of the
  same manual genuinely correlate higher across pages than some
  same-page crop pairs)

What does separate them: **time** (acceptance gaps ≈ turns; micro-gaps
within a hold need re-merge) and **content understanding** (OCR text
fingerprint / VLM). Note gap LENGTH alone does not separate: measured
hold-internal gaps (1.4–2.0 s) exceed one real page-turn gap (0.8 s).

## New architecture: `--algorithm segment` (+ optional `--verify ocr`)

L1: temporal runs (gap > 1 s splits) with ORB/verifier-checked cuts at
suspicious in-run boundaries. L2: cross-segment union-find merge —
tile ≤ 18 unconditional; ORB ≥ 25 (adjacent ≤ 3 s) / ≥ 50 (distant)
with grid ≥ 8; OCR verifier (YomiToku 3-gram Jaccard ≥ 0.35, or
containment ≥ 0.5 at gaps ≤ 1.5 s for partial-coverage crops) decides
adjacent text-page pairs that ORB cannot.

Browser YOLO is now enabled by default (`VITE_DISABLE_ML_DETECTOR=1`
to roll back); low-confidence frames are skipped, NOT handed to
OpenCV (mixing detectors breaks hash continuity; OpenCV remains only
as the model-load-failure fallback). ORT WASM is self-hosted under
`/ort/` (`scripts/copy-ort-assets.mjs`) — the jsdelivr CDN dependency
broke offline-first. Verified end-to-end via Playwright on the built
SPA (mp4 upload → 11 pages, model loads, no CDN traffic).

## 2026-06-12 final numbers — segment+rescue+OCR pipeline

Config: `--detector yolo --algorithm segment --min-conf 0.25 --verify ocr`
(all defaults; this is what `scripts/eval/regress.mjs` freezes).

| video               | GT faces             | winners | identity recall | duplicates | false positives |
| ------------------- | -------------------- | ------- | --------------- | ---------- | --------------- |
| mp4-1 (Ergotron)    | 12 real + 1 optional | 14      | **1.00**        | 1          | **0**           |
| mp4-2 (mixed items) | 10 real              | 17      | **1.00**        | 5          | 2               |

Starting point (tile-orb, same detector): identity recall 0.64 / 0.78
with 7-9 duplicates and whole pages silently missing.

Mechanisms that made the difference:

1. **Temporal segmentation** (acceptance gaps = page turns; hash spikes
   at gap<0.5 s are never cuts — physically impossible page swaps).
2. **Gap rescue with center-weighted recursive pick + NMS** — recovers
   blur-gated sparse pages (illustrations, minimal book covers). Floors:
   ten ≥ 10, conf ≥ 0.4, areaFrac ≥ 0.08 (measured: every true rescue
   ≥ 0.52 / 0.12; lap is unusable — Lean Startup cover rescued at lap 2).
3. **OCR text fingerprint (YomiToku, 3-gram Jaccard ≥ 0.20 or
   containment ≥ 0.5 at ≤1.5 s)** as the verifier for dense-text pairs
   where every classical signal fails. Disk-cached per video+detector.
4. ORB+grid for graphics pairs (covers, packages) where OCR has nothing.

The rescue pass found TWO pages that human GT curation had missed
(mp4-1 g13 friction page, mp4-2 h10 Calorie Mate box) — the GT itself
was corrected by the pipeline. Residual errors are duplicates
(transitional frames OCR can't verify: hand-occluded, tilted) and 2
junk FPs on mp4-2 — both one-tap-deletable classes; zero missed pages.

Remaining known costs: YomiToku ≈ 30-90 s/image first time (cached
after); browser port needs a different verifier (Tesseract.js or Gemma
band) — see Step 3 in the plan.

---

# 2026-06-12 — Step 3: pipeline unified into packages/core, segment ported to browser

The eval harness and the browser app now share ONE implementation in
`packages/core/src/pipeline/` (hash, score, sharpness, warp, Otsu detect,
ORB, segment clustering, YOLO letterbox/decode, text-similarity,
QuadSmoother, FrameCollector). Injection pattern: pure modules are plain
exports; cv-dependent modules are factories over `{ cv, createCanvas }`
(`createPipelineOps`). The eval harness imports core TS source directly
(Bun runs it natively — no build in the regress loop); the browser
consumes `@astarworks/scan-core/pipeline` from dist.

- `scripts/eval/pipeline.mjs` is now a thin facade (processFrame trace,
  clusterAccepted reproduction, rawLinkDistance diagnostics only).
- `scripts/eval/lib/segment-cluster.mjs` is deleted; the algorithm lives
  in `packages/core/src/pipeline/segment-cluster.ts` with ORB injected
  via `hooks.orb`. Unit tests moved to vitest
  (`packages/core/test/pipeline-*.test.ts`, 41 tests).
- Regression gate re-verified after every migration step and run TWICE
  after the ORB port (RANSAC randomness): mp4-1 recall 1.0 / dup 1 / fp 0,
  mp4-2 recall 1.0 / dup 5 / fp 2 — identical to the frozen baselines.

Browser (`apps/web/app/pages/index.vue`) replaced tile-centroid(27) +
ORB-merge(25) with `clusterBySegments`:

- Capture loop records `idx`/`t_s` (sample counter, 10 fps) and keeps a
  rescue candidates pool (blur-gate rejects clearing ten ≥ 10 /
  conf ≥ 0.4 / area ≥ 0.08; lowest-score eviction at 200).
- `MIN_CONFIDENCE` raised 0.1 → 0.25 to match the frozen eval config.
- verifySame = NDLOCR-Lite (existing ocr-service, lazy-init on the first
  ambiguous pair) + the SAME 3-gram Jaccard/containment judgment from
  core `text-similarity.ts` that YomiToku results go through in eval.
- LLM passes moved behind `enableLlm`: best-frame re-pick per cluster,
  and VLM pair-compare ONLY as the verifier fallback when OCR abstains.
  The old pHash-band pair-comparison block is gone (subsumed).

Playwright on the built SPA (mp4-1 upload, headless CPU): full pipeline
ran end-to-end — 10 clusters (1 rescued, 7 cuts, 1 merge), 3 verify-ocr
judgments via NDLOCR, zero non-localhost network traffic. Headless
realtime playback only sampled 115 frames (vs ffmpeg's 431), so absolute
page counts aren't comparable to the eval numbers; the mechanism parity
(gap cuts, rescue, OCR verify) is what this validates. Real-device
verification still pending (holdout video, Step 3 残課題③).
