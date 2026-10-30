import {
  describeFieldSource,
  type FieldSource,
  type SentenceLabels
} from '../../lib/config-sentences'
import { titleCase } from '../../lib/utils'

/** The columns read from a field row (field-config or GET /collections/:c). */
export interface SourceFieldRow {
  field: string
  label?: string | null
  type?: string | null
  computed_type?: string | null
  computed_formula?: unknown
  computed_store?: boolean | number | null
  cross_record_defaults?: unknown
}

export interface SourceRelationRow {
  one_collection?: string | null
  one_field?: string | null
  many_collection?: string | null
  many_field?: string | null
  junction_field?: string | null
}

/**
 * #10: every derived field's source in words, for the record form's ⓘ.
 * Labels come from the form's own field rows and relations; other
 * collections' columns fall back to title case (nothing is fetched).
 */
export function fieldSourcesFor(
  fields: SourceFieldRow[],
  relations: SourceRelationRow[],
  collection: string
): Record<string, FieldSource> {
  if (!fields.length) return {}
  const labels: SentenceLabels = { fields: {}, types: {}, links: {}, collections: {} }
  for (const f of fields) {
    if (f.label) (labels.fields as Record<string, string>)[f.field] = f.label
    if (f.type) (labels.types as Record<string, string>)[f.field] = f.type
  }
  for (const r of relations) {
    if (r.many_collection === collection && r.many_field && r.one_collection && !r.junction_field)
      (labels.links as Record<string, string>)[r.many_field] = r.one_collection
    // O2M rollups read the child collection; name it by the alias's label.
    if (r.one_collection === collection && r.one_field && r.many_collection) {
      const alias = fields.find((f) => f.field === r.one_field)
      ;(labels.collections as Record<string, string>)[r.many_collection] =
        alias?.label?.trim() || titleCase(r.many_collection)
    }
  }
  const cross = fields
    .filter((f) => f.cross_record_defaults)
    .map((f) => ({ field: f.field, config: f.cross_record_defaults }))
  const out: Record<string, FieldSource> = {}
  for (const f of fields) {
    if (!f.computed_type && !cross.length) continue
    const src = describeFieldSource(
      {
        field: f.field,
        computed_type: f.computed_type,
        computed_formula:
          typeof f.computed_formula === 'string'
            ? f.computed_formula
            : f.computed_formula
              ? JSON.stringify(f.computed_formula)
              : null,
        computed_store: f.computed_store ?? null
      },
      labels,
      cross.filter((c) => c.field !== f.field)
    )
    if (src) out[f.field] = src
  }
  return out
}
