/**
 * Dev-only endpoint for dumping browser-side debug state to disk so it
 * can be inspected outside the browser (e.g. by a CLI tool or a coding
 * agent reading from the filesystem).
 *
 * Writes two files into <repo-root>/eval-out/browser/:
 *   - latest.json       (always overwritten — easy path to recall)
 *   - <ISO-ts>.json     (kept for history)
 *
 * Nuxt's nitro preset is `static` so this route is NOT shipped in the
 * production build. It exists only during `bun dev` for local debugging.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export default defineEventHandler(async (event) => {
  const body = await readRawBody(event, false)
  if (!body || body.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'empty body' })
  }

  // apps/web → repo root → eval-out/browser
  const dir = resolve(process.cwd(), '..', '..', 'eval-out', 'browser')
  await mkdir(dir, { recursive: true })

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, -1)
  const latestPath = resolve(dir, 'latest.json')
  const histPath = resolve(dir, `${stamp}.json`)

  const bytes = body instanceof Buffer ? body : Buffer.from(body)
  await writeFile(latestPath, bytes)
  await writeFile(histPath, bytes)

  return {
    ok: true,
    latestPath,
    histPath,
    bytes: bytes.length,
  }
})
