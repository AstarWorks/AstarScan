/**
 * Where to look for the paper when the whole picture does not show it to
 * the corner model.
 *
 * A heat-map corner model (DocAligner, 256×256) is trained on one document
 * in view. A single page of an open book taken in a landscape picture
 * shows the facing page too — half or more of it — and the model finds
 * nothing on the whole picture: book 1's single-land-white (1920×1080) and
 * book 6's single-typewriter (1792×1344) had the weakest corner's peak at
 * a median 0.002 and the page went unframed in every hold (0 / 10, 0 / 11).
 * Shown less of the picture, the same model finds the page at once: with
 * the edges carried outward (the Android capture screen's second try,
 * CONTEXT_PAD) every hold of book 6 (peaks 0.4–0.9, corners within 1 % of
 * the diagonal), and in a window 55 % of the width over the page's half
 * (book 1: 10 / 10 holds, book 6: 11 / 11; the whole picture 0 / 10, the
 * padded one 0 / 10 on book 1).
 *
 * So the detector looks at a few views of the picture — the whole picture
 * first, then the padded one and the windows over the right, the left and
 * the middle of the picture — and takes the first that shows the paper.
 * Once a view shows it, that view is tried first on the next frame (one
 * model call a frame while the page is found; up to five while nothing is).
 * A corner a window puts on one of its cut edges is the window's edge, not
 * the paper's (a spread cut by the window): such a detection is not taken
 * (`onCutEdge`). Pure logic; the detector draws the view and maps the
 * corners back (`toFrame`).
 */
import type { Point } from '../types.js'

export interface DetectView {
  readonly name: string
  /** Window in the picture (px). */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** Margin added on every side with the edge pixels repeated (share of the window). */
  readonly pad: number
}

export const VIEW_SEARCH_DEFAULTS = {
  /** The padded view's margin (CaptureDetector.CONTEXT_PAD). */
  pad: 0.15,
  /** Width of the windows over one half of the picture (share of the width). */
  windowWidth: 0.55,
  /**
   * Centres of those windows (share of the width): a page held one-sided
   * sits a little off the middle, away from the facing page, its gutter
   * near the middle of the picture.
   */
  windowCentres: [0.575, 0.425, 0.5],
  /** A corner nearer a cut edge than this (share of the window's diagonal) is the edge. */
  cutMargin: 0.02,
}

/** The views of a `w`×`h` picture, the whole picture first. */
export function detectViews(
  w: number,
  h: number,
  opts: Partial<typeof VIEW_SEARCH_DEFAULTS> = {},
): DetectView[] {
  const o = { ...VIEW_SEARCH_DEFAULTS, ...opts }
  const views: DetectView[] = [
    { name: 'full', x: 0, y: 0, w, h, pad: 0 },
    { name: 'pad', x: 0, y: 0, w, h, pad: o.pad },
  ]
  const ww = Math.round(w * o.windowWidth)
  const names = ['right', 'left', 'centre']
  o.windowCentres.forEach((c, i) => {
    const x = Math.round(w * c - ww / 2)
    views.push({
      name: names[i] ?? `window${i}`,
      x: Math.max(0, Math.min(w - ww, x)),
      y: 0,
      w: ww,
      h,
      pad: 0,
    })
  })
  return views
}

/** `points` (picture px) with one on a cut edge of `view` (not an edge of the picture). */
export function onCutEdge(
  points: readonly Point[],
  view: DetectView,
  pictureW: number,
  pictureH: number,
  cutMargin = VIEW_SEARCH_DEFAULTS.cutMargin,
): boolean {
  const m = cutMargin * Math.hypot(view.w, view.h)
  const x1 = view.x + view.w
  const y1 = view.y + view.h
  return points.some(
    (p) =>
      (view.x > 0 && p.x - view.x < m) ||
      (x1 < pictureW && x1 - p.x < m) ||
      (view.y > 0 && p.y - view.y < m) ||
      (y1 < pictureH && y1 - p.y < m),
  )
}

/** Points found in the view's own pixels, in the picture's. */
export function toFrame<P extends Point>(
  points: readonly P[],
  view: DetectView,
): P[] {
  return points.map((p) => ({ ...p, x: p.x + view.x, y: p.y + view.y }))
}

/**
 * The order to try the views in: the one that showed the paper last, then
 * the whole picture, then the rest as listed.
 */
export class ViewSearch {
  #last: string | null = null

  order(views: readonly DetectView[]): DetectView[] {
    const last = views.find((v) => v.name === this.#last)
    return last ? [last, ...views.filter((v) => v !== last)] : [...views]
  }

  /** The view that showed the paper on this frame, or null when none did. */
  found(view: DetectView | null): void {
    this.#last = view?.name ?? null
  }

  get last(): string | null {
    return this.#last
  }
}
