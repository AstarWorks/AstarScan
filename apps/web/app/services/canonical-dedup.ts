/**
 * Canonical-key deduplication for business-card items.
 *
 * TS port of `scripts/eval/lib/canonical-dedup.mjs`. The signal we trust
 * most across angle / lighting / blur variations: the OCR'd phone numbers
 * and email addresses. Two captures of the same physical card always share
 * at least one of these (modulo OCR errors).
 *
 * Same-email merge is unconditional. Same-phone merge is gated on company
 * and email compatibility so that 込田友紀子's BuonVento COO card and
 * 中野組商事 取締役 card (both list 090-5516-1153 but they are different
 * physical cards) stay separate. See `companiesCompatible()` for the
 * decision table.
 */

export interface CanonicalFields {
  readonly name?: string | null
  readonly company?: string | null
  readonly email?: string | null
  readonly tel?: string | null
  readonly fax?: string | null
  readonly mobile?: string | null
}

export interface DedupInput {
  readonly id: string
  readonly fields: CanonicalFields
  readonly score?: number
}

export interface DedupCluster {
  readonly winner_id: string
  readonly member_ids: readonly string[]
  readonly dropped_ids: readonly string[]
  readonly key: string | null
}

function normPhone(p: string | null | undefined): string | null {
  if (!p) return null
  let d = String(p)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '')
  if (d.startsWith('81') && d.length >= 11) d = '0' + d.slice(2)
  return d || null
}

function normEmail(e: string | null | undefined): string | null {
  if (!e) return null
  const s = String(e).trim().toLowerCase().replace(/\s+/g, '')
  return s || null
}

function normName(n: string | null | undefined): string | null {
  if (!n) return null
  return String(n)
    .replace(/\s+/g, '')
    .replace(/様|殿|さん/g, '')
    .toLowerCase()
}

export function canonicalKeys(fields: CanonicalFields): string[] {
  const keys: string[] = []
  const email = normEmail(fields.email)
  if (email) keys.push(`email:${email}`)

  const mobile = normPhone(fields.mobile)
  if (mobile) keys.push(`phone:${mobile}`)

  const tel = normPhone(fields.tel)
  if (tel && tel !== mobile) keys.push(`phone:${tel}`)

  const fax = normPhone(fields.fax)
  if (fax && fax !== mobile && fax !== tel) keys.push(`phone:${fax}`)

  const name = normName(fields.name)
  const company = normName(fields.company)
  if (name && company) keys.push(`name+company:${name}|${company}`)

  return keys
}

class UnionFind {
  readonly #parent = new Map<string, string>()

  find(x: string): string {
    if (!this.#parent.has(x)) this.#parent.set(x, x)
    let root = x
    while (this.#parent.get(root)! !== root) root = this.#parent.get(root)!
    let cur = x
    while (this.#parent.get(cur)! !== root) {
      const next = this.#parent.get(cur)!
      this.#parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.#parent.set(ra, rb)
  }
}

function companiesCompatible(a: CanonicalFields, b: CanonicalFields): boolean {
  const ea = normEmail(a.email)
  const eb = normEmail(b.email)
  if (ea && eb) return ea === eb // emails contradict or match

  const ca = normName(a.company)
  const cb = normName(b.company)

  // Asymmetric: one side has email, the other has a real company
  if (ea && cb) return false
  if (eb && ca) return false

  if (ca && cb) {
    if (ca === cb) return true
    if (ca.includes(cb) || cb.includes(ca)) return true
    return false
  }

  return true
}

export function clusterByCanonicalKey(items: DedupInput[]): DedupCluster[] {
  const uf = new UnionFind()
  const byId = new Map<string, DedupInput>()
  for (const it of items) {
    byId.set(it.id, it)
    uf.find(it.id)
  }

  const keyIndex = new Map<string, string[]>()
  for (const item of items) {
    for (const k of canonicalKeys(item.fields)) {
      if (!keyIndex.has(k)) keyIndex.set(k, [])
      keyIndex.get(k)!.push(item.id)
    }
  }

  for (const [key, ids] of keyIndex) {
    if (ids.length < 2) continue
    if (key.startsWith('email:') || key.startsWith('name+company:')) {
      for (let i = 1; i < ids.length; i++) uf.union(ids[0]!, ids[i]!)
    } else if (key.startsWith('phone:')) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = byId.get(ids[i]!)!
          const b = byId.get(ids[j]!)!
          if (companiesCompatible(a.fields, b.fields)) {
            uf.union(ids[i]!, ids[j]!)
          }
        }
      }
    }
  }

  const groups = new Map<string, DedupInput[]>()
  for (const item of items) {
    const root = uf.find(item.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(item)
  }

  const clusters: DedupCluster[] = []
  for (const [, members] of groups) {
    members.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const winner = members[0]!
    const dropped = members.slice(1)
    const winnerKeys = canonicalKeys(winner.fields)
    clusters.push({
      winner_id: winner.id,
      member_ids: members.map((m) => m.id),
      dropped_ids: dropped.map((m) => m.id),
      key: winnerKeys[0] ?? null,
    })
  }
  return clusters
}
