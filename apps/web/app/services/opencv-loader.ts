/**
 * OpenCV.js script loader.
 *
 * jscanify (and any future backend that wants to touch cv.Mat directly)
 * needs `window.cv` to exist and have finished its async WASM init before
 * it can be used. This module centralizes the "inject a <script> once and
 * wait for `cv.imread` to become callable" dance so callers don't have to
 * reimplement the poll loop.
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

/**
 * Inject the OpenCV.js `<script>` tag (once) and resolve when
 * `window.cv.imread` is available. Safe to call multiple times — the
 * script is only inserted once per page, subsequent calls just poll the
 * existing initialization.
 *
 * Rejects if the script fails to load or if the poll exceeds
 * `timeoutMs` (default 30 seconds).
 */
export function loadOpenCV(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.cv?.imread) {
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
      if (window.cv?.imread) {
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

/** `true` if OpenCV.js has finished loading and `cv.imread` is callable. */
export function isOpenCVReady(): boolean {
  return typeof window.cv?.imread === 'function'
}
