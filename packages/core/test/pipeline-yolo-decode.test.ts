import { describe, expect, it } from 'vitest'
import {
  YOLO_OUTPUT_CHANNELS,
  decodeYoloOutput,
  letterboxToFloat32,
  type YoloRotation,
} from '../src/pipeline/yolo-decode.js'
import type {
  CanvasLike,
  Context2DLike,
  ImageDataLike,
} from '../src/pipeline/deps.js'

/**
 * Minimal canvas: pixels as RGBA bytes; drawImage only supports a 1:1
 * copy of a whole source (enough for an identity-scale letterbox).
 */
class FakeCanvas implements CanvasLike {
  px: Uint8ClampedArray
  constructor(
    public width: number,
    public height: number,
  ) {
    this.px = new Uint8ClampedArray(width * height * 4)
  }
  getContext(): Context2DLike {
    const dst = this.px
    const dstW = this.width
    const dstH = this.height
    return {
      fillStyle: '',
      drawImage(img: CanvasLike, ...a: number[]) {
        const src = img as FakeCanvas
        const [, , sw, sh, dx = 0, dy = 0, dw = sw, dh = sh] = a
        if (sw !== dw || sh !== dh) throw new Error('fake: no scaling')
        for (let y = 0; y < (sh ?? 0); y += 1)
          for (let x = 0; x < (sw ?? 0); x += 1)
            for (let c = 0; c < 4; c += 1)
              dst[((y + dy) * dstW + x + dx) * 4 + c] =
                src.px[(y * src.width + x) * 4 + c]!
      },
      getImageData(): ImageDataLike {
        return { width: dstW, height: dstH, data: dst }
      },
      createImageData(w: number, h: number): ImageDataLike {
        return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
      },
      putImageData() {},
      clearRect() {},
      fillRect() {},
    }
  }
}
const createCanvas = (w: number, h: number) => new FakeCanvas(w, h)

/** 4×2 landscape source; red channel = 10 + pixel index. */
function landscapeSource(): FakeCanvas {
  const c = new FakeCanvas(4, 2)
  for (let i = 0; i < 8; i += 1) {
    c.px[i * 4] = 10 + i
    c.px[i * 4 + 3] = 255
  }
  return c
}

/** One-anchor model output with the given box and keypoints (input px). */
function output(
  box: [number, number, number, number],
  kps: Array<[number, number]>,
): Float32Array {
  const d = new Float32Array(YOLO_OUTPUT_CHANNELS)
  d.set(box, 0)
  d[4] = 0.9
  kps.forEach(([x, y], k) => {
    d[5 + k * 3] = x
    d[6 + k * 3] = y
    d[7 + k * 3] = 0.1 * (k + 1)
  })
  return d
}

describe('letterboxToFloat32 rotation', () => {
  it('leaves landscape untouched without rotateLandscape', () => {
    const r = letterboxToFloat32(landscapeSource(), createCanvas, 4)
    expect(r.rotation).toBeNull()
    expect(r.scale).toBe(1)
  })

  it('never turns a portrait source', () => {
    const src = new FakeCanvas(2, 4)
    const r = letterboxToFloat32(src, createCanvas, 4, {
      rotateLandscape: 'cw',
    })
    expect(r.rotation).toBeNull()
  })

  for (const dir of ['cw', 'ccw'] as const) {
    it(`turns landscape ${dir} and decode maps points back`, () => {
      const src = landscapeSource()
      const r = letterboxToFloat32(src, createCanvas, 4, {
        rotateLandscape: dir,
      })
      expect(r.rotation).toEqual({ dir, srcW: 4, srcH: 2 })
      // View is 2 wide × 4 tall, centred: padX 1, padY 0, scale 1.
      expect([r.scale, r.padX, r.padY]).toEqual([1, 1, 0])
      const plane = 16
      // Source pixel (xs, ys) → view pixel.
      const view = (xs: number, ys: number) =>
        dir === 'cw' ? { x: 2 - 1 - ys, y: xs } : { x: ys, y: 4 - 1 - xs }
      for (let ys = 0; ys < 2; ys += 1)
        for (let xs = 0; xs < 4; xs += 1) {
          const v = view(xs, ys)
          const d = (r.padY + v.y) * 4 + r.padX + v.x
          expect(Math.round((r.data[d] ?? 0) * 255)).toBe(10 + ys * 4 + xs)
        }
      // Padding columns stay grey.
      expect(Math.round((r.data[0] ?? 0) * 255)).toBe(114)
      expect(r.data.length).toBe(3 * plane)

      // A keypoint at the centre of view pixel v decodes to the centre of
      // source pixel (xs, ys); TL..BL keep their source meaning.
      const srcPts: Array<[number, number]> = [
        [0.5, 0.5], // source TL
        [3.5, 0.5], // source TR
        [3.5, 1.5], // source BR
        [0.5, 1.5], // source BL
      ]
      const toInput = ([x, y]: [number, number]): [number, number] => {
        const v =
          dir === 'cw' ? { x: 2 - y, y: x } : { x: y, y: 4 - x }
        return [r.padX + v.x * r.scale, r.padY + v.y * r.scale]
      }
      const inPts = srcPts.map(toInput)
      // The model reports corners in VIEW order (its own TL first).
      const viewOrder = (pts: Array<[number, number]>) => {
        const s = [...pts]
        const tl = s.reduce((a, b) => (b[0] + b[1] < a[0] + a[1] ? b : a))
        const br = s.reduce((a, b) => (b[0] + b[1] > a[0] + a[1] ? b : a))
        const tr = s.reduce((a, b) => (b[0] - b[1] > a[0] - a[1] ? b : a))
        const bl = s.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a))
        return [tl, tr, br, bl]
      }
      const det = decodeYoloOutput(
        output([2, 2, 2, 4], viewOrder(inPts)),
        YOLO_OUTPUT_CHANNELS,
        1,
        r.scale,
        r.padX,
        r.padY,
        r.rotation,
      )
      expect(det).not.toBeNull()
      const q = det!.quad
      expect([q.tl.x, q.tl.y]).toEqual([0.5, 0.5])
      expect([q.tr.x, q.tr.y]).toEqual([3.5, 0.5])
      expect([q.br.x, q.br.y]).toEqual([3.5, 1.5])
      expect([q.bl.x, q.bl.y]).toEqual([0.5, 1.5])
      // The view box (whole 2×4 view) is the whole 4×2 source.
      expect(det!.box).toEqual({ x0: 0, y0: 0, x1: 4, y1: 2 })
    })
  }
})

describe('decodeYoloOutput box', () => {
  it('returns the winning box in source pixels', () => {
    const det = decodeYoloOutput(
      output(
        [330, 340, 200, 300],
        [
          [240, 200],
          [420, 200],
          [420, 480],
          [240, 480],
        ],
      ),
      YOLO_OUTPUT_CHANNELS,
      1,
      0.5,
      10,
      20,
    )
    expect(det!.box).toEqual({ x0: 440, y0: 340, x1: 840, y1: 940 })
    expect(det!.quad.tl).toEqual({ x: 460, y: 360 })
    expect(det!.visibility[0]).toBeCloseTo(0.1)
  })

  it('reorders visibility with the corners when turned', () => {
    const rot: YoloRotation = { dir: 'cw', srcW: 1280, srcH: 720 }
    const det = decodeYoloOutput(
      output(
        [320, 320, 100, 100],
        [
          [300, 300],
          [340, 300],
          [340, 340],
          [300, 340],
        ],
      ),
      YOLO_OUTPUT_CHANNELS,
      1,
      1,
      0,
      0,
      rot,
    )
    // Source TL = view TR (index 1).
    expect(det!.visibility.map((v) => +v.toFixed(1))).toEqual([
      0.2, 0.3, 0.4, 0.1,
    ])
  })
})
