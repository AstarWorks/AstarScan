/**
 * OpenCV.js script loader.
 *
 * jscanify (and any future backend that wants to touch cv.Mat directly)
 * needs `window.cv` to exist and have finished its async WASM init before
 * it can be used. This module centralizes the "inject a <script> once and
 * wait for the runtime to be fully ready" dance so callers don't have to
 * reimplement the poll loop.
 *
 * OpenCV.js initializes in two stages: JS wrappers like `imread` appear as
 * soon as the script evaluates, but embind-backed functions
 * (`getPerspectiveTransform`, `warpPerspective`, `Mat`, `Size`, ...) only
 * appear after `onRuntimeInitialized` fires. We poll on the warp functions
 * — if those are live, the full runtime is live.
 *
 * Loaded from the official docs mirror. First load is ~8MB; subsequent
 * visits are served from the HTTP cache (and eventually the Service Worker
 * once apps/web's PWA layer caches it).
 *
 * The type of `window.cv` is declared in `apps/web/app/types/globals.d.ts`.
 */

// Served locally to avoid CORS issues with docs.opencv.org
const OPENCV_URL = '/opencv.js'
const DEFAULT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 100
const SCRIPT_MARKER = 'data-astar-opencv'

function isRuntimeReady(): boolean {
  const cv = window.cv
  return (
    typeof cv?.imread === 'function' &&
    typeof cv?.getPerspectiveTransform === 'function' &&
    typeof cv?.warpPerspective === 'function'
  )
}

/**
 * Inject the OpenCV.js `<script>` tag (once) and resolve when the full
 * WASM runtime — including the warp API — is ready. Safe to call multiple
 * times; the script is only inserted once per page, subsequent calls just
 * poll the existing initialization.
 *
 * Rejects if the script fails to load or if the poll exceeds
 * `timeoutMs` (default 30 seconds).
 */
export function loadOpenCV(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isRuntimeReady()) {
      resolve()
      return
    }

    const existing = document.querySelector<HTMLScriptElement>(
      `script[${SCRIPT_MARKER}]`,
    )
    if (!existing) {
      const script = document.createElement('script')
      script.src = OPENCV_URL
      script.async = true
      script.setAttribute(SCRIPT_MARKER, '1')
      script.onerror = () =>
        reject(new Error('OpenCV.js の読み込みに失敗しました'))
      document.head.appendChild(script)
    }

    const started = Date.now()
    const poll = () => {
      if (isRuntimeReady()) {
        resolve()
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('OpenCV.js の初期化がタイムアウトしました'))
        return
      }
      window.setTimeout(poll, POLL_INTERVAL_MS)
    }
    poll()
  })
}

/** `true` if OpenCV.js has finished loading and the warp API is callable. */
export function isOpenCVReady(): boolean {
  return isRuntimeReady()
}
