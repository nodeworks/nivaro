// Picker options that render the same label ("CEG 1" twice) get a secondary
// detail so a person can tell them apart. Pure — unit-tested directly.

import { titleCase } from '../../lib/utils'

/** Ids of options whose label is shared with at least one other option. */
export function collidingIds(
  items: Array<Record<string, unknown>>,
  labelOf: (item: Record<string, unknown>) => string
): string[] {
  const byLabel = new Map<string, string[]>()
  for (const item of items) {
    const key = labelOf(item).trim().toLowerCase()
    const ids = byLabel.get(key)
    if (ids) ids.push(String(item.id))
    else byLabel.set(key, [String(item.id)])
  }
  return [...byLabel.values()].filter((ids) => ids.length > 1).flat()
}

// Bookkeeping columns never tell two records apart in a way a person reads.
const SKIP = new Set([
  'id',
  'sort',
  'date_created',
  'date_updated',
  'user_created',
  'user_updated',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by'
])
const PREFERRED = /(^|_)(system_id|code|number|no|key|name|type|status)$/i

function readable(v: unknown): string | null {
  if (v === null || v === undefined || typeof v === 'object') return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** For each group of same-label rows, the one column that best tells them
 *  apart (most distinct values; then names like system_id, then text over
 *  bare numbers, which are usually foreign keys) and each row's value of it,
 *  as "System Id: 4471". Rows of a group nothing separates get `#id`.
 *  Returns id → detail text. */
export function disambiguators(
  groups: Array<Array<Record<string, unknown>>>,
  skipKeys: string[] = []
): Map<string, string> {
  const out = new Map<string, string>()
  const skip = new Set([...SKIP, ...skipKeys])
  for (const rows of groups) {
    if (rows.length < 2) continue
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter(
      (k) => !skip.has(k) && !k.startsWith('_')
    )
    let best: { key: string; distinct: number; preferred: boolean; text: boolean } | null = null
    for (const key of keys) {
      const values = rows.map((r) => readable(r[key]))
      if (values.some((v) => v === null)) continue
      const distinct = new Set(values).size
      if (distinct < 2) continue
      const preferred = PREFERRED.test(key)
      const text = rows.some((r) => typeof r[key] === 'string')
      const better =
        !best ||
        distinct > best.distinct ||
        (distinct === best.distinct &&
          (preferred !== best.preferred ? preferred : text && !best.text))
      if (better) best = { key, distinct, preferred, text }
    }
    for (const r of rows) {
      const id = String(r.id)
      out.set(id, best ? `${titleCase(best.key)}: ${readable(r[best.key])}` : `#${id}`)
    }
  }
  return out
}
