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
 *
 * Cards are keyed by their *strongest* unique identifier. Email beats phone
 * (less likely to collide across a person's multiple cards); phone is used
 * only when email is missing on either side. name+company is the last resort.
 *
 * The exception: a person may have multiple physical cards for different
 * roles (e.g. 込田友紀子's BuonVento COO card AND 中野組商事 取締役 card,
 * which both list mobile 090-5516-1153 but are clearly different cards).
 * The caller (`clusterByCanonicalKey`) considers company/name when deciding
 * to merge on a phone-only key.
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
 * Same-email items always merge (an email uniquely identifies a person at
 * one role).
 *
 * Same-phone items merge ONLY IF the companies are compatible (both null,
 * both equal after normalization, or one is a substring of the other).
 * This is the "込田友紀子 has two cards with shared mobile but different
 * companies" case — they are physically distinct cards and must be kept
 * separate.
 *
 * name+company keys behave like other keys.
 *
 * @param {Array<{id, fields, score?}>} items
 * @returns {Array<{winner_id, member_ids, dropped_ids, key}>}
 */
export function clusterByCanonicalKey(items) {
  const uf = new UnionFind()
  const byId = new Map()
  for (const it of items) {
    byId.set(it.id, it)
    uf.find(it.id) // register
  }

  // Build {key -> ids[]} index then apply per-key merge rules.
  const keyIndex = new Map()
  for (const item of items) {
    for (const k of canonicalKeys(item.fields)) {
      if (!keyIndex.has(k)) keyIndex.set(k, [])
      keyIndex.get(k).push(item.id)
    }
  }

  for (const [key, ids] of keyIndex) {
    if (ids.length < 2) continue
    if (key.startsWith('email:') || key.startsWith('name+company:')) {
      // Unconditional merge
      for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i])
    } else if (key.startsWith('phone:')) {
      // Only merge phone-keyed pairs when companies are compatible.
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = byId.get(ids[i])
          const b = byId.get(ids[j])
          if (companiesCompatible(a.fields, b.fields)) {
            uf.union(ids[i], ids[j])
          }
        }
      }
    }
  }

  const groups = new Map()
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

/**
 * Decide whether two items that share a phone number are the SAME physical
 * card or two different cards of the same person (e.g. 込田友紀子's
 * BuonVento COO card vs her 中野組商事 取締役 card both list 090-5516-1153).
 *
 * Rules (ordered):
 *   1. Emails on both sides:
 *      - match            → same card
 *      - differ           → different cards
 *   2. Email on EXACTLY one side and the other has a real company:
 *      → different cards (the email-bearing card is one identity; the
 *        company-bearing-but-no-email side is another identity)
 *   3. Companies on both sides:
 *      - match (or one is substring of the other) → same card
 *      - clearly differ                          → different cards
 *   4. Otherwise (mostly empty fields) → assume same card.
 *
 * The "(株)/(有)" trailing label dropouts that the heuristic sometimes
 * makes mean we compare on normalized substring containment.
 */
function companiesCompatible(a, b) {
  const ea = normEmail(a?.email)
  const eb = normEmail(b?.email)
  if (ea && eb) return ea === eb // rule 1

  const ca = normName(a?.company)
  const cb = normName(b?.company)

  // Rule 2: asymmetric email vs company
  if (ea && cb) return false
  if (eb && ca) return false

  // Rule 3: both companies present
  if (ca && cb) {
    if (ca === cb) return true
    if (ca.includes(cb) || cb.includes(ca)) return true
    return false
  }

  // Rule 4: nothing strong enough to discriminate
  return true
}

// ---- CLI smoke test --------------------------------------------------------
if (import.meta.main) {
  const items = [
    {
      id: 'frame-100',
      score: 80,
      fields: {
        name: '込田友紀子',
        mobile: '090-5516-1153',
        tel: '03-3609-3446',
      },
    },
    {
      id: 'frame-120', // same card, different angle
      score: 95,
      fields: { name: '込田友紀子', mobile: '09055161153', email: null },
    },
    {
      id: 'frame-300',
      score: 70,
      fields: {
        name: '野口明雄',
        email: 'akionoguchi7@gmail.com',
        mobile: '080-2673-6319',
      },
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
