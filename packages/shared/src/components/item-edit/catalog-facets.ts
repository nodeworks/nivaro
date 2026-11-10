/**
 * Facet builder logic for the catalog picker (CatalogBuilderConfig with
 * `facets`): a source answers one row per catalog item with a value per facet
 * (e.g. color, end A, end B, kind) plus a result column (e.g. size). The
 * person picks facets in any order; every pick narrows the options of the
 * others, and once every facet holds a value the matching rows are listed by
 * their result column.
 *
 * `symmetric` names two facets whose order does not matter (the two ends of a
 * cable): a row matches picks {X, Y} when its two values are X and Y in
 * either order, and the options offered for one of the pair are the values
 * that can sit on the OTHER end of rows already matching the other picks.
 * Pure — no React, no I/O.
 */

export interface FacetDef {
  key: string
  label: string
}

export type FacetRow = Record<string, unknown>
export type FacetPicks = Record<string, string | undefined>

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** The pair a symmetric config names, when both facets exist. */
function pairOf(facets: FacetDef[], symmetric?: [string, string] | null): [string, string] | null {
  if (!symmetric || symmetric.length !== 2) return null
  const [a, b] = symmetric
  if (a === b) return null
  if (!facets.some((f) => f.key === a) || !facets.some((f) => f.key === b)) return null
  return [a, b]
}

/**
 * Does `row` satisfy every pick except `skip`? A symmetric pair is judged as
 * an unordered pair: picks for both → the row's two values are those two in
 * either order; a pick for one → either of the row's two values equals it.
 */
export function facetRowMatches(
  row: FacetRow,
  picks: FacetPicks,
  facets: FacetDef[],
  symmetric?: [string, string] | null,
  skip?: string
): boolean {
  const pair = pairOf(facets, symmetric)
  for (const f of facets) {
    if (f.key === skip) continue
    if (pair && (f.key === pair[0] || f.key === pair[1])) continue
    const want = picks[f.key]
    if (want && str(row[f.key]) !== want) return false
  }
  if (pair) {
    const [a, b] = pair
    const pa = skip === a ? undefined : picks[a]
    const pb = skip === b ? undefined : picks[b]
    const ra = str(row[a])
    const rb = str(row[b])
    if (pa && pb) {
      if (!((ra === pa && rb === pb) || (ra === pb && rb === pa))) return false
    } else if (pa || pb) {
      const one = (pa ?? pb) as string
      if (ra !== one && rb !== one) return false
    }
  }
  return true
}

const sortLabels = (values: Iterable<string>): string[] =>
  [...values].sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }))

/**
 * The values offered for one facet: every value it can take on rows matching
 * all the OTHER picks. For one of a symmetric pair the row's two ends are
 * read as "this end" and "the other end": with the partner picked, the
 * option is whatever sits opposite it; without, either end is an option.
 */
export function facetOptions(
  rows: FacetRow[],
  picks: FacetPicks,
  facets: FacetDef[],
  key: string,
  symmetric?: [string, string] | null
): string[] {
  const pair = pairOf(facets, symmetric)
  const out = new Set<string>()
  if (pair && (key === pair[0] || key === pair[1])) {
    const partner = key === pair[0] ? pair[1] : pair[0]
    const partnerPick = picks[partner]
    for (const row of rows) {
      // Judge every OTHER facet (both ends skipped), then the pair by hand.
      if (
        !facetRowMatches(
          row,
          { ...picks, [key]: undefined, [partner]: undefined },
          facets,
          symmetric
        )
      )
        continue
      const ra = str(row[pair[0]])
      const rb = str(row[pair[1]])
      if (partnerPick) {
        if (ra === partnerPick && rb) out.add(rb)
        if (rb === partnerPick && ra) out.add(ra)
      } else {
        if (ra) out.add(ra)
        if (rb) out.add(rb)
      }
    }
    return sortLabels(out)
  }
  for (const row of rows) {
    if (!facetRowMatches(row, picks, facets, symmetric, key)) continue
    const v = str(row[key])
    if (v) out.add(v)
  }
  return sortLabels(out)
}

/** Every facet holds a pick. */
export function facetsComplete(picks: FacetPicks, facets: FacetDef[]): boolean {
  return facets.length > 0 && facets.every((f) => !!picks[f.key])
}

/**
 * The rows matching every pick, ordered by `sortKey` (numeric when it reads
 * as a number), then by `labelKey`. Rows without an item id are dropped.
 */
export function facetResults(
  rows: FacetRow[],
  picks: FacetPicks,
  facets: FacetDef[],
  opts: { itemKey: string; labelKey: string; sortKey?: string; symmetric?: [string, string] | null }
): FacetRow[] {
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number.parseFloat(str(v))
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
  }
  return rows
    .filter((r) => str(r[opts.itemKey]) !== '' && facetRowMatches(r, picks, facets, opts.symmetric))
    .sort((x, y) => {
      if (opts.sortKey) {
        const d = num(x[opts.sortKey]) - num(y[opts.sortKey])
        if (d !== 0 && Number.isFinite(d)) return d
      }
      return str(x[opts.labelKey]).localeCompare(str(y[opts.labelKey]), undefined, {
        numeric: true
      })
    })
}

/** Picks after `key` changes: a value no longer offered on another facet drops. */
export function setFacetPick(
  rows: FacetRow[],
  picks: FacetPicks,
  facets: FacetDef[],
  key: string,
  value: string | null,
  symmetric?: [string, string] | null
): FacetPicks {
  const next: FacetPicks = { ...picks, [key]: value ?? undefined }
  // Drop any other pick the new value made impossible (one pass per facet,
  // repeated until stable — a drop can free nothing, only narrow).
  for (let pass = 0; pass < facets.length; pass++) {
    let changed = false
    for (const f of facets) {
      if (f.key === key || !next[f.key]) continue
      if (!facetOptions(rows, next, facets, f.key, symmetric).includes(next[f.key] as string)) {
        next[f.key] = undefined
        changed = true
      }
    }
    if (!changed) break
  }
  return next
}
