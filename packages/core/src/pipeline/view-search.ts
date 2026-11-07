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
 * first, then the padded one and windows 60 % wide over the right, the
 * left and the middle of it — and takes the first that shows the paper
 * with every corner inside the picture (the padded view shows the model
 * the whole open book, whose outer corners lie outside: not a find). The
 * view that showed the paper is tried first on the next frame, and while
 * none does, the whole picture and two of the other views are tried each
 * frame, in turn (one model call a frame while the page is found, four
 * while nothing is; offline on the two clips, 95 / 114 and 111 / 116 hold
 * frames found, 1.9 and 1.4 calls a frame; every view every frame found
 * 100 / 114 and 114 / 116 at 3.5 and 2.4). A corner a window puts on one
 * of its cut edges is the window's edge, not the paper's (a spread cut by
 * the window): such a detection is not taken (`onCutEdge`). Pure logic;
 * the detector draws the view and maps the corners back (`toFrame`).
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
  windowWidth: 0.6,
  /**
   * Centres of those windows (share of the width): a page held one-sided
   * sits a little off the middle, away from the facing page, its gutter
   * near the middle of the picture (book 1's page spans 45–84 % of the
   * width; a window to 85 % put its fore-edge on the cut edge).
   */
  windowCentres: [0.6, 0.4, 0.5],
  /** Views tried a frame besides the whole picture while nothing shows the paper. */
  perFrame: 2,
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
 * The order to try the views in: the two views that showed the paper most
 * recently (a page found by the padded picture on one frame and by the
 * middle window on the next flips between them; trying only the last
 * cost a whole search on every flip), then the whole picture, then
 * `perFrame` of the other views, taken in turn from one frame to the
 * next. Once the whole picture finds the paper it is the first view again.
 */
export class ViewSearch {
  /** Views that found the paper, the most recent first. */
  #recent: string[] = []
  #turn = 0
  #perFrame: number

  constructor(perFrame = VIEW_SEARCH_DEFAULTS.perFrame) {
    this.#perFrame = perFrame
  }

  order(views: readonly DetectView[]): DetectView[] {
    const full = views[0]
    if (!full) return []
    const recent = this.#recent
      .map((name) => views.find((v) => v.name === name))
      .filter((v): v is DetectView => v !== undefined)
    const out: DetectView[] = [...recent]
    if (!out.includes(full)) out.push(full)
    const rest = views.filter((v) => !out.includes(v))
    const n = Math.min(this.#perFrame, rest.length)
    for (let k = 0; k < n; k++) out.push(rest[(this.#turn + k) % rest.length]!)
    this.#turn += n
    return out
  }

  /** The view that showed the paper on this frame, or null when none did. */
  found(view: DetectView | null): void {
    if (!view) return
    this.#recent =
      view.name === 'full'
        ? ['full']
        : [view.name, ...this.#recent.filter((n) => n !== view.name)].slice(
            0,
            2,
          )
  }

  get last(): string | null {
    return this.#recent[0] ?? null
  }
}
