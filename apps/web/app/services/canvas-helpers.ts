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
