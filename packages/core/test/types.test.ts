/**
 * Public type contract tests for @astarworks/scan-core.
 *
 * These tests validate two things:
 *   1. The types exported from `src/index.ts` are structurally correct
 *      and can be instantiated as expected (catches breaking API changes).
 *   2. The Vitest infrastructure itself is wired up correctly — this is
 *      the first test file in the monorepo, so if it runs, we know the
 *      root vitest.config.ts discovery glob is working.
 *
 * There is no runtime code in scan-core yet, so these are pure structural
 * tests. Phase 1a will add proper behavioral tests for the pipeline, edge
 * detector backends, and PDF assembly service.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  CapturedPage,
  PageChangeState,
  PdfExportOptions,
  Point,
  Quad,
  ScanError,
  ScanErrorCode,
  ScanEventMap,
  ScanPipelineOptions,
  ScanState,
  Unsubscribe,
} from '../src/index.js'

describe('@astarworks/scan-core public types — runtime instantiation', () => {
  it('ScanState accepts all five lifecycle states', () => {
    const states: ScanState[] = [
      'idle',
      'active',
      'capturing',
      'review',
      'error',
    ]
    expect(states).toHaveLength(5)
  })

  it('Quad describes a 4-corner polygon in pixel coordinates', () => {
    const quad: Quad = {
      tl: { x: 10, y: 20 },
      tr: { x: 110, y: 20 },
      br: { x: 110, y: 170 },
      bl: { x: 10, y: 170 },
    }
    expect(quad.tl.x).toBe(10)
    expect(quad.br.y).toBe(170)
  })

  it('CapturedPage requires width/height for quad reference frame', () => {
    const page: CapturedPage = {
      id: 'a76c4f6d-8e1a-4c3a-9f21-0a1b2c3d4e5f',
      imageBlob: new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' }),
      thumbnail: 'data:image/jpeg;base64,...',
      quad: {
        tl: { x: 0, y: 0 },
        tr: { x: 200, y: 0 },
        br: { x: 200, y: 280 },
        bl: { x: 0, y: 280 },
      },
      phash: '0f1e2d3c4b5a6978',
      capturedAt: new Date('2026-04-11T00:00:00Z'),
      qualityScore: 0.87,
      width: 200,
      height: 280,
    }
    expect(page.qualityScore).toBeGreaterThanOrEqual(0)
    expect(page.qualityScore).toBeLessThanOrEqual(1)
    expect(page.width).toBe(page.quad.tr.x)
  })

  it('PdfExportOptions supports single / split / batch modes', () => {
    const single: PdfExportOptions = {
      mode: 'single',
      pageSize: 'A4',
      quality: 0.8,
    }
    const split: PdfExportOptions = {
      mode: 'split',
      pageSize: 'auto',
      quality: 0.95,
    }
    const batch: PdfExportOptions = {
      mode: 'batch',
      batchSize: 10,
      pageSize: 'Letter',
      quality: 0.6,
    }
    expect(single.mode).toBe('single')
    expect(split.pageSize).toBe('auto')
    expect(batch.batchSize).toBe(10)
  })

  it('ScanError carries a typed code and retriable flag', () => {
    const err: ScanError = {
      code: 'camera-permission-denied',
      retriable: true,
    }
    expect(err.retriable).toBe(true)
    expect(err.code).toBe('camera-permission-denied')
  })

  it('ScanPipelineOptions applies sensible defaults in the type itself', () => {
    const opts: ScanPipelineOptions = {
      mode: 'video',
      fps: 10,
      duplicateThreshold: 8,
      blurThreshold: 100,
      maxPages: 200,
    }
    expect(opts.mode).toBe('video')
    expect(opts.duplicateThreshold).toBe(8)
  })
})

describe('@astarworks/scan-core public types — type-level checks', () => {
  it('Point has numeric x/y', () => {
    expectTypeOf<Point>().toEqualTypeOf<{
      readonly x: number
      readonly y: number
    }>()
  })

  it('ScanState is a closed string literal union', () => {
    expectTypeOf<ScanState>().toEqualTypeOf<
      'idle' | 'active' | 'capturing' | 'review' | 'error'
    >()
  })

  it('PageChangeState is a three-way classifier', () => {
    expectTypeOf<PageChangeState>().toEqualTypeOf<
      'stable' | 'moving' | 'unknown'
    >()
  })

  it('ScanEventMap pairs each event name with its payload type', () => {
    expectTypeOf<ScanEventMap['state']>().toEqualTypeOf<ScanState>()
    expectTypeOf<ScanEventMap['page']>().toEqualTypeOf<CapturedPage>()
    expectTypeOf<ScanEventMap['quality']>().toEqualTypeOf<number>()
    expectTypeOf<ScanEventMap['error']>().toEqualTypeOf<ScanError>()
  })

  it('Unsubscribe is a zero-argument void function', () => {
    expectTypeOf<Unsubscribe>().toEqualTypeOf<() => void>()
  })

  it('ScanErrorCode enumerates every retriable and terminal code', () => {
    // Explicit spot checks against the documented codes. If a new code is
    // added, this test only needs updating if the new code is meant to be
    // part of the primary enumeration.
    const codes: ScanErrorCode[] = [
      'camera-permission-denied',
      'camera-not-ready',
      'camera-device-lost',
      'camera-not-readable',
      'wasm-init-failed',
      'edge-detector-not-ready',
      'pdf-export-failed',
      'page-limit-exceeded',
      'ios-standalone-camera-lost',
      'invalid-quad',
      'pipeline-not-started',
      'pipeline-already-started',
    ]
    expect(codes).toHaveLength(12)
  })
})
