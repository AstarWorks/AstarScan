/**
 * Debug: draw a detected quad over a source image so we can eyeball the
 * detector's output. Saves to /tmp/<basename>-quad.jpg.
 *
 * Run: bun scripts/eval/lib/visualize-quad.mjs <imagePath> [fastvit_t8|lcnet100|fastvit_sa24]
 */

import process from 'node:process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { jpegToCanvas, canvasToJpegBuffer } from '../canvas-utils.mjs'
import { DocAlignerNodeBackend } from './docaligner-node.mjs'
import { classifyQuad } from './quad-classify.mjs'

const [, , imagePath = '/tmp/mp4-3-sample/frame-04.jpg', model = 'fastvit_t8'] =
  process.argv

const buf = fs.readFileSync(imagePath)
const canvas = await jpegToCanvas(buf)
console.log(`image: ${canvas.width}×${canvas.height}`)

const backend = new DocAlignerNodeBackend(model)
await backend.warmUp()
const det = await backend.detect(canvas)
if (!det) {
  console.error('no detection')
  process.exit(1)
}
const { quad, confidence } = det
console.log('quad:', quad)
console.log('confidence:', confidence)
console.log('classify:', classifyQuad(quad, canvas.width, canvas.height))

const ctx = canvas.getContext('2d')
ctx.strokeStyle = '#00ff00'
ctx.lineWidth = 6
ctx.beginPath()
ctx.moveTo(quad.tl.x, quad.tl.y)
ctx.lineTo(quad.tr.x, quad.tr.y)
ctx.lineTo(quad.br.x, quad.br.y)
ctx.lineTo(quad.bl.x, quad.bl.y)
ctx.closePath()
ctx.stroke()

const labels = ['TL', 'TR', 'BR', 'BL']
const pts = [quad.tl, quad.tr, quad.br, quad.bl]
ctx.fillStyle = '#ff0000'
ctx.font = 'bold 40px sans-serif'
pts.forEach((p, i) => {
  ctx.beginPath()
  ctx.arc(p.x, p.y, 12, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillText(labels[i], p.x + 16, p.y - 16)
})

const out = `/tmp/${path.basename(imagePath, '.jpg')}-quad-${model}.jpg`
fs.writeFileSync(out, canvasToJpegBuffer(canvas, 85))
console.log('saved:', out)
