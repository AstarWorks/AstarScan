# CLAUDE.md — AstarScan

## Project Vision

**Edge document scanner PWA for law firms and construction sites.**
Point phone at paper stack → flip through pages → unique pages auto-extracted to PDF.
Fully offline, $0 cost, MIT licensed, embeddable as Web Component / NPM package.

Full design: [/home/node/.claude/plans/woolly-imagining-balloon.md](/home/node/.claude/plans/woolly-imagining-balloon.md)

## Core principles

- **Edge-first**: All inference runs on-device. No server, no cloud API, no telemetry by default.
- **Zero cost**: Cloudflare Pages free tier only. Monthly cost ¥0.
- **Framework-agnostic libraries**: `scan-core` / `scan-vue` / `scan-element` do NOT depend on Nuxt.
  Only `apps/web` uses Nuxt (SPA mode, `ssr: false`).
- **Type safety**: TS strict, no `any`, `noUncheckedIndexedAccess` enabled.
- **i18n-first**: No hardcoded strings. `scan-core` returns error codes only, callers translate.
- **5-10 FPS is enough**: Don't over-engineer for 30 FPS. WebGPU/SIMD/COOP-COEP are all unnecessary.

## Architecture

```
packages/
├── core/        # @astarworks/scan-core   (Pure TS, zero dependencies on frameworks)
├── vue/         # @astarworks/scan-vue    (Pure Vue 3, NOT Nuxt)
└── element/     # @astarworks/scan-element (<astar-scan> Web Component)

apps/
└── web/         # scan.astarworks.com (Nuxt 3 SPA, consumes the above packages)

examples/
├── html-embed/  # Plain HTML using <astar-scan>
├── nuxt-embed/  # Nuxt consumer of @astarworks/scan-vue
└── iframe-embed/# iframe + postMessage API
```

## Pipeline

```
Frame (5-10 FPS)
  → PageChangeDetector (pixel diff | optical flow)
  → QualityScorer (Laplacian + HSV glare)
  → EdgeDetector (JscanifyBackend | DocAlignerBackend)
  → PerspectiveService (OpenCV.js warpPerspective)
  → PerceptualHashService (pHash dedup, threshold 8)
  → CapturedPage → IndexedDB
  → (on export) jsPDF → Blob
```

## Key abstractions

- `ScanPipeline` — top-level imperative API in `scan-core`
- `EdgeDetectorBackend` — pluggable edge detection (jscanify → DocAligner)
- `useScanner` — reactive wrapper in `scan-vue`
- `<astar-scan>` — Custom Element in `scan-element`

## Phase plan

| Phase | Duration | Scope |
|-------|----------|-------|
| Week 0 | 1 week | Tech verification spike (real device, jscanify success rate ≥ 70%) |
| Phase 1a | 3 weeks | Monorepo, core, vue, Nuxt PWA, manual capture, manual corner correction, deploy |
| Phase 1b | 2 weeks | Video mode (gate: Week 0 passed) |
| Phase 1c | 2 weeks | Web Component, npm publish, examples |
| Phase 2 | 6-8 weeks | ONNX ML models (DocAligner), telemetry |
| Phase 3 | 6-8 weeks | Tauri Mobile native wrappers (optional) |
| Phase 4 | 3-4 weeks | Astar platform integration |

## Critical constraints

### iOS Safari survival kit (WebKit bug #185448)
Must be implemented in `useScanCamera`:
1. Single MediaStream singleton
2. `visibilitychange` / `pagehide` handlers
3. `track.onended` listener
4. Standalone mode: wait for first user interaction before `getUserMedia`
5. Safari version check (iOS 15+ required)
6. Retry `NotReadableError` / `AbortError` once after 500ms

### Manual corner correction UI (Phase 1 required)
- 4 drag handles (44x44 px tap area)
- 2x magnifier loupe on handle tap
- Reject invalid quads (self-intersecting, non-convex, area < 10%)
- One-handed: all buttons at bottom

### pHash duplicate detection
- Default threshold: Hamming distance ≤ 8
- User confirmation UI (never auto-delete)
- 3-level settings: loose / standard / strict

## Development workflow

1. Feature branch → PR → squash merge to main (trunk-based)
2. CI runs: lint + typecheck + unit + E2E + build + bundle-size
3. PR gets Cloudflare Preview deploy
4. Main merge → changesets version PR → merge → npm publish + prod deploy

## Testing

- **Unit**: Vitest on `scan-core` (image fixtures in `test/fixtures/`)
- **Component**: Vitest + `@vue/test-utils` on `scan-vue`
- **E2E**: Playwright with fake video stream (`--use-file-for-fake-video-capture`)
- **Visual regression**: Playwright screenshots
- **Real device**: manual weekly on iOS + Android
