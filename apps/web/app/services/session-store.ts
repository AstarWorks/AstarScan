/**
 * IndexedDB-backed session persistence.
 *
 * Saves captured pages to IndexedDB so the scan session survives browser
 * refresh, accidental navigation, and iOS Safari's aggressive page eviction.
 * The session is automatically deleted when the user exports a PDF
 * (configurable), or can be cleared manually.
 *
 * Storage format: each page's JPEG data URL is stored as-is (base64 string).
 * For a typical 50-page session at 1200×1600 JPEG @0.85, that's roughly
 * 50 × 300KB = 15MB — well within IndexedDB's quota on modern browsers.
 *
 * Uses the raw IndexedDB API (not `idb` npm package) to keep dependencies
 * minimal. The API is thin enough that a wrapper adds more complexity
 * than it saves.
 */

const DB_NAME = 'AstarScanSession'
const DB_VERSION = 1
const STORE_NAME = 'pages'
const SESSION_KEY = 'current'

export interface StoredPage {
  readonly id: string
  readonly dataUrl: string
  readonly width: number
  readonly height: number
  readonly sharpness: number
  readonly ocrText?: string
  readonly ocrLines?: readonly {
    text: string
    bbox: readonly [number, number, number, number]
    confidence: number
  }[]
  readonly capturedAt: number
}

export interface StoredSession {
  readonly pages: StoredPage[]
  readonly updatedAt: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

/**
 * Save the current scan session to IndexedDB. Call after each capture
 * or page deletion to keep the persisted state in sync.
 */
export async function saveSession(pages: StoredPage[]): Promise<void> {
  const db = await openDB()
  const session: StoredSession = {
    pages,
    updatedAt: Date.now(),
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    const request = store.put(session, SESSION_KEY)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve()
  })
}

/**
 * Load the previously saved session, if any. Returns `null` if no
 * session exists (first visit or after clearSession).
 */
export async function loadSession(): Promise<StoredSession | null> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(SESSION_KEY)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        resolve((request.result as StoredSession | undefined) ?? null)
      }
    })
  } catch {
    // IndexedDB unavailable (private browsing on some browsers).
    return null
  }
}

/**
 * Delete the saved session. Call after PDF export or when the user
 * explicitly clears the session.
 */
export async function clearSession(): Promise<void> {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.delete(SESSION_KEY)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch {
    // Silently ignore — nothing to clean up.
  }
}
