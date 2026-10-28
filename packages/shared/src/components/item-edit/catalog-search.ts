import { matchesSearch, searchRankTier } from '../../lib/search-text'

/**
 * Catalog picker search order (2026-10-28, search program #20). Pure, so the
 * order is tested without rendering the picker.
 */

type Row = Record<string, unknown>

const textOf = (v: unknown) => (v == null || typeof v === 'object' ? '' : String(v))

/** The row's shown fields hold every searched word (else it matched on another column). */
export function rowMatchesFields(row: Row, fields: string[], q: string): boolean {
  if (fields.length === 0) return false
  return matchesSearch(fields.map((f) => textOf(row[f])).join('\u0001'), q)
}

/** Rank tier of a row over its shown fields (search-text `searchRankTier`); 6 = not a shown match. */
export function catalogRowTier(row: Row, fields: string[], q: string): number {
  if (!rowMatchesFields(row, fields, q)) return 6
  return searchRankTier(
    fields.map((f) => row[f]),
    q
  )
}

/**
 * One result list from the three searches: an exact hit on the primary shown
 * field (the item number) first, then the person's recent picks, then the
 * shown-field matches by rank tier, then matches only in other columns. Each
 * band keeps the server's order inside a tier; duplicates keep their first place.
 */
export function orderCatalogMatches({
  shown,
  other,
  recent,
  shownFields,
  q
}: {
  shown: Row[]
  other: Row[]
  recent: Row[]
  shownFields: string[]
  q: string
}): Row[] {
  const ranked = (rows: Row[]) =>
    rows
      .map((r, i) => ({ r, i, t: catalogRowTier(r, shownFields, q) }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
  const shownRanked = ranked(shown)
  const recentRanked = ranked(recent)
  const out: Row[] = []
  const seen = new Set<string>()
  const add = (r: Row) => {
    const id = String(r.id)
    if (seen.has(id)) return
    seen.add(id)
    out.push(r)
  }
  for (const x of shownRanked) if (x.t === 0) add(x.r)
  for (const x of recentRanked) if (x.t === 0) add(x.r)
  for (const x of recentRanked) add(x.r)
  for (const x of shownRanked) add(x.r)
  for (const r of other) add(r)
  return out
}
