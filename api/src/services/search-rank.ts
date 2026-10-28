/**
 * Global-search ranking (search program 2026-10-28, items 1/4/5/6). Pure.
 *
 * One score per hit, highest first:
 *   exact id / number       1000
 *   equals the phrase        300
 *   starts with it           200
 *   a word starts with it    160
 *   contains it              100
 *   near spelling          20–60   (typo pass, by trigram similarity)
 * plus boosts that only ever reorder hits the caller could already see:
 *   mine (created, owns, opened recently)            +40
 *   learned (people opened it for this same query)   up to +55
 */

export type MatchTier = 'exact' | 'equal' | 'prefix' | 'word' | 'contains' | 'fuzzy'

export const TIER_BASE: Record<MatchTier, number> = {
  exact: 1000,
  equal: 300,
  prefix: 200,
  word: 160,
  contains: 100,
  fuzzy: 20
}

export const MINE_BOOST = 40
export const LEARNED_MAX = 55

/** How a value matches the phrase (or one of its synonym forms), best first. */
export function matchTier(value: unknown, forms: string[]): MatchTier | null {
  if (value == null || typeof value === 'object') return null
  const v = String(value).toLowerCase().trim()
  if (!v) return null
  let best: MatchTier | null = null
  const order: MatchTier[] = ['equal', 'prefix', 'word', 'contains']
  for (const raw of forms) {
    const f = raw.toLowerCase().trim()
    if (!f) continue
    let t: MatchTier | null = null
    if (v === f) t = 'equal'
    else if (v.startsWith(f)) t = 'prefix'
    else if (new RegExp(`(^|[^a-z0-9])${escapeRe(f)}`).test(v)) t = 'word'
    else if (v.includes(f)) t = 'contains'
    if (t && (best == null || order.indexOf(t) < order.indexOf(best))) best = t
  }
  return best
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Learned boost from how many different people opened this record for this query. */
export function learnedBoost(people: number): number {
  if (!(people > 0)) return 0
  return Math.min(LEARNED_MAX, Math.round(20 * Math.log2(1 + people)))
}

export function scoreHit(h: {
  tier: MatchTier
  /** 0..1, typo pass only. */
  similarity?: number
  mine?: boolean
  learned?: number
}): number {
  let s = TIER_BASE[h.tier]
  if (h.tier === 'fuzzy') s += Math.round(40 * Math.max(0, Math.min(1, h.similarity ?? 0)))
  if (h.mine) s += MINE_BOOST
  s += learnedBoost(h.learned ?? 0)
  return s
}

/** Highest score first; ties go to the shorter label (closer to what was typed). */
export function rankHits<T extends { score?: number; label: string }>(hits: T[]): T[] {
  return [...hits].sort((a, b) => {
    const d = (b.score ?? 0) - (a.score ?? 0)
    return d !== 0 ? d : a.label.length - b.label.length
  })
}

// ─── Exact id ─────────────────────────────────────────────────────────────────

/** Looks like something a person pastes from a record: one token, has a digit,
 *  id-ish characters only (`AB26-77260`, `B1234-2`, `368808`, `PO-00042`). */
export function looksLikeId(q: string): boolean {
  const t = q.trim()
  return /^[A-Za-z0-9][A-Za-z0-9\-_/.#]{1,39}$/.test(t) && /\d/.test(t)
}

/** A string column that holds a business identifier (`workflow_id`, `po_number`, `mwf_id`). */
export function isIdColumn(name: string): boolean {
  return name !== 'id' && /(_id|_number|_num|_no|^number)$/i.test(name)
}

/** A NUMERIC column that holds a number people quote (`po_number`) — never `*_id`
 *  (numeric `_id` columns are foreign keys: "123" would match every child of 123). */
export function isNumericIdColumn(name: string): boolean {
  return /(_number|_num|_no|^number)$/i.test(name)
}

// ─── Typo tolerance ───────────────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export function trigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (const word of norm(s).split(' ')) {
    if (!word) continue
    const w = ` ${word} `
    for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3))
  }
  return out
}

/** Dice coefficient over trigrams, against the best-matching window of the value
 *  (a typo in one word of a long name still scores). 0..1. */
export function similarity(q: string, value: string): number {
  const a = trigrams(q)
  if (a.size === 0) return 0
  const words = norm(value).split(' ').filter(Boolean)
  const qWords = Math.max(1, norm(q).split(' ').filter(Boolean).length)
  let best = 0
  for (let i = 0; i < Math.max(1, words.length - qWords + 1); i++) {
    const b = trigrams(words.slice(i, i + qWords).join(' '))
    if (b.size === 0) continue
    let common = 0
    for (const g of a) if (b.has(g)) common++
    best = Math.max(best, (2 * common) / (a.size + b.size))
  }
  return best
}

export const FUZZY_MIN_SIMILARITY = 0.35
export const FUZZY_MAX_CHUNKS = 8

/** The 3-letter chunks the SQL typo pass LIKEs for, and how many must hit. Inner
 *  chunks only (no padding) so each is a plain `%abc%`; evenly thinned to a cap. */
export function fuzzyChunks(q: string): { chunks: string[]; need: number } {
  const all: string[] = []
  for (const word of norm(q).split(' ')) {
    for (let i = 0; i + 3 <= word.length; i++) {
      const c = word.slice(i, i + 3)
      if (!all.includes(c)) all.push(c)
    }
  }
  let chunks = all
  if (all.length > FUZZY_MAX_CHUNKS) {
    const step = all.length / FUZZY_MAX_CHUNKS
    chunks = Array.from({ length: FUZZY_MAX_CHUNKS }, (_, i) => all[Math.floor(i * step)])
  }
  // A typo breaks at most ~3 chunks; ask for about half of them.
  const need = chunks.length <= 2 ? chunks.length : Math.max(2, Math.ceil(chunks.length * 0.5))
  return { chunks, need }
}

/** A query worth a typo pass: words (≥4 letters somewhere), not an id. */
export function wantsFuzzy(q: string): boolean {
  return q.trim().length >= 4 && /[a-z]{4}/i.test(q) && !looksLikeId(q)
}
