/**
 * Render `summary.html` for an eval run.
 *
 * The HTML is a single self-contained file showing each cluster as a
 * row: winner thumbnail with green border + score, members as smaller
 * thumbnails, and intra/inter-cluster Hamming distances so we can see
 * at a glance whether the failure mode is oversplit (low inter-winner
 * distances → same page in two clusters) or undersplit (high intra
 * distances → different pages merged).
 */

import path from 'node:path'

function escape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function renderSummaryHtml({
  mp4,
  params,
  summary,
  clusters,
  hammingFn,
  distKey = 'hash',
  acceptedRelDir,
}) {
  const css = `
body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 16px; max-width: 1400px; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 14px; margin: 18px 0 8px; }
.params { background: #1e293b; padding: 8px 12px; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.6; }
.cluster { background: #1e293b; padding: 12px; border-radius: 8px; margin-bottom: 12px; }
.cluster-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; font-size: 12px; font-family: ui-monospace, monospace; }
.cluster-id { font-weight: bold; font-size: 14px; color: #38bdf8; }
.cluster-stats { color: #94a3b8; }
.warn { color: #fb923c; }
.bad { color: #f87171; }
.good { color: #4ade80; }
.thumbs { display: flex; gap: 6px; flex-wrap: wrap; }
.thumb { position: relative; }
.thumb img { width: 96px; height: 128px; object-fit: cover; border-radius: 4px; display: block; border: 2px solid transparent; }
.thumb.winner img { border-color: #4ade80; }
.thumb-label { position: absolute; bottom: 2px; left: 2px; background: rgba(0,0,0,0.7); color: #fff; font-size: 10px; padding: 1px 4px; border-radius: 2px; font-family: ui-monospace, monospace; }
.legend { font-size: 11px; color: #64748b; margin: 4px 0 12px; }
table { border-collapse: collapse; font-size: 11px; font-family: ui-monospace, monospace; margin-top: 8px; }
td, th { padding: 2px 6px; border: 1px solid #334155; text-align: right; }
th { background: #334155; }
.matrix-cell-low { color: #f87171; font-weight: bold; }
`
  const lines = []
  lines.push(`<!doctype html><html><head><meta charset="utf-8"><title>${escape(path.basename(mp4))} eval</title><style>${css}</style></head><body>`)
  lines.push(`<h1>${escape(path.basename(mp4))}</h1>`)
  lines.push(`<div class="params">`)
  lines.push(`mp4 = ${escape(mp4)}<br>`)
  for (const [k, v] of Object.entries(params)) {
    lines.push(`${escape(k)} = ${escape(v)}<br>`)
  }
  lines.push(`sampled=${summary.sampled} detected=${summary.detected} accepted=${summary.accepted} winners=${summary.winners}`)
  if (summary.gt != null) {
    const sign = summary.absError === 0 ? 'good' : summary.absError <= 2 ? 'warn' : 'bad'
    lines.push(` <span class="${sign}">GT=${summary.gt} abs_error=${summary.absError}</span>`)
  }
  lines.push(`</div>`)

  // Inter-winner hamming matrix — flags oversplit (low values = same page in two clusters)
  if (clusters.length >= 2) {
    lines.push(`<h2>Inter-winner Hamming (oversplit detector — low = same page in different clusters)</h2>`)
    lines.push(`<table><tr><th></th>`)
    for (let i = 0; i < clusters.length; i += 1) {
      lines.push(`<th>C${i + 1}</th>`)
    }
    lines.push(`</tr>`)
    for (let i = 0; i < clusters.length; i += 1) {
      lines.push(`<tr><th>C${i + 1}</th>`)
      for (let j = 0; j < clusters.length; j += 1) {
        if (j < i) {
          lines.push(`<td>·</td>`)
        } else if (j === i) {
          lines.push(`<td>—</td>`)
        } else {
          const d = hammingFn(clusters[i].winner[distKey], clusters[j].winner[distKey])
          const cls = d < 70 ? 'matrix-cell-low' : ''
          lines.push(`<td class="${cls}">${d}</td>`)
        }
      }
      lines.push(`</tr>`)
    }
    lines.push(`</table>`)
    lines.push(`<div class="legend">red &lt; 70: two clusters with hashes this close are likely the same page. The current cluster threshold is ${params.clusterThr}.</div>`)
  }

  lines.push(`<h2>Clusters</h2>`)
  for (let i = 0; i < clusters.length; i += 1) {
    const c = clusters[i]
    const intraDistances = c.members
      .filter((m) => m.idx !== c.winner.idx)
      .map((m) => hammingFn(m[distKey], c.winner[distKey]))
    const intraMin = intraDistances.length ? Math.min(...intraDistances) : 0
    const intraMax = intraDistances.length ? Math.max(...intraDistances) : 0
    const intraMean = intraDistances.length
      ? (intraDistances.reduce((s, x) => s + x, 0) / intraDistances.length).toFixed(1)
      : '–'
    lines.push(`<div class="cluster">`)
    lines.push(`<div class="cluster-head">`)
    lines.push(`<span class="cluster-id">C${i + 1}</span>`)
    lines.push(`<span class="cluster-stats">members=${c.members.length} winner_idx=${c.winner.idx} winner_score=${c.winner.score.toFixed(3)} intra_hamming(min/mean/max)=${intraMin}/${intraMean}/${intraMax}</span>`)
    lines.push(`</div>`)
    lines.push(`<div class="thumbs">`)
    for (const m of c.members) {
      const isWinner = m.idx === c.winner.idx
      const label = `f${m.idx} s=${m.score.toFixed(2)}`
      lines.push(
        `<div class="thumb${isWinner ? ' winner' : ''}">` +
          `<img src="${acceptedRelDir}/frame-${String(m.idx).padStart(5, '0')}.jpg" alt="frame ${m.idx}">` +
          `<div class="thumb-label">${escape(label)}</div></div>`,
      )
    }
    lines.push(`</div>`)
    lines.push(`</div>`)
  }
  lines.push(`</body></html>`)
  return lines.join('\n')
}
