/**
 * Android app (Tauri) bridge to Google ML Kit Document Scanner — see
 * `src-tauri/plugins/mlkit-scanner`. ML Kit owns the camera UI, page-edge
 * detection and auto-capture; pages come back as JPEG files in the app's
 * storage, addressed by `file://` URIs.
 *
 * Uses Tauri's global IPC (`__TAURI_INTERNALS__`) instead of
 * `@tauri-apps/api` so the web build gains no dependency.
 */

export interface NativePage {
  readonly uri: string
  readonly width: number
  readonly height: number
  /** Small JPEG data URL for the list. */
  readonly thumb: string
}

export interface NativeScanResult {
  readonly canceled: boolean
  readonly pages: readonly NativePage[]
}

export interface SavedPdf {
  readonly uri: string
  /** Where the user finds it, e.g. "Download/AstarScan/x.pdf". */
  readonly path: string
}

interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
}

function tauri(): TauriInternals | null {
  if (typeof window === 'undefined') return null
  const t = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__
  return t ?? null
}

/** True inside the AstarScan Android app, where ML Kit replaces the web camera. */
export function isNativeScanner(): boolean {
  return tauri() !== null && /Android/i.test(navigator.userAgent)
}

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = tauri()
  if (!t) return Promise.reject(new Error('not running in the Android app'))
  return t.invoke<T>(`plugin:mlkit-scanner|${cmd}`, args)
}

/** Open the ML Kit scanner (full mode, no page limit) and wait for its pages. */
export function nativeScan(): Promise<NativeScanResult> {
  return call<NativeScanResult>('scan')
}

/** A scanned page downscaled to `maxSide` px, as a JPEG data URL. */
export async function nativeReadPage(
  uri: string,
  maxSide: number,
): Promise<string> {
  const r = await call<{ dataUrl: string }>('read_page', { uri, maxSide })
  return r.dataUrl
}

/**
 * Write the pages (scanned `file://` URIs, or JPEG data URLs for pages
 * restored from a previous session) into one PDF under Download/AstarScan.
 */
export function nativeSavePdf(
  pages: readonly string[],
  name: string,
  open: boolean,
): Promise<SavedPdf> {
  return call<SavedPdf>('save_pdf', { pages, name, open })
}

/** Plugin errors arrive as strings or `{ message }` objects. */
export function nativeErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}
