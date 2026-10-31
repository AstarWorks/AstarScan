/**
 * Dependency-injection surface for the shared scan pipeline.
 *
 * `packages/core` is framework- and runtime-agnostic: it must run both in
 * the browser (DOM canvas + OpenCV.js global) and under Node/Bun
 * (@napi-rs/canvas + @techstark/opencv-js). Neither environment's concrete
 * types are imported here — instead the pipeline consumes STRUCTURAL types
 * that both environments satisfy:
 *
 *  - `CanvasLike` / `Context2DLike` / `ImageDataLike` — the common subset of
 *    HTMLCanvasElement and @napi-rs/canvas's Canvas that the pipeline uses.
 *  - `CvLike` — the exact OpenCV API surface the cv-dependent modules call
 *    (sharpness, warp, detect-otsu, orb). Both OpenCV.js builds satisfy it.
 *
 * cv-dependent modules are factories taking `PipelineDeps`; pure modules
 * (hash, score, segment-cluster, …) take no deps at all.
 */

export interface ImageDataLike {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

export interface Context2DLike {
  drawImage(
    image: CanvasImageSourceLike,
    sx: number,
    sy: number,
    sw?: number,
    sh?: number,
    dx?: number,
    dy?: number,
    dw?: number,
    dh?: number,
  ): void
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageDataLike
  createImageData(sw: number, sh: number): ImageDataLike
  putImageData(imageData: ImageDataLike, dx: number, dy: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillStyle: string | unknown
  fillRect(x: number, y: number, w: number, h: number): void
}

export interface CanvasLike {
  width: number
  height: number
  getContext(
    contextId: '2d',
    options?: { willReadFrequently?: boolean },
  ): Context2DLike | null
}

/** Anything drawImage accepts. Both DOM and @napi-rs canvases qualify. */
export type CanvasImageSourceLike = CanvasLike

/** Injected canvas factory — `document.createElement('canvas')` in the
 *  browser, `createCanvas` from @napi-rs/canvas under Node/Bun. */
export type CreateCanvas = (width: number, height: number) => CanvasLike

// ---------------------------------------------------------------------------
// OpenCV structural surface
// ---------------------------------------------------------------------------

export interface CvPoint {
  x: number
  y: number
}

export interface CvSize {
  width: number
  height: number
}

export interface CvRect {
  x: number
  y: number
  width: number
  height: number
}

export interface CvRotatedRect {
  center: CvPoint
  size: CvSize
  angle: number
}

export interface CvMat {
  rows: number
  cols: number
  readonly data: Uint8Array
  readonly data64F: Float64Array
  clone(): CvMat
  roi(rect: CvRect): CvMat
  delete(): void
}

export interface CvMatVector {
  size(): number
  get(index: number): CvMat
  delete(): void
}

export interface CvKeyPoint {
  pt: CvPoint
}

export interface CvKeyPointVector {
  size(): number
  get(index: number): CvKeyPoint
  delete(): void
}

export interface CvDMatch {
  distance: number
  queryIdx: number
  trainIdx: number
}

export interface CvDMatchVector {
  size(): number
  get(index: number): CvDMatch
  delete(): void
}

export interface CvOrb {
  detectAndCompute(
    image: CvMat,
    mask: CvMat,
    keypoints: CvKeyPointVector,
    descriptors: CvMat,
  ): void
}

export interface CvBFMatcher {
  match(
    queryDescriptors: CvMat,
    trainDescriptors: CvMat,
    matches: CvDMatchVector,
  ): void
}

/**
 * The OpenCV.js surface the pipeline actually calls. Structural: both the
 * browser global `cv` and the Node `@techstark/opencv-js` module satisfy it.
 * `Scalar` instances are only ever passed back into cv calls, hence `unknown`.
 */
export interface CvLike {
  Mat: { new (): CvMat; new (rows: number, cols: number, type: number): CvMat }
  MatVector: new () => CvMatVector
  KeyPointVector: new () => CvKeyPointVector
  DMatchVector: new () => CvDMatchVector
  Size: new (width: number, height: number) => CvSize
  Scalar: new (...values: number[]) => unknown
  Rect: new (x: number, y: number, width: number, height: number) => CvRect
  ORB: new (nfeatures: number) => CvOrb
  BFMatcher: new (normType: number, crossCheck: boolean) => CvBFMatcher

  cvtColor(src: CvMat, dst: CvMat, code: number): void
  threshold(
    src: CvMat,
    dst: CvMat,
    thresh: number,
    maxval: number,
    type: number,
  ): number
  getStructuringElement(shape: number, ksize: CvSize): CvMat
  morphologyEx(src: CvMat, dst: CvMat, op: number, kernel: CvMat): void
  findContours(
    image: CvMat,
    contours: CvMatVector,
    hierarchy: CvMat,
    mode: number,
    method: number,
  ): void
  contourArea(contour: CvMat): number
  minAreaRect(points: CvMat): CvRotatedRect
  Laplacian(
    src: CvMat,
    dst: CvMat,
    ddepth: number,
    ksize: number,
    scale: number,
    delta: number,
    borderType: number,
  ): void
  Sobel(
    src: CvMat,
    dst: CvMat,
    ddepth: number,
    dx: number,
    dy: number,
    ksize: number,
    scale: number,
    delta: number,
    borderType: number,
  ): void
  meanStdDev(src: CvMat, mean: CvMat, stddev: CvMat): void
  multiply(a: CvMat, b: CvMat, dst: CvMat): void
  add(a: CvMat, b: CvMat, dst: CvMat): void
  mean(src: CvMat): number[]
  matFromArray(rows: number, cols: number, type: number, array: number[]): CvMat
  getPerspectiveTransform(src: CvMat, dst: CvMat): CvMat
  warpPerspective(
    src: CvMat,
    dst: CvMat,
    M: CvMat,
    dsize: CvSize,
    flags: number,
    borderMode: number,
    borderValue: unknown,
  ): void
  findHomography(
    srcPoints: CvMat,
    dstPoints: CvMat,
    method: number,
    ransacReprojThreshold: number,
    mask: CvMat,
  ): CvMat

  CV_8UC4: number
  CV_32F: number
  CV_32FC2: number
  CV_64F: number
  COLOR_RGBA2GRAY: number
  THRESH_BINARY: number
  THRESH_OTSU: number
  MORPH_RECT: number
  MORPH_CLOSE: number
  MORPH_OPEN: number
  RETR_EXTERNAL: number
  CHAIN_APPROX_SIMPLE: number
  BORDER_DEFAULT: number
  BORDER_CONSTANT: number
  INTER_LINEAR: number
  NORM_HAMMING: number
  RANSAC: number
}

/** Everything the cv-dependent pipeline factories need. */
export interface PipelineDeps {
  cv: CvLike
  createCanvas: CreateCanvas
}
