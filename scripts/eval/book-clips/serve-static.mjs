#!/usr/bin/env node
/**
 * Static server for the generated app (apps/web/.output/public) with the
 * same cross-origin isolation as public/_headers (COOP + COEP), so the
 * corner model and the page-number reader run on WASM threads in a local
 * check (book-e2e.mjs / run-books.mjs). Not used in production.
 *
 *   node serve-static.mjs [dir] [port]      (default apps/web/.output/public, 4173)
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(
  process.argv[2] ?? path.join(here, '../../../apps/web/.output/public'),
)
const port = Number(process.argv[3] ?? 4173)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
}

http
  .createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    let p = path.join(root, decodeURIComponent(u.pathname))
    if (!p.startsWith(root)) {
      res.writeHead(403).end()
      return
    }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory())
      p = path.join(p, 'index.html')
    if (!fs.existsSync(p) && fs.existsSync(`${p}.html`)) p = `${p}.html`
    // SPA fallback (200.html), as Cloudflare serves the generated app.
    if (!fs.existsSync(p)) p = path.join(root, '200.html')
    if (!fs.existsSync(p)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(p)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-cache',
    })
    fs.createReadStream(p).pipe(res)
  })
  .listen(port, '127.0.0.1', () =>
    console.log(`serving ${root} at http://127.0.0.1:${port}/`),
  )
