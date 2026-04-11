/**
 * Perspective warper facade.
 *
 * The actual `warpPerspective` implementation lives next to
 * `JscanifyBackend` because it currently delegates to jscanify's
 * `extractPaper` (which is the only other piece of jscanify API we use
 * outside detection). This file re-exports it under a backend-agnostic
 * name so pages and components don't depend on the file path
 * `jscanify-backend` at import time.
 *
 * When we add a second backend (DocAligner, ML Kit, etc.), the same
 * re-export pattern lets us swap the underlying implementation without
 * touching any import in apps/web's pages.
 */

export { warpPerspective } from './jscanify-backend'
