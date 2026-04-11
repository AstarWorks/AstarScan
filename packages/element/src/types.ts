/**
 * @astarworks/scan-element — Web Component type contracts
 *
 * The `<astar-scan>` custom element exposes a framework-agnostic interface
 * for embedding the scanner in any HTML page (or React / Svelte / Solid /
 * plain-JS app). It wraps `@astarworks/scan-vue` components under the hood
 * via Vue's `defineCustomElement`.
 *
 * HTML attributes are always strings, so numeric options (`max-pages`,
 * `fps`) take string values in the attribute API. Developers using the
 * DOM API (`element.maxPages = 100`) can pass numbers directly.
 */

import type { CapturedPage, ScanError, ScanState } from '@astarworks/scan-core'

/**
 * Attributes accepted by `<astar-scan>`. All attributes are optional;
 * sensible defaults are applied at element construction time.
 *
 * Example:
 * ```html
 * <astar-scan mode="video" lang="ja" max-pages="100" fps="10" theme="auto">
 * </astar-scan>
 * ```
 */
export interface ScanElementAttributes {
  /**
   * Scanning mode. `video` = continuous automatic page extraction from the
   * camera stream, `manual` = tap-to-capture. Default: `video`.
   */
  readonly mode?: 'video' | 'manual'
  /**
   * UI language. Defaults to the browser's `navigator.language` prefix,
   * falling back to `en` if no match is found. Currently supports `ja` and
   * `en`; additional locales may be added later.
   */
  readonly lang?: 'ja' | 'en'
  /**
   * Maximum pages per session as a string (HTML attribute constraint).
   * Default: `"200"`. Attempts to capture beyond this raise a
   * `page-limit-exceeded` error event.
   */
  readonly 'max-pages'?: string
  /**
   * Target frame processing rate as a string. Default: `"10"`. Higher values
   * consume more battery; lower values may miss rapid page turns.
   */
  readonly fps?: string
  /**
   * Color theme. `auto` follows `prefers-color-scheme`. Default: `auto`.
   */
  readonly theme?: 'light' | 'dark' | 'auto'
}

/**
 * Event payload shapes emitted by `<astar-scan>`. Event names follow the
 * kebab-case convention used by native DOM events. Listeners receive a
 * `CustomEvent<T>` whose `detail` property contains the payload.
 *
 * Example:
 * ```ts
 * const el = document.querySelector('astar-scan')
 * el.addEventListener('result', (e: CustomEvent<ScanElementEventDetailMap['result']>) => {
 *   const { pdf, pageCount } = e.detail
 *   saveOrShare(pdf)
 * })
 * ```
 */
export interface ScanElementEventDetailMap {
  /**
   * The user has completed the session and the PDF has been assembled.
   * Fired once per call to the internal `exportPdf`.
   */
  readonly result: { readonly pdf: Blob; readonly pageCount: number }
  /**
   * A new page has been added to the session. Fired once per capture, in
   * both `manual` and `video` modes.
   */
  readonly 'page-captured': { readonly page: CapturedPage }
  /**
   * The pipeline state has transitioned. Useful for driving external UI
   * such as a progress bar or status text.
   */
  readonly 'state-change': { readonly state: ScanState }
  /**
   * A recoverable error occurred. For unrecoverable errors the element
   * will also dispatch a `state-change` event with `state: 'error'`.
   */
  readonly error: ScanError
}

export type ScanElementEventName = keyof ScanElementEventDetailMap

/**
 * Imperative methods exposed on the `<astar-scan>` element instance.
 * Obtain via `document.querySelector('astar-scan')`.
 */
export interface ScanElementMethods {
  /** Begin processing. Equivalent to the Vue `useScanner().start()`. */
  start(): Promise<void>
  /** Halt processing. Session state is preserved. */
  stop(): void
  /** Clear the current session (removes all captured pages). */
  clear(): void
}
