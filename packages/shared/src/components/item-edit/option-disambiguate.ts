// Picker options that render the same label ("CEG 1" twice) get a secondary
// detail so a person can tell them apart. Pure — unit-tested directly.

import { formatDateTime, titleCase } from '../../lib/utils'

/** A rendered option label with no letter or digit in it ("", "-", " / ") —
 *  the row's display fields are all empty. Such a row has nothing a person
 *  can recognise it by, so pickers never offer it (army8 b01: a nameless
 *  location listed as "#5331" was picked by a stray click and saved as a
 *  ship-to). */
export function isNamelessLabel(label: string | null | undefined): boolean {
  return !/[\p{L}\p{N}]/u.test(label ?? '')
}

/** What a picker shows for a value whose row renders no name. Never the id. */
export const NAMELESS_LABEL = 'Unnamed record'

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
  'updated_by',
  'created',
  'changed',
  'modified'
])
const PREFERRED = /(^|_)(system_id|code|number|no|key|name|type|status)$/i

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/

function readable(v: unknown): string | null {
  if (v === null || v === undefined || typeof v === 'object') return null
  const s = String(v).trim()
  if (s === '') return null
  // A raw ISO timestamp is not something a person reads (army8 b01:
  // "Created: 2026-09-07T10:32:53.821Z").
  return ISO_TIMESTAMP.test(s) ? formatDateTime(s) : s
}

/** For each group of same-label rows, the one column that best tells them
 *  apart (most distinct values; then names like system_id, then text over
 *  bare numbers, which are usually foreign keys) and each row's value of it,
 *  as "System Id: 4471". Rows of a group nothing separates get "Same name · 1 of 2".
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
    rows.forEach((r, i) => {
      const id = String(r.id)
      // Nothing tells them apart: say so in words, never the internal id.
      out.set(
        id,
        best
          ? `${titleCase(best.key)}: ${readable(r[best.key])}`
          : `Same name · ${i + 1} of ${rows.length}`
      )
    })
  }
  return out
}
