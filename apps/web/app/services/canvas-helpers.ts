/**
 * Tiny helpers for in-browser canvas allocation.
 */

export function newCanvasLike(source: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = source.width
  c.height = source.height
  return c
}

export function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

/**
 * Uniform downscale so the long side is at most `longSide`. Returns the
 * source itself when it is already small enough, so callers can pass any
 * frame without branching.
 *
 * Used before JPEG-encoding a retained source frame: encoding at native
 * camera resolution (often 1920x1080 or more) costs tens of milliseconds,
 * which at the 10 FPS sample rate eats the per-frame budget outright.
 */
export function downscaleToLongSide(
  source: HTMLCanvasElement,
  longSide: number,
): HTMLCanvasElement {
  const current = Math.max(source.width, source.height)
  if (current <= longSide) return source

  const scale = longSide / current
  const out = newCanvas(Math.round(source.width * scale), Math.round(source.height * scale))
  out.getContext('2d')?.drawImage(source, 0, 0, out.width, out.height)
  return out
}
