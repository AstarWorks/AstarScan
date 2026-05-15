/**
 * Canonical-key deduplication for business-card items.
 *
 * The signal we trust most across angle / lighting / blur variations: the
 * OCR'd phone numbers and email addresses. Two captures of the same physical
 * card always share at least one of these (modulo OCR errors). Visual hashes
 * (pHash / ORB / LightGlue) collapse on geometric drift; this doesn't.
 *
 * Strategy:
 *   1. For each item, compute a ranked list of canonical keys:
 *        - email[0] (lower-cased, whitespace stripped)
 *        - mobile or tel (digits only, +81 normalized to 0)
 *        - normalized name + company (last resort, OCR-error prone)
 *   2. Build a union-find over items: if any key matches, merge.
 *   3. Per cluster, pick the winner by score (composite from caller —
 *      typically Laplacian × area_fraction).
 *
 * Output: array of clusters [{ winner, members: [item_id, ...] }].
 */

// ---- key normalization -----------------------------------------------------

const ZEN2HAN_DIGIT = (s) =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))

function normPhone(p) {
  if (!p) return null
  let d = ZEN2HAN_DIGIT(String(p)).replace(/\D/g, '')
  if (d.startsWith('81') && d.length >= 11) d = '0' + d.slice(2)
  // Strip leading country code if explicit
  d = d.replace(/^\+/, '')
  return d || null
}

function normEmail(e) {
  if (!e) return null
  return String(e).trim().toLowerCase().replace(/\s+/g, '') || null
}

function normName(n) {
  if (!n) return null
  // Strip spaces, normalize digits, lower-case, drop common honorifics
  return String(n)
    .replace(/\s+/g, '')
    .replace(/様|殿|さん/g, '')
    .toLowerCase()
}

/**
 * Returns canonical keys in priority order. Each is a `<type>:<value>` string.
 *
 * `fields` shape: { name?, company?, email?, tel?, fax?, mobile?, ... }
 */
export function canonicalKeys(fields) {
  const keys = []
  const email = normEmail(fields?.email)
  if (email) keys.push(`email:${email}`)

  const mobile = normPhone(fields?.mobile)
  if (mobile) keys.push(`phone:${mobile}`)

  const tel = normPhone(fields?.tel)
  if (tel && tel !== mobile) keys.push(`phone:${tel}`)

  const fax = normPhone(fields?.fax)
  if (fax && fax !== mobile && fax !== tel) keys.push(`phone:${fax}`)

  const name = normName(fields?.name)
  const company = normName(fields?.company)
  if (name && company) keys.push(`name+company:${name}|${company}`)

  return keys
}

// ---- union-find ------------------------------------------------------------

class UnionFind {
  constructor() {
    this.parent = new Map()
  }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x)
    let root = x
    while (this.parent.get(root) !== root) root = this.parent.get(root)
    let cur = x
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

/**
 * Cluster items by shared canonical keys.
 *
 * @param {Array<{id, fields, score?}>} items
 * @returns {Array<{winner_id, member_ids, dropped_ids, key}>}
 *
 * `score` is bigger-is-better; default 0.
 */
export function clusterByCanonicalKey(items) {
  const uf = new UnionFind()
  const keyToItem = new Map() // key -> first item.id seen

  for (const item of items) {
    uf.find(item.id) // ensure registered
    for (const k of canonicalKeys(item.fields)) {
      const prior = keyToItem.get(k)
      if (prior !== undefined) {
        uf.union(item.id, prior)
      } else {
        keyToItem.set(k, item.id)
      }
    }
  }

  const groups = new Map() // root -> { members: Set, repr_key? }
  for (const item of items) {
    const root = uf.find(item.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(item)
  }

  const clusters = []
  for (const [, members] of groups) {
    members.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    const winner = members[0]
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

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const items = [
    {
      id: 'frame-100',
      score: 80,
      fields: { name: '込田友紀子', mobile: '090-5516-1153', tel: '03-3609-3446' },
    },
    {
      id: 'frame-120', // same card, different angle
      score: 95,
      fields: { name: '込田友紀子', mobile: '09055161153', email: null },
    },
    {
      id: 'frame-300',
      score: 70,
      fields: { name: '野口明雄', email: 'akionoguchi7@gmail.com', mobile: '080-2673-6319' },
    },
    {
      id: 'frame-310', // same as 300, different OCR error on name
      score: 90,
      fields: { name: '野口 明雄', email: 'AkioNoguchi7@gmail.com' },
    },
    {
      id: 'frame-500', // distinct card
      score: 50,
      fields: { name: '佐藤一郎', email: 'sato@example.com' },
    },
  ]

  const clusters = clusterByCanonicalKey(items)
  for (const c of clusters) {
    console.log(c)
  }
}
