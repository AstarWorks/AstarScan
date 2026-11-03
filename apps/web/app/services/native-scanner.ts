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

/**
 * Pages one ML Kit scanner session takes before it is saved into the app.
 * The scanner gives its pages back only on save; when Play services'
 * scanner process dies first, the whole session is lost (emulator run 13c:
 * 10 sessions of up to 6 pages). Short sessions bound that loss; the app
 * reopens the scanner after each full one, so scanning goes on.
 */
export const NATIVE_PAGES_PER_SCAN = 5

/** Open the ML Kit scanner (full mode) and wait for its pages. */
export function nativeScan(pageLimit = 0): Promise<NativeScanResult> {
  return call<NativeScanResult>('scan', { pageLimit })
}

/** A scanned page downscaled to `maxSide` px, as a JPEG data URL. */
export async function nativeReadPage(
  uri: string,
  maxSide: number,
): Promise<string> {
  const r = await call<{ dataUrl: string }>('read_page', { uri, maxSide })
  return r.dataUrl
}

/** A line of text ML Kit found in a page's top or bottom margin. */
export interface NativeMarginLine {
  readonly text: string
  /** ML Kit's confidence, 0..1. */
  readonly conf: number
  /** Line centre, 0..1 of the page width / height. */
  readonly cx: number
  readonly cy: number
  /**
   * `band`: the whole margin band read at once; `folio`: a short, isolated
   * piece of print in it (where a page number sits) read enlarged.
   */
  readonly pass?: string
}

/**
 * Text in the top / bottom `marginFrac` of a scanned page (full size), read
 * on the device with ML Kit Text Recognition v2 (Japanese + Latin).
 */
export async function nativeReadMargins(
  uri: string,
  marginFrac: number,
): Promise<readonly NativeMarginLine[]> {
  const r = await call<{ lines: NativeMarginLine[] }>('read_margins', {
    uri,
    marginFrac,
  })
  return r.lines
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

export interface AstarSendTarget {
  /** AstarManagement origin, e.g. https://app.example.com */
  readonly server: string
  /** Service account token (asm_sk_…). */
  readonly token: string
  /** Folder (node) UUID the PDF and Markdown are saved into. */
  readonly folderId: string
}

export interface AstarSendResult {
  readonly jobId: string | null
}

/**
 * Send the pages to AstarManagement's book capture
 * (`POST /api/v1/book-captures`). The server flattens the pages and saves a
 * searchable PDF + Markdown into the folder in the background.
 */
export async function nativeSendToAstar(
  target: AstarSendTarget,
  pages: readonly string[],
  name: string,
): Promise<AstarSendResult> {
  const r = await call<{ status: number; body: string }>('upload', {
    server: target.server,
    token: target.token,
    folderId: target.folderId,
    name,
    pages,
  })
  try {
    const job = JSON.parse(r.body) as { jobId?: unknown }
    return { jobId: typeof job.jobId === 'string' ? job.jobId : null }
  } catch {
    return { jobId: null }
  }
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
