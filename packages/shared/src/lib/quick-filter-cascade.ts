import type { QueryClient } from '@tanstack/react-query'
import { get } from './commands'

/**
 * Header filters cascade the way a record form's pickers do: picking Zone 1 leaves the Region
 * filter offering only Zone 1's regions. A filter's options (rows of its own collection, e.g.
 * `regions`) are narrowed by every OTHER filter that has picks, through a many-to-one field on
 * the options' collection that points at the other filter's collection (`regions.division` →
 * `divisions`). When the two collections link both ways (`divisions.division_region` →
 * `regions` too), the link the parent declares as its list of children (`divisions.regions`, the
 * relation's one_field) is the hierarchy; the other one (one office region per zone) never
 * narrows, or picking a region would hide every zone but the one whose office it is.
 *
 * The narrowing is curation, not security: options are still read as the viewer.
 */

export interface CascadeRelation {
  many_collection: string
  many_field: string
  one_collection: string | null
  /** The alias the "one" side declares for its list of children, when it has one. */
  one_field?: string | null
  junction_field?: string | null
}

/** Another filter's picks: rows of `collection` whose `field` is one of `values`. */
export interface CascadeSelection {
  collection: string
  /** 'id' when the picks are row ids; otherwise the column the picks are values of (a display field). */
  field: string
  values: Array<string | number>
}

/**
 * The items filter that narrows `collection`'s options by the other filters' picks, or null
 * when none of them is linked to it (or none has picks).
 */
export function cascadeFilter(
  collection: string,
  relations: CascadeRelation[],
  selections: CascadeSelection[]
): Record<string, unknown> | null {
  const clauses: Array<Record<string, unknown>> = []
  for (const sel of selections) {
    if (sel.values.length === 0 || sel.collection === collection) continue
    const rel = relations.find(
      (r) =>
        r.many_collection === collection &&
        r.one_collection === sel.collection &&
        !r.junction_field &&
        !!r.many_field
    )
    if (!rel) continue
    const reverse = relations.find(
      (r) =>
        r.many_collection === sel.collection && r.one_collection === collection && !r.junction_field
    )
    if (reverse && reverse.one_field && !rel.one_field) continue
    clauses.push({
      [rel.many_field]:
        sel.field === 'id' ? { _in: sel.values } : { [sel.field]: { _in: sel.values } }
    })
  }
  if (clauses.length === 0) return null
  return clauses.length === 1 ? clauses[0] : { _and: clauses }
}

/** Relations of one collection (sign-in only route), cached for ten minutes. */
export function fetchCascadeRelations(
  client: { request: <T>(cmd: ReturnType<typeof get<T>>) => Promise<T> },
  qc: QueryClient,
  collection: string
): Promise<CascadeRelation[]> {
  return qc.fetchQuery({
    queryKey: ['cascade-relations', collection],
    queryFn: () =>
      client
        .request<{ data: CascadeRelation[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => r.data ?? [])
        .catch(() => [] as CascadeRelation[]),
    staleTime: 10 * 60_000
  })
}
