import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { titleCase } from '../../lib/utils'

/**
 * What a quick filter can filter BY: the relations out of a collection, and
 * where each one lands. The server walks a quick filter's path the same way
 * (services/items.ts planConditionPath): an M2O column follows its FK, an
 * O2M alias lands on the child, and an M2M alias continues through the
 * junction to the junction's target — so a deeper segment after an M2M alias
 * names a field on the TARGET, never on the junction table.
 */

export interface FacetField {
  field: string
  type?: string
  hidden?: boolean
}
export interface FacetRelation {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}
export interface FacetMeta {
  collection?: string
  display_name?: string | null
  display_template?: string | null
  fields?: FacetField[]
  relations?: FacetRelation[]
}

export interface FacetHop {
  field: string
  /** 'one' = the record points at one (M2O); 'many' = it holds a list (O2M / M2M). */
  kind: 'one' | 'many'
  /** Where the options come from when the filter stops here. */
  target: string
  /** True when the junction is in the way (M2M). */
  junction: boolean
}

export function facetHops(meta: FacetMeta | null | undefined, collection: string): FacetHop[] {
  if (!meta) return []
  const rels = meta.relations ?? []
  const out: FacetHop[] = []
  const seen = new Set<string>()
  for (const r of rels) {
    // M2O: this collection holds the FK.
    if (r.many_collection === collection && r.one_collection && r.many_field) {
      if (seen.has(r.many_field) || r.many_field.startsWith('__')) continue
      seen.add(r.many_field)
      out.push({ field: r.many_field, kind: 'one', target: r.one_collection, junction: false })
    }
  }
  for (const r of rels) {
    // Alias (O2M / M2M): another table points back at this one.
    if (r.one_collection !== collection || !r.one_field || seen.has(r.one_field)) continue
    if (r.one_field.startsWith('__')) continue
    let target = r.many_collection
    if (r.junction_field) {
      const leg = rels.find(
        (o) =>
          o.many_collection === r.many_collection &&
          o.many_field === r.junction_field &&
          o.one_collection
      )
      if (leg?.one_collection) target = leg.one_collection
    }
    seen.add(r.one_field)
    out.push({ field: r.one_field, kind: 'many', target, junction: !!r.junction_field })
  }
  return out.sort((a, b) => a.field.localeCompare(b.field))
}

const LABEL_CANDIDATES = ['name', 'title', 'label', 'display_name', 'year', 'code', 'type']

/** The column a target's options are best shown by: its display template, then a usual name. */
export function guessLabelField(meta: FacetMeta | null | undefined): string {
  const fields = (meta?.fields ?? []).filter((f) => !f.field.startsWith('__'))
  const names = new Set(fields.map((f) => f.field))
  const fromTemplate = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/.exec(meta?.display_template ?? '')
  if (fromTemplate && names.has(fromTemplate[1])) return fromTemplate[1]
  for (const c of LABEL_CANDIDATES) if (names.has(c)) return c
  const text = fields.find(
    (f) => f.field !== 'id' && /^(string|text|varchar|nvarchar)/i.test(f.type ?? '')
  )
  return text?.field ?? (names.has('id') ? 'id' : (fields[0]?.field ?? ''))
}

/** "Workflow › Funding Years" — how a path reads to a person. */
export function pathLabel(path: string[] | undefined): string {
  return (path ?? []).map((p) => titleCase(p)).join(' › ')
}

/** The same cache entry the collection list reads its own metadata from. */
export function useFacetMeta(collection: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<FacetMeta>({
    queryKey: ['cbv-collection-meta', collection],
    queryFn: () =>
      client.request<{ data: FacetMeta }>(get(`/collections/${collection}`)).then((r) => r.data),
    enabled: !!collection,
    staleTime: 10 * 60_000,
    retry: false
  })
}
